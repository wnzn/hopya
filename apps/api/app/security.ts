import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { Effect } from 'effect'
import { db, runPromiseThrow, runSyncThrow } from './database.js'
import { appUrl, sessionSeconds } from './settings.js'
import { HttpError, type User, type UserRow } from './types.js'

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export function publicUser(user: User | UserRow): User {
  return { id: user.id, name: user.name, email: user.email, isAdmin: Boolean(user.isAdmin) }
}

// Typed failures for the auth/session/rate-limit layer. Each maps to a
// pre-existing HttpError code at the public boundary below, so handlers,
// status codes and messages are unchanged.
export class AuthFailure {
  readonly _tag = 'AuthFailure'
  constructor(readonly message: string = 'Authentication required') {}
}
export class OriginFailure {
  readonly _tag = 'OriginFailure'
  constructor(readonly message: string) {}
}
export class RateLimitFailure {
  readonly _tag = 'RateLimitFailure'
  constructor(readonly message: string, readonly retryAfter: string) {}
}
class PasswordFailure {
  readonly _tag = 'PasswordFailure'
  constructor(readonly message: string, readonly cause?: unknown) {}
}

const nowIso = () => new Date().toISOString()
type DbUserRow = UserRow & Record<string, unknown>

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)))
}

const deriveEffect = (password: string, salt: string): Effect.Effect<Buffer, PasswordFailure> =>
  Effect.tryPromise({
    try: () => derive(password, salt),
    catch: (cause) => new PasswordFailure('Password operation failed', cause),
  })

export async function hashPassword(password: string): Promise<string> {
  const effect = Effect.gen(function* () {
    const salt = randomBytes(16).toString('hex')
    const key = yield* deriveEffect(password, salt)
    return `scrypt$32768$8$1$${salt}$${key.toString('hex')}`
  })
  try {
    return await runPromiseThrow(effect)
  } catch (error) {
    // Scrypt system errors propagate unchanged; only the typed wrapper is unwrapped.
    if (error instanceof PasswordFailure && error.cause !== undefined) throw error.cause
    throw error
  }
}

const decodePasswordHash = (encoded: string | null) => {
  const parts = encoded?.split('$')
  const valid = parts?.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$1' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{128}$/.test(parts[5])
  return { valid: Boolean(valid), salt: valid ? parts![4] : '00000000000000000000000000000000', expected: valid ? parts![5] : '0'.repeat(128) }
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const effect = Effect.gen(function* () {
    const { valid, salt, expected } = decodePasswordHash(encoded)
    const actual = yield* deriveEffect(password, salt)
    return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && valid
  })
  try {
    return await runPromiseThrow(effect)
  } catch (error) {
    if (error instanceof PasswordFailure && error.cause !== undefined) throw error.cause
    throw error
  }
}

const bearerPattern = /^Bearer [A-Za-z0-9_-]{32,256}$/

// Authenticate as a composable Effect: DB errors stay defects
// (driver errors propagate unchanged), while missing/invalid credentials are
// typed AuthFailure values mapped to 401 at the boundary.
export const authenticateEffect = (ctx: HttpContext): Effect.Effect<User, AuthFailure> =>
  Effect.gen(function* () {
    const authorization = ctx.request.header('authorization')
    let row: UserRow | undefined
    if (authorization !== undefined) {
      if (!bearerPattern.test(authorization)) return yield* Effect.fail(new AuthFailure())
      row = yield* Effect.promise(() => db.get<DbUserRow>(
        'SELECT u.* FROM users u JOIN tokens t ON t.userId=u.id WHERE t.tokenHash=? AND t.expiresAt>? AND u.disabled=0',
        hashToken(authorization.slice(7)), nowIso(),
      ))
    } else {
      const token: unknown = ctx.request.cookie('hopya_session')
      if (typeof token === 'string' && token.length <= 256) {
        row = yield* Effect.promise(() => db.get<DbUserRow>(
          'SELECT u.* FROM users u JOIN sessions s ON s.userId=u.id WHERE s.tokenHash=? AND s.expiresAt>? AND u.disabled=0',
          hashToken(token), nowIso(),
        ))
      }
    }
    if (!row) return yield* Effect.fail(new AuthFailure())
    return publicUser(row)
  })

export function authenticate(ctx: HttpContext): Promise<User> {
  return runPromiseThrow(authenticateEffect(ctx).pipe(
    Effect.mapError((failure) => new HttpError(401, failure.message)),
  ))
}

export const checkOriginEffect = (ctx: HttpContext): Effect.Effect<void, OriginFailure | AuthFailure> =>
  Effect.gen(function* () {
    if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.request.method())) return
    const origin = ctx.request.header('origin')
    // A browser-supplied Origin is always checked, even when it also supplies a bearer.
    if (origin !== undefined) {
      if (origin !== appUrl.origin) return yield* Effect.fail(new OriginFailure('Origin not allowed'))
      return
    }
    if (bearerPattern.test(ctx.request.header('authorization') || '') && !ctx.request.header('cookie')) {
      yield* authenticateEffect(ctx)
      return
    }
    return yield* Effect.fail(new OriginFailure('A matching Origin header is required'))
  })

export function checkOrigin(ctx: HttpContext): Promise<void> {
  return runPromiseThrow(checkOriginEffect(ctx).pipe(
    Effect.mapError((failure) => failure instanceof AuthFailure ? new HttpError(401, failure.message) : new HttpError(403, failure.message)),
  ))
}

export const createSessionEffect = (ctx: HttpContext, userId: string): Effect.Effect<string, AuthFailure> =>
  Effect.gen(function* () {
    const account = yield* Effect.promise(() => db.get('SELECT id FROM users WHERE id=? AND disabled=0', userId))
    if (!account) return yield* Effect.fail(new AuthFailure('Account unavailable'))
    const token = randomBytes(32).toString('base64url')
    yield* Effect.promise(() =>
      db.transaction(async () => {
        const previous: unknown = ctx.request.cookie('hopya_session')
        if (typeof previous === 'string') await db.run('DELETE FROM sessions WHERE tokenHash=?', hashToken(previous))
        await db.run('DELETE FROM sessions WHERE expiresAt<=?', nowIso())
        await db.run(
          'INSERT INTO sessions (id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)',
          randomUUID(), userId, hashToken(token), new Date(Date.now() + sessionSeconds * 1000).toISOString(), nowIso(),
        )
        await db.run(
          'DELETE FROM sessions WHERE userId=? AND id NOT IN (SELECT id FROM sessions WHERE userId=? ORDER BY createdAt DESC LIMIT 20)',
          userId, userId,
        )
      }),
    )
    return token
  })

export async function createSession(ctx: HttpContext, userId: string): Promise<void> {
  const token = await runPromiseThrow(createSessionEffect(ctx, userId).pipe(
    Effect.mapError((failure) => new HttpError(401, failure.message)),
  ))
  ctx.response.cookie('hopya_session', token, { httpOnly: true, sameSite: 'lax', secure: appUrl.protocol === 'https:', path: '/', maxAge: sessionSeconds })
}

export const destroySessionEffect = (ctx: HttpContext): Effect.Effect<void> =>
  Effect.promise(async () => {
    const token: unknown = ctx.request.cookie('hopya_session')
    if (typeof token === 'string') await db.run('DELETE FROM sessions WHERE tokenHash=?', hashToken(token))
  })

export async function destroySession(ctx: HttpContext): Promise<void> {
  await runPromiseThrow(destroySessionEffect(ctx))
  ctx.response.clearCookie('hopya_session', { path: '/', httpOnly: true, sameSite: 'lax', secure: appUrl.protocol === 'https:' })
}

type AttemptWindow = { count: number; until: number; accounts?: Map<string, number> }
const attempts = new Map<string, AttemptWindow>()
const loginAttempts = new Map<string, AttemptWindow>()
const passwordResetEmails = new Map<string, AttemptWindow>()

// Rate-limit admission as an Effect. Header side-effects happen inside the
// pipeline so direct callers and composed account flows share the exact
// Retry-After semantics; the boundary maps the typed failure to the existing
// 429 HttpError messages.
export const rateLimitEffect = (ctx: HttpContext, bucket = 'authentication'): Effect.Effect<void, RateLimitFailure> =>
  Effect.gen(function* () {
    const now = Date.now()
    const login = bucket === 'login'
    const entries = login ? loginAttempts : attempts
    yield* Effect.sync(() => {
      for (const [key, value] of entries) if (value.until <= now) entries.delete(key)
    })
    const key = `${bucket}:${ctx.request.ip()}`
    let entry = entries.get(key)
    if (!entry) {
      if (entries.size >= (login ? 1000 : 10000)) {
        yield* Effect.sync(() => { ctx.response.header('Retry-After', '900') })
        return yield* Effect.fail(new RateLimitFailure('Too many authentication attempts', '900'))
      }
      entry = { count: 0, until: now + 15 * 60 * 1000, ...(login ? { accounts: new Map<string, number>() } : {}) }
      const created = entry
      yield* Effect.sync(() => { entries.set(key, created) })
      entry = created
    }
    const current = entry
    const deny = function* () {
      const retryAfter = String(Math.ceil((current.until - now) / 1000))
      yield* Effect.sync(() => { ctx.response.header('Retry-After', retryAfter) })
      return yield* Effect.fail(new RateLimitFailure('Too many authentication attempts; try again later', retryAfter))
    }
    // Bound login admission before allocating attacker-chosen account keys.
    // Separate storage prevents one login flood from consuming other categories.
    if (current.count >= (login ? 100 : 10)) yield* deny()
    yield* Effect.sync(() => { current.count++ })
    if (login) {
      const email: unknown = ctx.request.input('email')
      const normalized = typeof email === 'string' ? email.trim().toLowerCase() : ''
      const account = normalized.length <= 254 ? hashToken(normalized) : ''
      const count = current.accounts!.get(account) || 0
      if (count >= 10) yield* deny()
      yield* Effect.sync(() => { current.accounts!.set(account, count + 1) })
    }
  })

export function rateLimit(ctx: HttpContext, bucket = 'authentication'): void {
  runSyncThrow(rateLimitEffect(ctx, bucket).pipe(
    Effect.mapError((failure) => new HttpError(429, failure.message)),
  ))
}

export function passwordResetRateLimit(ctx: HttpContext, email: string): void {
  rateLimit(ctx, 'password-reset-request')
  const now = Date.now()
  for (const [key, value] of passwordResetEmails) if (value.until <= now) passwordResetEmails.delete(key)
  const key = hashToken(email.trim().toLowerCase())
  let entry = passwordResetEmails.get(key)
  if (!entry) {
    if (passwordResetEmails.size >= 10_000) throw new HttpError(429, 'Too many authentication attempts; try again later')
    entry = { count: 0, until: now + 60 * 60 * 1000 }
    passwordResetEmails.set(key, entry)
  }
  if (entry.count >= 3) {
    ctx.response.header('Retry-After', String(Math.ceil((entry.until - now) / 1000)))
    throw new HttpError(429, 'Too many authentication attempts; try again later')
  }
  entry.count++
}
