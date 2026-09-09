import type { Router, HttpContext } from '@adonisjs/core/http'
import * as oidc from 'openid-client'
import { Effect } from 'effect'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createSession, db, audit, HttpError, type UserRow } from '../core.js'
import { runPromiseThrow } from '../database.js'
import { requireAdmin } from '../accounts.js'
import { hashToken, rateLimit } from '../security.js'
import { emailSchema } from '../service.js'
import { appUrl, production } from '../settings.js'

const flowCookie = 'hopya_oidc_flow'
const callbackPath = '/api/v1/auth/sso/callback'
const redirectUri = new URL(callbackPath, appUrl).href
const flowSeconds = 600
const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: appUrl.protocol === 'https:', path: '/api/v1/auth/sso' }
interface Flow { cookieHash: string; stateHash: string; nonce: string; codeVerifier: string; issuer: string; clientId: string; redirectUri: string; expiresAt: string }
const pendingCallbacks = new Map<Flow, Set<string>>()

async function requireSetup(): Promise<void> {
  if (!await db.get('SELECT id FROM users WHERE isAdmin=1 AND disabled=0 LIMIT 1')) throw new HttpError(503, 'Administrator setup required')
}
function issuerUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new HttpError(400, 'Invalid OIDC issuer') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) throw new HttpError(400, 'Invalid OIDC issuer')
  return url
}
const loopback = (url: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)

// --- Typed SSO failures (Effect values, mapped at the route boundary) ---
// Discovery/config problems stay 503s; a failed code exchange stays a 401.
// Messages match the existing contract, so only the composition is new.
class SsoUnavailable { readonly _tag = 'SsoUnavailable'; constructor(readonly message: string) {} }
class SsoAuthFailed { readonly _tag = 'SsoAuthFailed'; constructor(readonly message = 'SSO authentication failed') {} }
type SsoFailure = SsoUnavailable | SsoAuthFailed

const ssoHttpError = (failure: SsoFailure): HttpError =>
  failure._tag === 'SsoAuthFailed' ? new HttpError(401, failure.message) : new HttpError(503, failure.message)
const runSso = <A>(effect: Effect.Effect<A, SsoFailure>): Promise<A> =>
  runPromiseThrow(Effect.mapError(effect, ssoHttpError))

// Discovery chain as an Effect.gen composition: issuer validation, insecure
// guard, endpoint allowlist, metadata checks. Any step fails as SsoUnavailable
// with the single contract message, mirroring the old tryPromise catch.
const discoveryEffect = (): Effect.Effect<oidc.Configuration, SsoUnavailable> => Effect.gen(function* () {
  const issuer = yield* Effect.try({
    try: () => issuerUrl(process.env.OIDC_ISSUER!),
    catch: () => new SsoUnavailable('SSO provider unavailable'),
  })
  // NEVER enable this in production. HTTP is only for explicit loopback tests,
  // including APP_URL, discovery, token, authorization, and JWKS endpoints.
  const insecure = process.env.OIDC_ALLOW_INSECURE_HTTP === 'true'
  if (insecure && production) return yield* Effect.fail(new SsoUnavailable('SSO provider unavailable'))
  const allowed = (url: URL) => url.protocol === 'https:' || (insecure && url.protocol === 'http:' && loopback(url))
  if (!allowed(issuer) || !allowed(appUrl)) return yield* Effect.fail(new SsoUnavailable('SSO provider unavailable'))
  const config = yield* Effect.tryPromise({
    try: () => oidc.discovery(issuer, process.env.OIDC_CLIENT_ID!, process.env.OIDC_CLIENT_SECRET || undefined, undefined, {
      timeout: 10,
      execute: insecure ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks] : [oidc.enableNonRepudiationChecks],
      [oidc.customFetch]: (input, init) => {
        if (!allowed(new URL(String(input)))) throw new Error('HTTPS required')
        return fetch(input, { ...init, body: init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body, redirect: 'error' })
      },
    }),
    catch: () => new SsoUnavailable('SSO provider unavailable'),
  })
  const metadata = yield* Effect.try({
    try: () => config.serverMetadata(),
    catch: () => new SsoUnavailable('SSO provider unavailable'),
  })
  // Identity bindings and the recovery guard use exact issuer strings, not
  // URL equivalence (for example, an added trailing slash).
  if (metadata.issuer !== process.env.OIDC_ISSUER) return yield* Effect.fail(new SsoUnavailable('SSO provider unavailable'))
  for (const endpoint of [metadata.issuer, metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) {
    if (!endpoint) return yield* Effect.fail(new SsoUnavailable('SSO provider unavailable'))
    const endpointAllowed = yield* Effect.try({
      try: () => allowed(new URL(endpoint)),
      catch: () => new SsoUnavailable('SSO provider unavailable'),
    })
    if (!endpointAllowed) return yield* Effect.fail(new SsoUnavailable('SSO provider unavailable'))
  }
  return config
})

const pkceChallengeEffect = (codeVerifier: string): Effect.Effect<string, SsoFailure> =>
  Effect.mapError(
    Effect.tryPromise({
      try: () => oidc.calculatePKCECodeChallenge(codeVerifier),
      catch: () => new SsoUnavailable('SSO unavailable'),
    }),
    (failure): SsoFailure => failure,
  )

// Code exchange as its own Effect with a bound, so a stalled provider fails as
// the same 401 instead of hanging the callback past the flow lifetime.
const exchangeEffect = (config: oidc.Configuration, currentUrl: URL, flow: Flow, state: string): Effect.Effect<oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers, SsoFailure> =>
  Effect.mapError(
    Effect.timeoutFail(
      Effect.tryPromise({
        try: () => oidc.authorizationCodeGrant(config, currentUrl, {
          pkceCodeVerifier: flow.codeVerifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true,
        }),
        catch: () => new SsoAuthFailed(),
      }),
      { duration: '15 seconds', onTimeout: () => new SsoAuthFailed() },
    ),
    (failure): SsoFailure => failure,
  )

let configuration: Promise<oidc.Configuration> | undefined
function configured(): Promise<oidc.Configuration> {
  if (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID) throw new HttpError(503, 'SSO is not configured')
  if (!configuration) {
    configuration = runSso(discoveryEffect()).catch((error) => { configuration = undefined; throw error })
  }
  return configuration
}

export function registerSso(router: Router): void {
  router.get('/api/v1/auth/sso', async (ctx) => {
    await rateLimit(ctx, 'oidc-start')
    await requireSetup()
    const config = await configured()
    const cookie = randomBytes(32).toString('base64url')
    const state = oidc.randomState()
    const nonce = oidc.randomNonce()
    const codeVerifier = oidc.randomPKCECodeVerifier()
    const challenge = await runSso(pkceChallengeEffect(codeVerifier))
    const url = oidc.buildAuthorizationUrl(config, { redirect_uri: redirectUri, response_type: 'code', response_mode: 'query', scope: 'openid email profile',
      code_challenge: challenge, code_challenge_method: 'S256', state, nonce })
    await db.transaction(async () => {
      await requireSetup()
      await db.run('DELETE FROM oidc_flows WHERE expiresAt<=?', new Date().toISOString())
      const previous: unknown = ctx.request.cookie(flowCookie)
      if (typeof previous === 'string' && previous.length <= 256) await db.run('DELETE FROM oidc_flows WHERE cookieHash=?', hashToken(previous))
      const count = await db.get<{ count: number | string }>('SELECT count(*) AS count FROM oidc_flows')
      if (Number(count?.count ?? 0) >= 1000) throw new HttpError(429, 'Too many SSO attempts')
      await db.run(`INSERT INTO oidc_flows (cookieHash,stateHash,nonce,codeVerifier,issuer,clientId,redirectUri,expiresAt)
        VALUES (?,?,?,?,?,?,?,?)`, hashToken(cookie), hashToken(state), nonce, codeVerifier, config.serverMetadata().issuer,
        config.clientMetadata().client_id, redirectUri, new Date(Date.now() + flowSeconds * 1000).toISOString())
    })
    ctx.response.cookie(flowCookie, cookie, { ...cookieOptions, maxAge: flowSeconds })
    ctx.response.header('Referrer-Policy', 'no-referrer')
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.redirect(url.href)
  })
  router.get(callbackPath, async (ctx) => {
    ctx.response.clearCookie(flowCookie, cookieOptions)
    ctx.response.header('Referrer-Policy', 'no-referrer')
    ctx.response.header('Cache-Control', 'no-store')
    await requireSetup()
    const cookie: unknown = ctx.request.cookie(flowCookie)
    if (typeof cookie !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) throw new HttpError(401, 'Invalid or expired SSO flow')
    // Consume before any remote operation, including failed/error callbacks. Raw
    // cookie/state are never persisted; tokens and claims are never logged.
    const flow = await db.get(db.sql({
      sqlite: 'DELETE FROM oidc_flows WHERE cookieHash=? RETURNING *',
      pg: 'DELETE FROM oidc_flows WHERE cookieHash=? RETURNING *',
    }), hashToken(cookie)) as Flow | undefined
    if (!flow || flow.expiresAt <= new Date().toISOString()) throw new HttpError(401, 'Invalid or expired SSO flow')
    const rawUrl = ctx.request.url(true)
    if (rawUrl.length > 16384) throw new HttpError(400, 'Invalid SSO callback')
    const currentUrl = new URL(redirectUri)
    currentUrl.search = new URL(rawUrl, appUrl).search
    const states = currentUrl.searchParams.getAll('state')
    if (states.length !== 1 || states[0].length > 256 || hashToken(states[0]) !== flow.stateHash || currentUrl.searchParams.has('error')) throw new HttpError(401, 'SSO authentication failed')
    const revokedSubjects = new Set<string>()
    pendingCallbacks.set(flow, revokedSubjects)
    try {
      const config = await configured()
      if (flow.issuer !== config.serverMetadata().issuer || flow.clientId !== config.clientMetadata().client_id || flow.redirectUri !== redirectUri) throw new HttpError(401, 'Invalid SSO flow')
      const tokens = await runSso(exchangeEffect(config, currentUrl, flow, states[0]))
      const claims = tokens.claims()
      if (!claims || claims.iss !== flow.issuer || typeof claims.sub !== 'string' || !claims.sub.length || claims.sub.length > 255) throw new HttpError(401, 'SSO authentication failed')
      await db.transaction(async () => {
        await requireSetup()
        if (flow.expiresAt <= new Date().toISOString()) throw new HttpError(401, 'Invalid or expired SSO flow')
        if (revokedSubjects.has(claims.sub)) throw new HttpError(403, 'SSO identity was unlinked; start a new sign-in')
        let user = await db.get(`SELECT u.* FROM users u JOIN oidc_identities i ON i.userId=u.id
          WHERE i.issuer=? AND i.subject=?`, claims.iss, claims.sub) as UserRow | undefined
        if (!user) {
          if (process.env.OIDC_AUTO_PROVISION !== 'true') throw new HttpError(403, 'SSO identity is not linked to an account')
          const email = emailSchema.safeParse(claims.email)
          if (claims.email_verified !== true || !email.success) throw new HttpError(403, 'SSO requires a verified email address')
          if (await db.get(db.sql({
            sqlite: 'SELECT id FROM users WHERE email=? COLLATE NOCASE',
            pg: 'SELECT id FROM users WHERE lower(email)=lower(?)',
          }), email.data)) throw new HttpError(409, 'SSO account requires administrator linking')
          const name = z.string().trim().min(1).max(120).safeParse(claims.name)
          user = { id: randomUUID(), name: name.success ? name.data : email.data.slice(0, 120), email: email.data, passwordHash: null, isAdmin: 0, disabled: 0, createdAt: new Date().toISOString() }
          await db.run(`INSERT INTO users (id,name,email,passwordHash,isAdmin,disabled,createdAt)
            VALUES (@id,@name,@email,@passwordHash,@isAdmin,@disabled,@createdAt)`, user)
          await db.run('INSERT INTO oidc_identities (id,userId,issuer,subject,createdAt) VALUES (?,?,?,?,?)', randomUUID(), user.id, claims.iss, claims.sub, user.createdAt)
          await audit(user.id, null, 'auth.sso.provision', user.id)
        }
        if (user.disabled) throw new HttpError(403, 'Account unavailable')
        if (revokedSubjects.has(claims.sub)) throw new HttpError(403, 'SSO identity was unlinked; start a new sign-in')
        await createSession(ctx, user.id)
        if (revokedSubjects.has(claims.sub)) throw new HttpError(403, 'SSO identity was unlinked; start a new sign-in')
        await audit(user.id, null, 'auth.sso.login', user.id)
      })
      ctx.response.redirect(new URL('/app', appUrl).href)
    } finally {
      pendingCallbacks.delete(flow)
    }
  })
  router.get('/api/v1/admin/oidc-identities', async (ctx: HttpContext) => {
    await requireAdmin(ctx)
    const data = z.object({ userId: z.string().uuid().optional() }).strict().parse(ctx.request.qs())
    return data.userId
      ? db.all('SELECT id,userId,issuer,subject,createdAt FROM oidc_identities WHERE userId=? ORDER BY createdAt,id', data.userId)
      : db.all('SELECT id,userId,issuer,subject,createdAt FROM oidc_identities ORDER BY createdAt,id')
  })
  router.delete('/api/v1/admin/oidc-identities/:id', async (ctx: HttpContext) => {
    await requireAdmin(ctx)
    const id = z.string().uuid().parse(ctx.params.id)
    const identity = await db.transaction(async () => {
      const admin = await requireAdmin(ctx)
      const identity = await db.get<{ userId: string; issuer: string; subject: string; passwordHash: string | null }>(`SELECT i.userId,i.issuer,i.subject,u.passwordHash FROM oidc_identities i
        JOIN users u ON u.id=i.userId WHERE i.id=?`, id)
      if (!identity) throw new HttpError(404, 'OIDC identity not found')
      if (identity.passwordHash === null && (!process.env.OIDC_ISSUER || !process.env.OIDC_CLIENT_ID ||
        !await db.get('SELECT id FROM oidc_identities WHERE userId=? AND id<>? AND issuer=? LIMIT 1', identity.userId, id, process.env.OIDC_ISSUER))) {
        throw new HttpError(409, 'Cannot remove the last login method; link another identity for the configured OIDC issuer first, or disable the account to quarantine it while preserving recovery')
      }
      await db.run('DELETE FROM oidc_identities WHERE id=?', id)
      const revokedSessions = (await db.run('DELETE FROM sessions WHERE userId=?', identity.userId)).changes
      const revokedTokens = (await db.run('DELETE FROM tokens WHERE userId=?', identity.userId)).changes
      await audit(admin.id, null, 'admin.oidc.unlink', id, { userId: identity.userId, revokedSessions, revokedTokens })
      return identity
    })
    // Single-process API: invalidate matching exchanges only after commit. The
    // subject is unknown until token verification; do not let JIT undo an unlink.
    for (const [flow, revokedSubjects] of pendingCallbacks) {
      if (flow.issuer === identity.issuer) revokedSubjects.add(identity.subject)
    }
    return { success: true }
  })
  router.post('/api/v1/admin/oidc-identities', async (ctx: HttpContext) => {
    await requireAdmin(ctx)
    const data = z.object({ userId: z.string().uuid(), issuer: z.string().min(1).max(2048), subject: z.string().min(1).max(255).refine((value) => !/[\x00-\x1f\x7f]/.test(value), 'Invalid subject') }).strict().parse(ctx.request.body())
    const issuer = issuerUrl(data.issuer)
    if (issuer.protocol !== 'https:' && !(process.env.OIDC_ALLOW_INSECURE_HTTP === 'true' && !production && loopback(issuer))) throw new HttpError(400, 'OIDC issuer requires HTTPS')
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    await db.transaction(async () => {
      const admin = await requireAdmin(ctx)
      if (!await db.get('SELECT id FROM users WHERE id=? AND disabled=0', data.userId)) throw new HttpError(404, 'Active user not found')
      if (await db.get('SELECT id FROM oidc_identities WHERE issuer=? AND subject=?', data.issuer, data.subject)) throw new HttpError(409, 'OIDC identity already linked')
      await db.run('INSERT INTO oidc_identities (id,userId,issuer,subject,createdAt) VALUES (?,?,?,?,?)', id, data.userId, data.issuer, data.subject, createdAt)
      await audit(admin.id, null, 'admin.oidc.link', id, { userId: data.userId })
    })
    ctx.response.status(201)
    return { id, userId: data.userId, createdAt }
  })
}
