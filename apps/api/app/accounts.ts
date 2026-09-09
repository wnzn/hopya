import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { Effect } from 'effect'
import { z } from 'zod'
import { audit, db, runPromiseThrow } from './database.js'
import { registrationEnabled } from './settings.js'
import { AuthFailure, authenticate, authenticateEffect, createSession, destroySession, hashPassword, hashToken, passwordResetRateLimit, publicUser, rateLimit, verifyPassword } from './security.js'
import { emailSchema, passwordSchema, nextItemUpdatedAt } from './service.js'
import { HttpError, type User, type UserRow } from './types.js'
import { passwordResetEnabled, sendPasswordReset } from './mail.js'

// These preserve the pre-existing public messages at each handler boundary.
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

const credentials = z.object({ name: z.string().trim().min(1).max(120), email: emailSchema, password: passwordSchema }).strict()
const timestamp = () => new Date().toISOString()
const tokenExpiry = () => new Date(Date.now() + 90 * 86400000).toISOString()
type DbUserRow = UserRow & Record<string, unknown>
export const setupRequired = async () => !(await db.get('SELECT id FROM users LIMIT 1'))

// Admin guard chain as a composable Effect: authentication failures stay 401,
// only an authenticated non-admin maps to 403.
export const requireAdminEffect = (ctx: HttpContext): Effect.Effect<User, AuthFailure | AdminDenied> =>
  Effect.gen(function* () {
    const user = yield* authenticateEffect(ctx)
    if (!user.isAdmin) return yield* Effect.fail(new AdminDenied())
    return user
  })

export function requireAdmin(ctx: HttpContext): Promise<User> {
  return runPromiseThrow(requireAdminEffect(ctx).pipe(
    Effect.mapError((failure) => failure instanceof AdminDenied ? new HttpError(403, failure.message) : new HttpError(401, failure.message)),
  ))
}
async function insertUser(data: z.output<typeof credentials>, passwordHash: string, isAdmin: boolean): Promise<UserRow> {
  const user: UserRow = { id: randomUUID(), name: data.name, email: data.email, passwordHash, isAdmin: Number(isAdmin), disabled: 0, createdAt: timestamp() }
  await db.run('INSERT INTO users (id,name,email,passwordHash,isAdmin,disabled,createdAt) VALUES (@id,@name,@email,@passwordHash,@isAdmin,@disabled,@createdAt)', user)
  return user
}

export const accounts = {
  async setup(ctx: HttpContext) {
    rateLimit(ctx, 'setup')
    const data = credentials.extend({ setupToken: z.string().min(1).max(512) }).parse(ctx.request.body())
    const secret = process.env.SETUP_TOKEN
    if (!secret || !timingSafeEqual(Buffer.from(hashToken(data.setupToken), 'hex'), Buffer.from(hashToken(secret), 'hex'))) {
      throw new HttpError(403, new SetupDenied().message)
    }
    if (!(await setupRequired())) throw new HttpError(409, new SetupConflict().message)
    const passwordHash = await hashPassword(data.password)
    const user = await db.transaction(async () => {
      if (!(await setupRequired())) throw new HttpError(409, new SetupConflict().message)
      const created = await insertUser(data, passwordHash, true)
      await audit(created.id, null, 'auth.setup', created.id)
      return created
    })
    await createSession(ctx, user.id)
    ctx.response.status(201)
    return publicUser(user)
  },
  async register(ctx: HttpContext) {
    rateLimit(ctx, 'register')
    if (!registrationEnabled || await setupRequired()) throw new HttpError(403, new RegistrationClosed().message)
    const data = credentials.parse(ctx.request.body())
    const passwordHash = await hashPassword(data.password)
    const user = await db.transaction(async () => {
      const created = await insertUser(data, passwordHash, false)
      await audit(created.id, null, 'auth.register', created.id)
      return created
    })
    await createSession(ctx, user.id)
    ctx.response.status(201)
    return publicUser(user)
  },
  async login(ctx: HttpContext) {
    rateLimit(ctx, 'login')
    const data = z.object({ email: emailSchema, password: z.string().min(1).max(256) }).strict().parse(ctx.request.body())
    const row = await db.get<DbUserRow>('SELECT * FROM users WHERE email=?', data.email)
    const valid = await verifyPassword(data.password, row?.passwordHash ?? null)
    if (!valid || !row || row.disabled) throw new HttpError(401, new InvalidCredentials().message)
    return db.transaction(async () => {
      const current = await db.get<DbUserRow>('SELECT * FROM users WHERE id=? AND disabled=0 AND passwordHash=?', row.id, row.passwordHash)
      if (!current) throw new HttpError(401, new InvalidCredentials().message)
      await createSession(ctx, row.id)
      await audit(row.id, null, 'auth.login', row.id)
      return publicUser(current)
    })
  },
  async logout(ctx: HttpContext) {
    const user = await authenticate(ctx)
    await db.transaction(async () => {
      await destroySession(ctx)
      await audit(user.id, null, 'auth.logout', user.id)
    })
    return { success: true }
  },
  async profile(ctx: HttpContext) {
    const user = await authenticate(ctx)
    const data = z.object({ name: z.string().trim().min(1).max(120), email: emailSchema.optional(), password: passwordSchema.optional(), currentPassword: z.string().min(1).max(256).optional() }).strict().parse(ctx.request.body())
    const row = (await db.get<DbUserRow>('SELECT * FROM users WHERE id=?', user.id))!
    const email = data.email ?? row.email
    const emailChanged = email !== row.email
    let passwordHash: string | undefined
    if (data.password !== undefined || emailChanged) {
      rateLimit(ctx, 'password')
      // Verification and hashing stay sequential awaits (scrypt runs off the
      // event loop), so concurrent credential withdrawal is still detected by
      // the rechecks inside the transaction below.
      const valid = await verifyPassword(data.currentPassword ?? '', row.passwordHash)
      if (!data.currentPassword || !valid) throw new HttpError(403, new CurrentPasswordMismatch().message)
      passwordHash = data.password === undefined ? row.passwordHash! : await hashPassword(data.password)
    } else if (data.currentPassword !== undefined) throw new HttpError(400, 'New password is required')
    return db.transaction(async () => {
      await authenticate(ctx)
      const current = await db.get<DbUserRow>('SELECT * FROM users WHERE id=? AND disabled=0', user.id)
      if (!current || current.passwordHash !== row.passwordHash) throw new HttpError(409, new StaleAccount().message)
      if (emailChanged && await db.get('SELECT id FROM users WHERE email=? AND id<>?', email, user.id)) throw new HttpError(409, 'Email address is already in use')
      await db.run('UPDATE users SET name=?,email=?,passwordHash=? WHERE id=?', data.name, email, passwordHash ?? row.passwordHash, user.id)
      if (data.password !== undefined || emailChanged) {
        await db.run('DELETE FROM sessions WHERE userId=?', user.id)
        await db.run('DELETE FROM tokens WHERE userId=?', user.id)
        await db.run('DELETE FROM password_reset_tokens WHERE userId=?', user.id)
        await createSession(ctx, user.id)
      }
      await audit(user.id, null, 'user.profile', user.id, { passwordChanged: data.password !== undefined, emailChanged })
      return publicUser({ ...current, name: data.name, email })
    })
  },
  async forgotPassword(ctx: HttpContext) {
    const data = z.object({ email: emailSchema }).strict().parse(ctx.request.body())
    passwordResetRateLimit(ctx, data.email)
    if (passwordResetEnabled()) {
      const user = await db.get<DbUserRow>('SELECT * FROM users WHERE email=? AND disabled=0 AND passwordHash IS NOT NULL', data.email)
      if (user) {
        const token = randomBytes(32).toString('base64url')
        const createdAt = timestamp()
        await db.transaction(async () => {
          await db.run('DELETE FROM password_reset_tokens WHERE expiresAt<=? OR userId=?', createdAt, user.id)
          await db.run(
            'INSERT INTO password_reset_tokens(id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)',
            randomUUID(), user.id, hashToken(token), new Date(Date.now() + 30 * 60 * 1000).toISOString(), createdAt,
          )
          await audit(user.id, null, 'auth.password.reset.request', user.id)
        })
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
    const initial = await db.get<{ userId: string; passwordHash: string }>(`SELECT r.userId,u.passwordHash FROM password_reset_tokens r JOIN users u ON u.id=r.userId
      WHERE r.tokenHash=? AND r.expiresAt>? AND u.disabled=0 AND u.passwordHash IS NOT NULL`, tokenHash, timestamp())
    const passwordHash = await hashPassword(data.password)
    if (!initial) throw new HttpError(400, new InvalidReset().message)
    await db.transaction(async () => {
      const current = await db.get<{ userId: string }>(`SELECT r.userId,u.passwordHash FROM password_reset_tokens r JOIN users u ON u.id=r.userId
        WHERE r.tokenHash=? AND r.expiresAt>? AND u.disabled=0 AND u.passwordHash=?`, tokenHash, timestamp(), initial.passwordHash)
      if (!current) throw new HttpError(400, new InvalidReset().message)
      await db.run('UPDATE users SET passwordHash=? WHERE id=?', passwordHash, current.userId)
      await db.run('DELETE FROM password_reset_tokens WHERE userId=?', current.userId)
      const revokedSessions = (await db.run('DELETE FROM sessions WHERE userId=?', current.userId)).changes
      const revokedTokens = (await db.run('DELETE FROM tokens WHERE userId=?', current.userId)).changes
      await audit(current.userId, null, 'auth.password.reset', current.userId, { revokedSessions, revokedTokens })
    })
    await destroySession(ctx)
    return { success: true }
  },
  async listTokens(ctx: HttpContext) {
    const user = await authenticate(ctx)
    return db.all('SELECT id,name,createdAt,expiresAt FROM tokens WHERE userId=? ORDER BY createdAt DESC,id', user.id)
  },
  async createToken(ctx: HttpContext) {
    const user = await authenticate(ctx)
    const data = z.object({ name: z.string().trim().min(1).max(120) }).strict().parse(ctx.request.body())
    const token = randomBytes(32).toString('base64url')
    await db.transaction(async () => {
      await db.run('DELETE FROM tokens WHERE userId=? AND expiresAt<=?', user.id, timestamp())
      if ((await db.get<{ count: number }>('SELECT count(*) AS count FROM tokens WHERE userId=?', user.id))!.count >= 50) {
        throw new HttpError(409, new TokenLimit().message)
      }
      const tokenId = randomUUID()
      await db.run('INSERT INTO tokens (id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)', tokenId, user.id, data.name, hashToken(token), tokenExpiry(), timestamp())
      await audit(user.id, null, 'token.create', tokenId)
    })
    ctx.response.status(201)
    return { token }
  },
  async deleteToken(ctx: HttpContext) {
    const user = await authenticate(ctx)
    return db.transaction(async () => {
      const result = await db.run('DELETE FROM tokens WHERE userId=? AND id=?', user.id, ctx.params.id)
      if (!result.changes) throw new HttpError(404, new TokenNotFound().message)
      await audit(user.id, null, 'token.revoke', ctx.params.id)
      return { success: true }
    })
  },
  async listUsers(ctx: HttpContext) {
    await requireAdmin(ctx)
    return (await db.all<DbUserRow>('SELECT id,name,email,isAdmin,disabled,createdAt FROM users ORDER BY createdAt,id'))
      .map((user) => ({ ...publicUser(user), disabled: Boolean(user.disabled), createdAt: user.createdAt }))
  },
  async createUser(ctx: HttpContext) {
    const admin = await requireAdmin(ctx)
    rateLimit(ctx, 'admin-create')
    const data = credentials.extend({ isAdmin: z.boolean().default(false) }).parse(ctx.request.body())
    const passwordHash = await hashPassword(data.password)
    const user = await db.transaction(async () => {
      await requireAdmin(ctx)
      const created = await insertUser(data, passwordHash, data.isAdmin)
      await audit(admin.id, null, 'admin.user.create', created.id, { isAdmin: data.isAdmin })
      return created
    })
    ctx.response.status(201)
    return { ...publicUser(user), disabled: false, createdAt: user.createdAt }
  },
  async updateUser(ctx: HttpContext) {
    const admin = await requireAdmin(ctx)
    const data = z.object({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional() }).strict().refine((data) => Object.keys(data).length > 0, 'At least one change is required').parse(ctx.request.body())
    return db.transaction(async () => {
      const row = await db.get<DbUserRow>('SELECT * FROM users WHERE id=?', ctx.params.id)
      if (!row) throw new HttpError(404, new UserNotFound().message)
      const isAdmin = data.isAdmin ?? Boolean(row.isAdmin)
      const disabled = data.disabled ?? Boolean(row.disabled)
      if (row.isAdmin && !row.disabled && (!isAdmin || disabled)) {
        const { count } = (await db.get<{ count: number }>('SELECT count(*) AS count FROM users WHERE isAdmin=1 AND disabled=0'))!
        if (count <= 1) throw new HttpError(409, new LastAdminRetained().message)
      }
      const details: Record<string, unknown> = { ...data }
      if (disabled) {
        // Suspension overrides workspace ownership; retain memberships for account recovery.
        const assigned = await db.all<{ id: string; workspaceId: string; updatedAt: string }>('SELECT id,workspaceId,updatedAt FROM items WHERE assigneeId=?', row.id)
        for (const item of assigned) await db.run('UPDATE items SET assigneeId=NULL,updatedAt=? WHERE workspaceId=? AND id=?', nextItemUpdatedAt(item.updatedAt), item.workspaceId, item.id)
        details.clearedAssignments = assigned.length
        details.affectedWorkspaces = new Set(assigned.map((item) => item.workspaceId)).size
        details.revokedSessions = (await db.run('DELETE FROM sessions WHERE userId=?', row.id)).changes
        details.revokedTokens = (await db.run('DELETE FROM tokens WHERE userId=?', row.id)).changes
      }
      await db.run('UPDATE users SET isAdmin=?,disabled=? WHERE id=?', Number(isAdmin), Number(disabled), row.id)
      await audit(admin.id, null, 'admin.user.update', row.id, details)
      return { ...publicUser({ ...row, isAdmin: Number(isAdmin) }), disabled, createdAt: row.createdAt }
    })
  },
  async listAudit(ctx: HttpContext) {
    await requireAdmin(ctx)
    const data = z.object({ workspaceId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict().parse(ctx.request.qs())
    const rows = data.workspaceId
      ? await db.all<Record<string, unknown> & { details: string }>('SELECT * FROM audit_logs WHERE workspaceId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?', data.workspaceId, data.limit, data.offset)
      : await db.all<Record<string, unknown> & { details: string }>('SELECT * FROM audit_logs ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?', data.limit, data.offset)
    return rows.map((row) => ({ ...row, details: JSON.parse(row.details) }))
  },
  async status(ctx: HttpContext) {
    await requireAdmin(ctx)
    return {
      database: 'sqlite', status: 'ok',
      users: (await db.get<{ count: number }>('SELECT count(*) AS count FROM users'))!.count,
      workspaces: (await db.get<{ count: number }>('SELECT count(*) AS count FROM workspaces'))!.count,
      items: (await db.get<{ count: number }>('SELECT count(*) AS count FROM items'))!.count,
      migrations: await db.all('SELECT name,migration_time AS appliedAt FROM adonis_schema ORDER BY name'),
      storageDriver: process.env.STORAGE_DRIVER || 'filesystem',
      pendingStorageCleanup: (await db.get<{ count: number }>('SELECT count(*) AS count FROM storage_objects o WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.objectKey=o.objectKey)'))!.count,
      aiEnabled: Boolean(process.env.AI_PROVIDER), ssoEnabled: Boolean(process.env.OIDC_ISSUER),
    }
  },
}
