import type { HttpContext, Router } from '@adonisjs/core/http'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import { audit, db } from './core.js'
import { authenticate } from './security.js'
import { requirePermission } from './service.js'
import { HttpError } from './types.js'
import { outboundHttpError, pinnedRequestEffect, resolvePinnedDestination } from './pinned_http.js'

export const credentialTypes = ['bearer', 'api_key', 'basic', 'custom_headers', 'oauth2'] as const
export type CredentialType = typeof credentialTypes[number]

const headerName = z.string().trim().min(1).max(100).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
const forbiddenCredentialHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'proxy-authorization'])
const headersSchema = z.record(headerName, z.string().max(2000)).refine((value) => Object.keys(value).length <= 20, 'Too many headers')
  .refine((value) => Object.keys(value).every((name) => !forbiddenCredentialHeaders.has(name.toLowerCase())), 'Hop-by-hop headers are not allowed')
const secretSchemas = {
  bearer: z.object({ token: z.string().min(1).max(8192) }).strict(),
  api_key: z.object({ name: headerName, value: z.string().min(1).max(8192) }).strict()
    .refine((value) => !forbiddenCredentialHeaders.has(value.name.toLowerCase()), 'Hop-by-hop headers are not allowed'),
  basic: z.object({ username: z.string().max(1000), password: z.string().max(8192) }).strict(),
  custom_headers: z.object({ headers: headersSchema }).strict(),
  oauth2: z.object({
    authorizationUrl: z.string().url().max(2000), tokenUrl: z.string().url().max(2000), clientId: z.string().min(1).max(1000),
    clientSecret: z.string().max(8192).optional(), scopes: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    accessToken: z.string().max(8192).optional(), refreshToken: z.string().max(8192).optional(), expiresAt: z.string().datetime({ offset: true }).optional(),
  }).strict(),
} as const
const metadataSchema = z.object({
  name: z.string().trim().min(1).max(120), type: z.enum(credentialTypes),
  origin: z.string().max(2000), pathPrefix: z.string().max(1000).nullable().default(null), secret: z.record(z.string(), z.unknown()),
}).strict()

interface CredentialRow extends Record<string, unknown> {
  id: string; workspaceId: string; name: string; type: CredentialType; origin: string; pathPrefix: string | null
  version: number; status: 'active' | 'revoked'; createdBy: string | null; createdAt: string; updatedAt: string
}
interface VersionRow extends Record<string, unknown> { keyId: string; encrypted: string }

function keyring(): { active: string; keys: Record<string, Buffer> } {
  let parsed: unknown
  try { parsed = JSON.parse(process.env.AUTOMATION_KEYRING ?? '') } catch { throw new HttpError(503, 'Automation credential keyring is not configured') }
  const result = z.object({ active: z.string().min(1).max(100), keys: z.record(z.string(), z.string()) }).strict().safeParse(parsed)
  if (!result.success) throw new HttpError(503, 'Automation credential keyring is not configured')
  const keys = Object.fromEntries(Object.entries(result.data.keys).map(([id, value]) => [id, Buffer.from(String(value), 'base64')]))
  if (!keys[result.data.active] || Object.values(keys).some((key) => key.length !== 32)) throw new HttpError(503, 'Automation credential keyring is invalid')
  return { active: result.data.active, keys }
}

function aad(workspaceId: string, credentialId: string, version: number, type: string): string {
  return JSON.stringify(['hopya-automation-credential', workspaceId, credentialId, version, type])
}
function encrypt(value: unknown, workspaceId: string, credentialId: string, version: number, type: string): { keyId: string; encrypted: string } {
  const ring = keyring(), iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', ring.keys[ring.active]!, iv)
  cipher.setAAD(Buffer.from(aad(workspaceId, credentialId, version, type)))
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
  return { keyId: ring.active, encrypted: Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64') }
}
function decrypt(row: VersionRow, workspaceId: string, credentialId: string, version: number, type: string): Record<string, unknown> {
  const key = keyring().keys[row.keyId]
  if (!key) throw new HttpError(503, 'Automation credential key is unavailable')
  const encoded = Buffer.from(row.encrypted, 'base64'), decipher = createDecipheriv('aes-256-gcm', key, encoded.subarray(0, 12))
  decipher.setAAD(Buffer.from(aad(workspaceId, credentialId, version, type))); decipher.setAuthTag(encoded.subarray(12, 28))
  return JSON.parse(Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString('utf8')) as Record<string, unknown>
}

export async function assertSafeDestination(input: string, credential = false): Promise<URL> {
  return (await resolvePinnedDestination(input, credential)).url
}

function safeMetadata(row: CredentialRow) {
  return { id: row.id, name: row.name, type: row.type, origin: row.origin, pathPrefix: row.pathPrefix, version: row.version, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt }
}
async function canReadMetadata(userId: string, wid: string): Promise<void> {
  try { await requirePermission(userId, wid, 'automations:manage') } catch { await requirePermission(userId, wid, 'credentials:manage') }
}
async function credential(wid: string, id: string, active = false): Promise<CredentialRow> {
  const row = await db.get<CredentialRow>(`SELECT * FROM automation_credentials WHERE workspaceId=? AND id=?${active ? " AND status='active'" : ''}`, wid, id)
  if (!row) throw new HttpError(404, 'Credential not found')
  return row
}
function parseSecret(type: CredentialType, value: unknown): Record<string, unknown> {
  const result = secretSchemas[type].safeParse(value)
  if (!result.success) throw new HttpError(400, `Invalid ${type} credential secret`)
  return result.data as Record<string, unknown>
}
function normalizeBinding(origin: string, pathPrefix: string | null) {
  const url = new URL(origin)
  if (url.pathname !== '/' || url.search || url.hash) throw new HttpError(400, 'Credential origin must contain only scheme, host and optional port')
  if (pathPrefix !== null && (!pathPrefix.startsWith('/') || pathPrefix.includes('?') || pathPrefix.includes('#'))) throw new HttpError(400, 'Credential path prefix is invalid')
  return url.origin
}

const refreshLocks = new Map<string, Promise<void>>()
async function tokenRequest(url: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  const destination = await resolvePinnedDestination(url, true)
  const outcome = await Effect.runPromise(Effect.either(pinnedRequestEffect(destination, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), timeoutMs: 15_000, maxResponseBytes: 32 * 1024 })))
  if (outcome._tag === 'Left') throw outboundHttpError(outcome.left)
  if (outcome.right.status < 200 || outcome.right.status >= 300) throw new HttpError(502, 'OAuth token endpoint rejected the request')
  try { return JSON.parse(outcome.right.body.toString('utf8')) as Record<string, unknown> } catch { throw new HttpError(502, 'OAuth token endpoint returned malformed JSON') }
}
async function refreshOAuth(row: CredentialRow, secret: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!secret.accessToken) throw new HttpError(409, 'OAuth credential is not connected')
  if (!secret.expiresAt || Date.parse(String(secret.expiresAt)) > Date.now() + 30_000) return secret
  if (!secret.refreshToken) throw new HttpError(409, 'OAuth credential has expired; reconnect it')
  const key = `${row.workspaceId}:${row.id}`
  const active = refreshLocks.get(key)
  if (active) { await active; return loadCredential(row.workspaceId, row.id) }
  const work = (async () => {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(secret.refreshToken), client_id: String(secret.clientId) })
    if (secret.clientSecret) body.set('client_secret', String(secret.clientSecret))
    const raw = await tokenRequest(String(secret.tokenUrl), body)
    const parsed = z.object({ access_token: z.string().max(8192), refresh_token: z.string().max(8192).optional(), expires_in: z.number().int().positive().max(31_536_000).optional() }).passthrough().safeParse(raw)
    if (!parsed.success) throw new HttpError(502, 'OAuth token endpoint returned an invalid response')
    const token = parsed.data
    const next = { ...secret, accessToken: token.access_token, refreshToken: token.refresh_token ?? secret.refreshToken, expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined }
    const encrypted = encrypt(next, row.workspaceId, row.id, row.version + 1, row.type), now = new Date().toISOString()
    await db.transaction(async () => {
      const current = await credential(row.workspaceId, row.id, true)
      if (current.version !== row.version) return
      await db.run('INSERT INTO automation_credential_versions (workspaceId,credentialId,version,keyId,encrypted,createdAt) VALUES (?,?,?,?,?,?)', row.workspaceId, row.id, row.version + 1, encrypted.keyId, encrypted.encrypted, now)
      await db.run('UPDATE automation_credentials SET version=?,updatedAt=? WHERE workspaceId=? AND id=? AND version=?', row.version + 1, now, row.workspaceId, row.id, row.version)
    })
  })().finally(() => refreshLocks.delete(key))
  refreshLocks.set(key, work); await work
  const current = await credential(row.workspaceId, row.id, true)
  return loadCredential(current.workspaceId, current.id, current.version)
}
async function loadCredential(wid: string, id: string, version?: number): Promise<Record<string, unknown>> {
  const row = await credential(wid, id, true), selected = version ?? row.version
  const stored = await db.get<VersionRow>('SELECT keyId,encrypted FROM automation_credential_versions WHERE workspaceId=? AND credentialId=? AND version=?', wid, id, selected)
  if (!stored) throw new HttpError(404, 'Credential version not found')
  return decrypt(stored, wid, id, selected, row.type)
}

export async function applyCredential(wid: string, id: string, destination: URL, headers: Record<string, string>): Promise<{ url: URL; redactions: string[] }> {
  const row = await credential(wid, id, true)
  if (destination.origin !== row.origin || row.pathPrefix && !(destination.pathname === row.pathPrefix || destination.pathname.startsWith(`${row.pathPrefix.replace(/\/$/, '')}/`))) throw new HttpError(400, 'Credential destination binding does not match')
  let secret = await loadCredential(wid, id)
  if (row.type === 'oauth2') secret = await refreshOAuth(row, secret)
  const redactions: string[] = [], add = (...values: unknown[]) => { for (const value of values) if (typeof value === 'string' && value) redactions.push(value) }
  if (row.type === 'bearer' || row.type === 'oauth2') { const token = String(row.type === 'bearer' ? secret.token : secret.accessToken); headers.authorization = `Bearer ${token}`; add(headers.authorization, token) }
  if (row.type === 'basic') { const pair = `${secret.username}:${secret.password}`, encoded = Buffer.from(pair).toString('base64'); headers.authorization = `Basic ${encoded}`; add(headers.authorization, encoded, pair, secret.username, secret.password) }
  if (row.type === 'custom_headers') { Object.assign(headers, secret.headers); for (const [name, value] of Object.entries(secret.headers as Record<string, string>)) add(`${name}: ${value}`, value) }
  if (row.type === 'api_key') { const name = String(secret.name), value = String(secret.value); headers[name] = value; add(`${name}: ${value}`, value) }
  return { url: destination, redactions: [...new Set(redactions)].sort((left, right) => right.length - left.length) }
}

export function registerAutomationCredentials(router: Router): void {
  router.group(() => {
    router.get('/workspaces/:wid/automations/credentials', async (ctx) => {
      const user = await authenticate(ctx), { wid } = ctx.params; await canReadMetadata(user.id, wid)
      return (await db.all<CredentialRow>('SELECT * FROM automation_credentials WHERE workspaceId=? ORDER BY createdAt,id', wid)).map(safeMetadata)
    })
    router.get('/workspaces/:wid/automations/credentials/:id', async (ctx) => {
      const user = await authenticate(ctx), { wid, id } = ctx.params; await canReadMetadata(user.id, wid); return safeMetadata(await credential(wid, id))
    })
    router.post('/workspaces/:wid/automations/credentials', async (ctx) => {
      const user = await authenticate(ctx), { wid } = ctx.params, data = metadataSchema.parse(ctx.request.body())
      await requirePermission(user.id, wid, 'credentials:manage')
      const origin = normalizeBinding(data.origin, data.pathPrefix); await assertSafeDestination(origin, true)
      const secret = parseSecret(data.type, data.secret), id = randomUUID(), timestamp = new Date().toISOString(), encrypted = encrypt(secret, wid, id, 1, data.type)
      return db.transaction(async () => {
        await requirePermission(user.id, wid, 'credentials:manage')
        await db.run('INSERT INTO automation_credentials (id,workspaceId,name,type,origin,pathPrefix,version,status,createdBy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,1,\'active\',?,?,?)', id, wid, data.name, data.type, origin, data.pathPrefix, user.id, timestamp, timestamp)
        await db.run('INSERT INTO automation_credential_versions (workspaceId,credentialId,version,keyId,encrypted,createdAt) VALUES (?,?,?,?,?,?)', wid, id, 1, encrypted.keyId, encrypted.encrypted, timestamp)
        await audit(user.id, wid, 'automation.credential.create', id, { type: data.type, origin, pathPrefix: data.pathPrefix })
        return safeMetadata(await credential(wid, id))
      })
    })
    router.put('/workspaces/:wid/automations/credentials/:id', async (ctx) => {
      const user = await authenticate(ctx), { wid, id } = ctx.params
      const data = z.object({ expectedVersion: z.number().int().positive(), name: z.string().trim().min(1).max(120).optional(), secret: z.record(z.string(), z.unknown()) }).strict().parse(ctx.request.body())
      return db.transaction(async () => {
        await requirePermission(user.id, wid, 'credentials:manage'); const previous = await credential(wid, id, true)
        if (previous.version !== data.expectedVersion) throw new HttpError(409, 'Credential changed; reload before replacing')
        const nextVersion = previous.version + 1, encrypted = encrypt(parseSecret(previous.type, data.secret), wid, id, nextVersion, previous.type), timestamp = new Date().toISOString()
        await db.run('INSERT INTO automation_credential_versions (workspaceId,credentialId,version,keyId,encrypted,createdAt) VALUES (?,?,?,?,?,?)', wid, id, nextVersion, encrypted.keyId, encrypted.encrypted, timestamp)
        const changed = await db.run('UPDATE automation_credentials SET name=?,version=?,updatedAt=? WHERE workspaceId=? AND id=? AND version=?', data.name ?? previous.name, nextVersion, timestamp, wid, id, previous.version)
        if (!changed.changes) throw new HttpError(409, 'Credential changed; reload before replacing')
        await audit(user.id, wid, 'automation.credential.replace', id, { version: nextVersion }); return safeMetadata(await credential(wid, id))
      })
    })
    router.delete('/workspaces/:wid/automations/credentials/:id', async (ctx) => {
      const user = await authenticate(ctx), { wid, id } = ctx.params
      return db.transaction(async () => { await requirePermission(user.id, wid, 'credentials:manage'); await credential(wid, id)
        await db.run("UPDATE automation_credentials SET status='revoked',updatedAt=? WHERE workspaceId=? AND id=?", new Date().toISOString(), wid, id)
        await audit(user.id, wid, 'automation.credential.revoke', id); return { success: true }
      })
    })
    router.post('/workspaces/:wid/automations/credentials/:id/oauth/start', oauthStart)
    router.get('/workspaces/:wid/automations/credentials/:id/oauth/callback', oauthCallback)
  }).prefix('/api/v1')
}

async function oauthStart(ctx: HttpContext) {
  const user = await authenticate(ctx), { wid, id } = ctx.params; await requirePermission(user.id, wid, 'credentials:manage')
  const row = await credential(wid, id, true); if (row.type !== 'oauth2') throw new HttpError(400, 'Credential is not OAuth 2.0')
  const secret = await loadCredential(wid, id), authorizationUrl = (await resolvePinnedDestination(String(secret.authorizationUrl), true)).url
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url')
  const redirectUri = new URL(`/api/v1/workspaces/${wid}/automations/credentials/${id}/oauth/callback`, process.env.APP_URL || 'http://localhost:4321').toString()
  authorizationUrl.searchParams.set('response_type', 'code'); authorizationUrl.searchParams.set('client_id', String(secret.clientId)); authorizationUrl.searchParams.set('redirect_uri', redirectUri)
  authorizationUrl.searchParams.set('state', state); authorizationUrl.searchParams.set('code_challenge', challenge); authorizationUrl.searchParams.set('code_challenge_method', 'S256')
  if ((secret.scopes as string[]).length) authorizationUrl.searchParams.set('scope', (secret.scopes as string[]).join(' '))
  const encrypted = encrypt({ verifier }, wid, id, row.version, 'oauth-verifier'), expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()
  await db.run('DELETE FROM automation_oauth_flows WHERE expiresAt<? OR (workspaceId=? AND credentialId=?)', new Date().toISOString(), wid, id)
  await db.run('INSERT INTO automation_oauth_flows (stateHash,workspaceId,credentialId,credentialVersion,verifierKeyId,verifierEncrypted,redirectUri,expiresAt,createdBy) VALUES (?,?,?,?,?,?,?,?,?)', createHash('sha256').update(state).digest('hex'), wid, id, row.version, encrypted.keyId, encrypted.encrypted, redirectUri, expiresAt, user.id)
  return { authorizationUrl: authorizationUrl.toString(), expiresAt }
}

async function oauthCallback(ctx: HttpContext) {
  const user = await authenticate(ctx), { wid, id } = ctx.params, query = z.object({ state: z.string().min(20).max(200), code: z.string().min(1).max(4000) }).strict().parse(ctx.request.qs())
  const stateHash = createHash('sha256').update(query.state).digest('hex')
  const flow = await db.transaction(async () => {
    await requirePermission(user.id, wid, 'credentials:manage')
    const selected = await db.get<{ credentialVersion: number; verifierKeyId: string; verifierEncrypted: string; redirectUri: string; expiresAt: string; createdBy: string }>('SELECT credentialVersion,verifierKeyId,verifierEncrypted,redirectUri,expiresAt,createdBy FROM automation_oauth_flows WHERE stateHash=? AND workspaceId=? AND credentialId=?', stateHash, wid, id)
    if (!selected || selected.expiresAt <= new Date().toISOString() || selected.createdBy !== user.id) throw new HttpError(400, 'OAuth state is invalid or expired')
    const consumed = await db.run('DELETE FROM automation_oauth_flows WHERE stateHash=? AND workspaceId=? AND credentialId=?', stateHash, wid, id)
    if (!consumed.changes) throw new HttpError(400, 'OAuth state is invalid or expired')
    return selected
  })
  const row = await credential(wid, id, true)
  if (row.type !== 'oauth2' || row.version !== flow.credentialVersion) throw new HttpError(409, 'OAuth credential changed; start the connection again')
  const secret = await loadCredential(wid, id, flow.credentialVersion)
  const verifier = decrypt({ keyId: flow.verifierKeyId, encrypted: flow.verifierEncrypted }, wid, id, flow.credentialVersion, 'oauth-verifier').verifier
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: flow.redirectUri, client_id: String(secret.clientId), code_verifier: String(verifier) })
  if (secret.clientSecret) body.set('client_secret', String(secret.clientSecret))
  const raw = await tokenRequest(String(secret.tokenUrl), body)
  const parsed = z.object({ access_token: z.string().max(8192), refresh_token: z.string().max(8192).optional(), expires_in: z.number().int().positive().max(31_536_000).optional() }).passthrough().safeParse(raw)
  if (!parsed.success) throw new HttpError(502, 'OAuth token endpoint returned an invalid response')
  const token = parsed.data
  const next = { ...secret, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : undefined }
  await db.transaction(async () => {
    await requirePermission(user.id, wid, 'credentials:manage')
    const current = await credential(wid, id, true)
    if (current.version !== flow.credentialVersion) throw new HttpError(409, 'OAuth credential changed; start the connection again')
    const version = current.version + 1, encrypted = encrypt(next, wid, id, version, current.type), timestamp = new Date().toISOString()
    await db.run('INSERT INTO automation_credential_versions (workspaceId,credentialId,version,keyId,encrypted,createdAt) VALUES (?,?,?,?,?,?)', wid, id, version, encrypted.keyId, encrypted.encrypted, timestamp)
    const changed = await db.run('UPDATE automation_credentials SET version=?,updatedAt=? WHERE workspaceId=? AND id=? AND version=?', version, timestamp, wid, id, current.version)
    if (!changed.changes) throw new HttpError(409, 'OAuth credential changed; start the connection again')
    await audit(user.id, wid, 'automation.credential.oauth.authorize', id, { version })
  })
  ctx.response.redirect(new URL('/integrations?oauth=connected', process.env.APP_URL || 'http://localhost:4321').href)
}
