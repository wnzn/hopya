import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { Effect } from 'effect'
import { z } from 'zod'
import { db, auditEffect, runPromiseThrow, runSyncThrow } from './database.js'
import { registrationEnabled } from './settings.js'
import { AuthFailure, authenticate, authenticateEffect, createSession, destroySession, hashPassword, hashToken, passwordResetRateLimit, publicUser, rateLimit, verifyPassword } from './security.js'
import { emailSchema, passwordSchema, nextItemUpdatedAt } from './service.js'
import { HttpError, type User, type UserRow } from './types.js'
import { passwordResetEnabled, sendPasswordReset } from './mail.js'

// Typed account failures, kept as values inside Effect pipelines and mapped
// to the pre-existing HttpError codes/messages at each handler boundary, so
// responses, status codes and audit action names are unchanged. Driver errors
// from synchronous reads/writes stay defects and propagate (and roll back)
// exactly as before.
class SetupDenied { readonly _tag = 'SetupDenied'; readonly message = 'Setup not authorized' }
class SetupConflict { readonly _tag = 'SetupConflict'; readonly message = 'Setup already completed' }
class RegistrationClosed { readonly _tag = 'RegistrationClosed'; readonly message = 'Registration is closed' }
class InvalidCredentials { readonly _tag = 'InvalidCredentials'; readonly message = 'Invalid email or password' }
class CurrentPasswordMismatch { readonly _tag = 'CurrentPasswordMismatch'; readonly message = 'Current password is incorrect' }
class StaleAccount { readonly _tag = 'StaleAccount'; readonly message = 'Account changed; sign in again' }
class TokenLimit { readonly _tag = 'TokenLimit'; readonly message = 'Maximum 50 active tokens per account' }
class TokenNotFound { readonly _tag = 'TokenNotFound'; readonly message = 'Token not found' }
class AdminDenied { readonly _tag = 'AdminDenied'; readonly message = 'Site administrator required' }
class UserNotFound { readonly _tag = 'UserNotFound'; readonly message = 'User not found' }
class LastAdminRetained { readonly _tag = 'LastAdminRetained'; readonly message = 'Site must retain an active administrator' }
class InvalidReset { readonly _tag = 'InvalidReset'; readonly message = 'Password reset link is invalid or expired' }

// Audit writes join the surrounding pipelines as Effects; a storage failure
// escalates as a defect so the enclosing db.transaction() rolls back with the
// original driver error (see the suspension rollback regression test).
const auditOrDie = (actorId: string | null, workspaceId: string | null, action: string, resourceId: string | null, details: Record<string, unknown> = {}) =>
  auditEffect(actorId, workspaceId, action, resourceId, details).pipe(
    Effect.catchAll((failure) => Effect.die(failure.cause ?? failure)),
  )

const credentials = z.object({ name: z.string().trim().min(1).max(120), email: emailSchema, password: passwordSchema }).strict()
const timestamp = () => new Date().toISOString()
const tokenExpiry = () => new Date(Date.now() + 90 * 86400000).toISOString()
export const setupRequired = () => !(db.prepare('SELECT id FROM users LIMIT 1').get())

// Admin guard chain as a composable Effect: authentication failures stay 401,
// only an authenticated non-admin maps to 403.
export const requireAdminEffect = (ctx: HttpContext): Effect.Effect<User, AuthFailure | AdminDenied> =>
  Effect.gen(function* () {
    const user = yield* authenticateEffect(ctx)
    if (!user.isAdmin) return yield* Effect.fail(new AdminDenied())
    return user
  })

export function requireAdmin(ctx: HttpContext): User {
  return runSyncThrow(requireAdminEffect(ctx).pipe(
    Effect.mapError((failure) => failure instanceof AdminDenied ? new HttpError(403, failure.message) : new HttpError(401, failure.message)),
  ))
}
function insertUser(data: z.output<typeof credentials>, passwordHash: string, isAdmin: boolean): UserRow {
  const user: UserRow = { id: randomUUID(), name: data.name, email: data.email, passwordHash, isAdmin: Number(isAdmin), disabled: 0, createdAt: timestamp() }
  db.prepare('INSERT INTO users (id,name,email,passwordHash,isAdmin,disabled,createdAt) VALUES (@id,@name,@email,@passwordHash,@isAdmin,@disabled,@createdAt)').run(user)
  return user
}

export const accounts = {
  async setup(ctx: HttpContext) {
    rateLimit(ctx, 'setup')
    const data = credentials.extend({ setupToken: z.string().min(1).max(512) }).parse(ctx.request.body())
    const secret = process.env.SETUP_TOKEN
    runSyncThrow(Effect.gen(function* () {
      if (!secret || !timingSafeEqual(Buffer.from(hashToken(data.setupToken), 'hex'), Buffer.from(hashToken(secret), 'hex'))) {
        return yield* Effect.fail(new SetupDenied())
      }
      if (!setupRequired()) return yield* Effect.fail(new SetupConflict())
    }).pipe(Effect.mapError((failure) => failure instanceof SetupDenied ? new HttpError(403, failure.message) : new HttpError(409, failure.message))))
    const passwordHash = await hashPassword(data.password)
    const user = db.transaction(() => runSyncThrow(Effect.gen(function* () {
      if (!setupRequired()) return yield* Effect.fail(new SetupConflict())
      const created = insertUser(data, passwordHash, true)
      yield* auditOrDie(created.id, null, 'auth.setup', created.id)
      return created
    }).pipe(Effect.mapError((failure) => new HttpError(409, failure.message)))))()
    createSession(ctx, user.id)
    ctx.response.status(201)
    return publicUser(user)
  },
  async register(ctx: HttpContext) {
    rateLimit(ctx, 'register')
    runSyncThrow(Effect.gen(function* () {
      if (!registrationEnabled || setupRequired()) return yield* Effect.fail(new RegistrationClosed())
    }).pipe(Effect.mapError((failure) => new HttpError(403, failure.message))))
    const data = credentials.parse(ctx.request.body())
    const passwordHash = await hashPassword(data.password)
    const user = db.transaction(() => runSyncThrow(Effect.gen(function* () {
      const created = insertUser(data, passwordHash, false)
      yield* auditOrDie(created.id, null, 'auth.register', created.id)
      return created
    })))()
    createSession(ctx, user.id)
    ctx.response.status(201)
    return publicUser(user)
  },
  async login(ctx: HttpContext) {
    rateLimit(ctx, 'login')
    const data = z.object({ email: emailSchema, password: z.string().min(1).max(256) }).strict().parse(ctx.request.body())
    // Credential verification plus session issuance as one pipeline: the
    // generic failure keeps email-existence, password, disabled-state and
    // recheck outcomes indistinguishable, exactly as before.
    return runPromiseThrow(Effect.gen(function* () {
      const row = db.prepare('SELECT * FROM users WHERE email=?').get(data.email) as UserRow | undefined
      const valid = yield* Effect.promise(() => verifyPassword(data.password, row?.passwordHash ?? null))
      if (!valid || !row || row.disabled) return yield* Effect.fail(new InvalidCredentials())
      const current = db.prepare('SELECT * FROM users WHERE id=? AND disabled=0 AND passwordHash=?').get(row.id, row.passwordHash) as UserRow | undefined
      if (!current) return yield* Effect.fail(new InvalidCredentials())
      yield* Effect.sync(() => {
        db.transaction(() => { createSession(ctx, row.id); runSyncThrow(auditOrDie(row.id, null, 'auth.login', row.id)) })()
      })
      return publicUser(current)
    }).pipe(Effect.mapError((failure) => new HttpError(401, failure.message))))
  },
  logout(ctx: HttpContext) {
    const user = authenticate(ctx)
    db.transaction(() => runSyncThrow(Effect.gen(function* () {
      yield* Effect.sync(() => { destroySession(ctx) })
      yield* auditOrDie(user.id, null, 'auth.logout', user.id)
    })))()
    return { success: true }
  },
  async profile(ctx: HttpContext) {
    const user = authenticate(ctx)
    const data = z.object({ name: z.string().trim().min(1).max(120), email: emailSchema.optional(), password: passwordSchema.optional(), currentPassword: z.string().min(1).max(256).optional() }).strict().parse(ctx.request.body())
    const row = db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as UserRow
    const email = data.email ?? row.email
    const emailChanged = email !== row.email
    let passwordHash: string | undefined
    if (data.password !== undefined || emailChanged) {
      rateLimit(ctx, 'password')
      // Verification and hashing stay sequential awaits (scrypt runs off the
      // event loop), so concurrent credential withdrawal is still detected by
      // the rechecks inside the transaction below.
      passwordHash = await runPromiseThrow(Effect.gen(function* () {
        const valid = yield* Effect.promise(() => verifyPassword(data.currentPassword ?? '', row.passwordHash))
        if (!data.currentPassword || !valid) return yield* Effect.fail(new CurrentPasswordMismatch())
        return data.password === undefined ? row.passwordHash! : yield* Effect.promise(() => hashPassword(data.password as string))
      }).pipe(Effect.mapError((failure) => new HttpError(403, failure.message))))
    } else if (data.currentPassword !== undefined) throw new HttpError(400, 'New password is required')
    return db.transaction(() => runSyncThrow(Effect.gen(function* () {
      authenticate(ctx)
      const current = db.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(user.id) as UserRow | undefined
      if (!current || current.passwordHash !== row.passwordHash) return yield* Effect.fail(new StaleAccount())
      if (emailChanged && db.prepare('SELECT id FROM users WHERE email=? AND id<>?').get(email, user.id)) throw new HttpError(409, 'Email address is already in use')
      db.prepare('UPDATE users SET name=?,email=?,passwordHash=? WHERE id=?').run(data.name, email, passwordHash ?? row.passwordHash, user.id)
      if (data.password !== undefined || emailChanged) {
        db.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)
        db.prepare('DELETE FROM tokens WHERE userId=?').run(user.id)
        db.prepare('DELETE FROM password_reset_tokens WHERE userId=?').run(user.id)
        createSession(ctx, user.id)
      }
      yield* auditOrDie(user.id, null, 'user.profile', user.id, { passwordChanged: data.password !== undefined, emailChanged })
      return publicUser({ ...current, name: data.name, email })
    }).pipe(Effect.mapError((failure) => new HttpError(409, failure.message)))))()
  },
  forgotPassword(ctx: HttpContext) {
    const data = z.object({ email: emailSchema }).strict().parse(ctx.request.body())
    passwordResetRateLimit(ctx, data.email)
    if (passwordResetEnabled()) {
      const user = db.prepare('SELECT * FROM users WHERE email=? AND disabled=0 AND passwordHash IS NOT NULL').get(data.email) as UserRow | undefined
      if (user) {
        const token = randomBytes(32).toString('base64url')
        const createdAt = timestamp()
        db.transaction(() => {
          db.prepare('DELETE FROM password_reset_tokens WHERE expiresAt<=? OR userId=?').run(createdAt, user.id)
          db.prepare('INSERT INTO password_reset_tokens(id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)')
            .run(randomUUID(), user.id, hashToken(token), new Date(Date.now() + 30 * 60 * 1000).toISOString(), createdAt)
          runSyncThrow(auditOrDie(user.id, null, 'auth.password.reset.request', user.id))
        }).immediate()
        setImmediate(() => { void sendPasswordReset(user.email, token).catch(() => console.error('[hopya] Password reset email delivery failed')) })
      }
    }
    ctx.response.status(202)
    return { message: 'If an eligible account exists, password reset instructions will be sent.' }
  },
  async resetPassword(ctx: HttpContext) {
    rateLimit(ctx, 'password-reset-confirm')
    const data = z.object({ token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/), password: passwordSchema }).strict().parse(ctx.request.body())
    const tokenHash = hashToken(data.token)
    const initial = db.prepare(`SELECT r.userId,u.passwordHash FROM password_reset_tokens r JOIN users u ON u.id=r.userId
      WHERE r.tokenHash=? AND r.expiresAt>? AND u.disabled=0 AND u.passwordHash IS NOT NULL`).get(tokenHash, timestamp()) as { userId: string; passwordHash: string } | undefined
    const passwordHash = await hashPassword(data.password)
    if (!initial) throw new HttpError(400, new InvalidReset().message)
    db.transaction(() => runSyncThrow(Effect.gen(function* () {
      const current = db.prepare(`SELECT r.userId,u.passwordHash FROM password_reset_tokens r JOIN users u ON u.id=r.userId
        WHERE r.tokenHash=? AND r.expiresAt>? AND u.disabled=0 AND u.passwordHash=?`).get(tokenHash, timestamp(), initial.passwordHash) as { userId: string } | undefined
      if (!current) return yield* Effect.fail(new InvalidReset())
      db.prepare('UPDATE users SET passwordHash=? WHERE id=?').run(passwordHash, current.userId)
      db.prepare('DELETE FROM password_reset_tokens WHERE userId=?').run(current.userId)
      const revokedSessions = db.prepare('DELETE FROM sessions WHERE userId=?').run(current.userId).changes
      const revokedTokens = db.prepare('DELETE FROM tokens WHERE userId=?').run(current.userId).changes
      yield* auditOrDie(current.userId, null, 'auth.password.reset', current.userId, { revokedSessions, revokedTokens })
    }).pipe(Effect.mapError((failure) => new HttpError(400, failure.message))))).immediate()
    destroySession(ctx)
    return { success: true }
  },
  listTokens(ctx: HttpContext) {
    const user = authenticate(ctx)
    return db.prepare('SELECT id,name,createdAt,expiresAt FROM tokens WHERE userId=? ORDER BY createdAt DESC,id').all(user.id)
  },
  createToken(ctx: HttpContext) {
    const user = authenticate(ctx)
    const data = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(ctx.request.body())
    const token = randomBytes(32).toString('base64url')
    db.transaction(() => runSyncThrow(Effect.gen(function* () {
      db.prepare('DELETE FROM tokens WHERE userId=? AND expiresAt<=?').run(user.id, timestamp())
      if ((db.prepare('SELECT count(*) AS count FROM tokens WHERE userId=?').get(user.id) as { count: number }).count >= 50) {
        return yield* Effect.fail(new TokenLimit())
      }
      const tokenId = randomUUID()
      db.prepare('INSERT INTO tokens (id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)')
        .run(tokenId, user.id, data.name, hashToken(token), tokenExpiry(), timestamp())
      yield* auditOrDie(user.id, null, 'token.create', tokenId)
    }).pipe(Effect.mapError((failure) => new HttpError(409, failure.message)))))()
    ctx.response.status(201)
    return { token }
  },
  deleteToken(ctx: HttpContext) {
    const user = authenticate(ctx)
    return db.transaction(() => runSyncThrow(Effect.gen(function* () {
      const result = db.prepare('DELETE FROM tokens WHERE userId=? AND id=?').run(user.id, ctx.params.id)
      if (!result.changes) return yield* Effect.fail(new TokenNotFound())
      yield* auditOrDie(user.id, null, 'token.revoke', ctx.params.id)
      return { success: true }
    }).pipe(Effect.mapError((failure) => new HttpError(404, failure.message)))))()
  },
  listUsers(ctx: HttpContext) {
    requireAdmin(ctx)
    return (db.prepare('SELECT id,name,email,isAdmin,disabled,createdAt FROM users ORDER BY createdAt,id').all() as UserRow[])
      .map((user) => ({ ...publicUser(user), disabled: Boolean(user.disabled), createdAt: user.createdAt }))
  },
  async createUser(ctx: HttpContext) {
    const admin = requireAdmin(ctx)
    rateLimit(ctx, 'admin-create')
    const data = credentials.extend({ isAdmin: z.boolean().default(false) }).parse(ctx.request.body())
    const passwordHash = await hashPassword(data.password)
    const user = db.transaction(() => runSyncThrow(Effect.gen(function* () {
      requireAdmin(ctx)
      const created = insertUser(data, passwordHash, data.isAdmin)
      yield* auditOrDie(admin.id, null, 'admin.user.create', created.id, { isAdmin: data.isAdmin })
      return created
    })))()
    ctx.response.status(201)
    return { ...publicUser(user), disabled: false, createdAt: user.createdAt }
  },
  updateUser(ctx: HttpContext) {
    const admin = requireAdmin(ctx)
    const data = z.object({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional() }).strict().refine((data) => Object.keys(data).length > 0, 'At least one change is required').parse(ctx.request.body())
    return db.transaction(() => runSyncThrow(Effect.gen(function* () {
      const row = db.prepare('SELECT * FROM users WHERE id=?').get(ctx.params.id) as UserRow | undefined
      if (!row) return yield* Effect.fail(new UserNotFound())
      const isAdmin = data.isAdmin ?? Boolean(row.isAdmin)
      const disabled = data.disabled ?? Boolean(row.disabled)
      if (row.isAdmin && !row.disabled && (!isAdmin || disabled)) {
        const { count } = db.prepare('SELECT count(*) AS count FROM users WHERE isAdmin=1 AND disabled=0').get() as { count: number }
        if (count <= 1) return yield* Effect.fail(new LastAdminRetained())
      }
      const details: Record<string, unknown> = { ...data }
      if (disabled) {
        // Suspension overrides workspace ownership; retain memberships for account recovery.
        const assigned = db.prepare('SELECT id,workspaceId,updatedAt FROM items WHERE assigneeId=?').all(row.id) as { id: string; workspaceId: string; updatedAt: string }[]
        const clear = db.prepare('UPDATE items SET assigneeId=NULL,updatedAt=? WHERE workspaceId=? AND id=?')
        for (const item of assigned) clear.run(nextItemUpdatedAt(item.updatedAt), item.workspaceId, item.id)
        details.clearedAssignments = assigned.length
        details.affectedWorkspaces = new Set(assigned.map((item) => item.workspaceId)).size
        details.revokedSessions = db.prepare('DELETE FROM sessions WHERE userId=?').run(row.id).changes
        details.revokedTokens = db.prepare('DELETE FROM tokens WHERE userId=?').run(row.id).changes
      }
      db.prepare('UPDATE users SET isAdmin=?,disabled=? WHERE id=?').run(Number(isAdmin), Number(disabled), row.id)
      yield* auditOrDie(admin.id, null, 'admin.user.update', row.id, details)
      return { ...publicUser({ ...row, isAdmin: Number(isAdmin) }), disabled, createdAt: row.createdAt }
    }).pipe(Effect.mapError((failure) => failure instanceof UserNotFound ? new HttpError(404, failure.message) : new HttpError(409, failure.message)))))()
  },
  listAudit(ctx: HttpContext) {
    requireAdmin(ctx)
    const data = z.object({ workspaceId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict().parse(ctx.request.qs())
    const rows = data.workspaceId
      ? db.prepare('SELECT * FROM audit_logs WHERE workspaceId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?').all(data.workspaceId, data.limit, data.offset)
      : db.prepare('SELECT * FROM audit_logs ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?').all(data.limit, data.offset)
    return (rows as Array<Record<string, unknown> & { details: string }>).map((row) => ({ ...row, details: JSON.parse(row.details) }))
  },
  status(ctx: HttpContext) {
    requireAdmin(ctx)
    return {
      database: 'sqlite', status: 'ok',
      users: (db.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count,
      workspaces: (db.prepare('SELECT count(*) AS count FROM workspaces').get() as { count: number }).count,
      items: (db.prepare('SELECT count(*) AS count FROM items').get() as { count: number }).count,
      migrations: db.prepare('SELECT name,appliedAt FROM schema_migrations ORDER BY name').all(),
      storageDriver: process.env.STORAGE_DRIVER || 'filesystem',
      pendingStorageCleanup: (db.prepare('SELECT count(*) AS count FROM storage_objects o WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.objectKey=o.objectKey)').get() as { count: number }).count,
      aiEnabled: Boolean(process.env.AI_PROVIDER), ssoEnabled: Boolean(process.env.OIDC_ISSUER),
    }
  },
}
