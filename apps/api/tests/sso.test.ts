import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { integrationServer, responseCookie } from './storage-sso-fixture.js'

async function provider(t: TestContext) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const badKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>()
  const state = { claims: {} as Record<string, unknown>, invalidSignature: false, tokenCalls: 0, onToken: () => {}, discoveryCalls: 0, metadataIssuer: undefined as string | undefined }
  let issuer = ''
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, issuer)
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (url.pathname === '/.well-known/openid-configuration') {
      state.discoveryCalls++
      json({ issuer: state.metadataIssuer || issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] })
    } else if (url.pathname === '/jwks') json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-signing-key', use: 'sig', alg: 'RS256' }] })
    else if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('client_id'), 'hopya-test-client')
      assert.equal(url.searchParams.get('response_type'), 'code')
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(url.searchParams.get('response_mode'), 'query')
      assert.match(url.searchParams.get('scope')!, /\bopenid\b/)
      assert.ok(url.searchParams.get('nonce'))
      const redirect = url.searchParams.get('redirect_uri')!
      const code = randomUUID()
      codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, redirect })
      const callback = new URL(redirect)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', url.searchParams.get('state')!)
      response.writeHead(302, { location: callback.href }); response.end()
    } else if (url.pathname === '/token') {
      state.tokenCalls++
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = new URLSearchParams(Buffer.concat(chunks).toString())
      const code = codes.get(body.get('code')!)
      codes.delete(body.get('code')!)
      if (!code || body.get('grant_type') !== 'authorization_code' || body.get('client_id') !== 'hopya-test-client' || body.get('client_secret') !== 'mock-idp-secret' ||
        body.get('redirect_uri') !== code.redirect || createHash('sha256').update(body.get('code_verifier') || '').digest('base64url') !== code.challenge) {
        json({ error: 'invalid_grant', error_description: 'mock-idp-secret should never be exposed' }, 400); return
      }
      state.onToken()
      const now = Math.floor(Date.now() / 1000)
      const claims = { iss: issuer, sub: 'provider-subject', aud: 'hopya-test-client', iat: now, exp: now + 300, nonce: code.nonce,
        email: 'sso@example.test', email_verified: true, name: 'SSO User', ...state.claims }
      const signingInput = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-signing-key', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), state.invalidSignature ? badKeys.privateKey : keys.privateKey).toString('base64url')
      json({ token_type: 'Bearer', access_token: 'mock-private-access-token', id_token: `${signingInput}.${signature}`, expires_in: 300 })
    } else json({ error: 'not_found' }, 404)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  t.after(() => { server.closeAllConnections(); server.close() })
  return { issuer, state, env: { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'hopya-test-client', OIDC_CLIENT_SECRET: 'mock-idp-secret', OIDC_ALLOW_INSECURE_HTTP: 'true', OIDC_AUTO_PROVISION: 'true' } }
}

async function begin(f: Awaited<ReturnType<typeof integrationServer>>, cookie?: string) {
  const response = await f.request('/auth/sso', { cookie, headers: { host: 'untrusted-host.example', 'x-forwarded-host': 'evil.example' } })
  assert.equal(response.status, 302, await response.clone().text())
  const authorize = new URL(response.headers.get('location')!)
  assert.equal(authorize.searchParams.get('redirect_uri'), `${f.base}/api/v1/auth/sso/callback`)
  const authorization = await fetch(authorize, { redirect: 'manual' })
  assert.equal(authorization.status, 302)
  return { cookie: responseCookie(response), callback: authorization.headers.get('location')!, response, authorize }
}
const finish = (flow: { cookie: string; callback: string }) => fetch(flow.callback, { headers: { cookie: flow.cookie }, redirect: 'manual' })

test('configured OIDC issuer must exactly match discovery, including trailing slash, before creating a flow', async (t) => {
  const p = await provider(t)
  p.state.metadataIssuer = `${p.issuer}/`
  p.state.claims = { iss: p.state.metadataIssuer }
  const mismatched = await integrationServer(t, p.env)
  mismatched.user(true)
  const denied = await mismatched.request('/auth/sso')
  assert.equal(denied.status, 503)
  assert.deepEqual(await denied.json(), { error: 'SSO provider unavailable' })
  assert.deepEqual(mismatched.db.prepare('SELECT * FROM oidc_flows').all(), [])
  assert.equal(p.state.tokenCalls, 0)
  const exact = await integrationServer(t, { ...p.env, OIDC_ISSUER: p.state.metadataIssuer })
  exact.user(true)
  const response = await finish(await begin(exact))
  assert.equal(response.status, 302)
  assert.equal((await exact.request('/auth/me', { cookie: responseCookie(response) })).status, 200)
  assert.equal((exact.db.prepare('SELECT issuer FROM oidc_identities').get() as { issuer: string }).issuer, p.state.metadataIssuer)
})

test('OIDC code/PKCE over real HTTP: setup gate, one-use hashed flows, JIT isolation and session cookies', { timeout: 60000 }, async (t) => {
  const p = await provider(t)
  const f = await integrationServer(t, p.env)
  assert.equal((await f.request('/auth/sso')).status, 503)
  assert.equal(p.state.discoveryCalls, 0)
  const admin = f.user(true, 'admin@example.test')
  let flow = await begin(f)
  assert.match(flow.response.headers.get('set-cookie')!, /HttpOnly/)
  assert.match(flow.response.headers.get('set-cookie')!, /SameSite=Lax/)
  assert.match(flow.response.headers.get('set-cookie')!, /Path=\/api\/v1\/auth\/sso;/)
  assert.match(flow.response.headers.get('set-cookie')!, /Max-Age=600/)
  const stored = f.db.prepare('SELECT * FROM oidc_flows').get() as { cookieHash: string; stateHash: string; codeVerifier: string; nonce: string }
  assert.match(stored.cookieHash, /^[a-f0-9]{64}$/)
  assert.match(stored.stateHash, /^[a-f0-9]{64}$/)
  assert.equal(flow.cookie.includes(stored.cookieHash), false)
  assert.notEqual(stored.stateHash, flow.authorize.searchParams.get('state'))
  assert.equal(createHash('sha256').update(stored.codeVerifier).digest('base64url'), flow.authorize.searchParams.get('code_challenge'))
  let response = await finish(flow)
  assert.equal(response.status, 302, await response.clone().text())
  assert.equal(response.headers.get('location'), `${f.base}/app`)
  assert.match(response.headers.getSetCookie().find((cookie) => cookie.startsWith('hopya_session='))!, /HttpOnly/)
  let session = responseCookie(response)
  const me = await (await f.request('/auth/me', { cookie: session })).json() as { id: string; isAdmin: boolean; email: string }
  assert.equal(me.email, 'sso@example.test'); assert.equal(me.isAdmin, false)
  assert.deepEqual(await (await f.request('/workspaces', { cookie: session })).json(), [])
  assert.equal((f.db.prepare('SELECT passwordHash FROM users WHERE id=?').get(me.id) as { passwordHash: unknown }).passwordHash, null)
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM oidc_flows').get() as { count: number }).count, 0)
  assert.equal((await finish(flow)).status, 401)
  assert.equal(p.state.tokenCalls, 1)
  p.state.claims = { email: 'changed-unverified@example.test', email_verified: false }
  flow = await begin(f)
  response = await finish(flow)
  assert.equal(response.status, 302)
  session = responseCookie(response)
  assert.equal((await (await f.request('/auth/me', { cookie: session })).json() as { id: string }).id, me.id)
  assert.equal((f.db.prepare('SELECT email FROM users WHERE id=?').get(me.id) as { email: string }).email, 'sso@example.test')
  flow = await begin(f)
  const badState = new URL(flow.callback); badState.searchParams.set('state', 'wrong')
  assert.equal((await finish({ ...flow, callback: badState.href })).status, 401)
  assert.equal((await finish(flow)).status, 401)
  flow = await begin(f)
  f.db.prepare('UPDATE oidc_flows SET expiresAt=?').run('2000-01-01T00:00:00.000Z')
  assert.equal((await finish(flow)).status, 401)
  flow = await begin(f)
  assert.equal((await finish({ ...flow, cookie: '' })).status, 401)
  assert.equal((await finish({ ...flow, cookie: 'hopya_oidc_flow=attacker' })).status, 401)
  const errorUrl = new URL(flow.callback)
  errorUrl.searchParams.set('error', 'access_denied'); errorUrl.searchParams.set('error_description', 'mock-idp-secret')
  response = await finish({ ...flow, callback: errorUrl.href })
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'SSO authentication failed' })
  assert.equal((await finish(flow)).status, 401)
  const abandoned = await begin(f)
  const restarted = await begin(f, abandoned.cookie)
  assert.equal((await finish(abandoned)).status, 401)
  assert.equal((await finish(restarted)).status, 302)
  p.state.claims = { sub: 'new-without-admin', email: 'new@example.test' }
  flow = await begin(f)
  p.state.onToken = () => { f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(admin.id) }
  assert.equal((await finish(flow)).status, 503)
  assert.equal(f.db.prepare('SELECT id FROM users WHERE email=?').get('new@example.test'), undefined)
  const audit = JSON.stringify(f.db.prepare('SELECT * FROM audit_logs').all())
  for (const secret of ['mock-idp-secret', 'mock-private-access-token', stored.codeVerifier, stored.nonce, 'provider-subject']) {
    assert.equal(audit.includes(secret), false)
    assert.equal(f.output().includes(secret), false)
  }
  assert.deepEqual(f.db.pragma('foreign_key_check'), [])
})

test('OIDC rejects invalid signed claims, email collisions and unverified JIT emails', { timeout: 60000 }, async (t) => {
  const p = await provider(t)
  const f = await integrationServer(t, p.env)
  f.user(true, 'local@example.test')
  for (const claims of [{ nonce: 'wrong-nonce' }, { aud: 'wrong-client' }, { iss: 'https://wrong-issuer.test' }, { exp: 1 }, { sub: '' }]) {
    p.state.claims = claims
    const response = await finish(await begin(f))
    assert.equal(response.status, 401, await response.clone().text())
    assert.deepEqual(await response.json(), { error: 'SSO authentication failed' })
  }
  p.state.claims = {}; p.state.invalidSignature = true
  assert.equal((await finish(await begin(f))).status, 401)
  p.state.invalidSignature = false
  p.state.claims = { email_verified: false }
  assert.equal((await finish(await begin(f))).status, 403)
  p.state.claims = { email: 'LOCAL@example.test' }
  assert.equal((await finish(await begin(f))).status, 409)
  p.state.claims = { email_verified: 'true' }
  assert.equal((await finish(await begin(f))).status, 403)
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count, 1)
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count, 0)
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM oidc_identities').get() as { count: number }).count, 0)
})

test('closed OIDC provisioning requires explicit admin issuer/subject linking and rechecks disabled users', { timeout: 60000 }, async (t) => {
  const p = await provider(t)
  const f = await integrationServer(t, { ...p.env, OIDC_AUTO_PROVISION: 'false' })
  const admin = f.user(true); const target = f.user()
  assert.equal((await finish(await begin(f))).status, 403)
  const body = { userId: target.id, issuer: p.issuer, subject: 'provider-subject' }
  const link = (token: string, value: unknown = body, origin?: string) => f.request('/admin/oidc-identities', { method: 'POST', token, body: value, origin })
  assert.equal((await link(target.token)).status, 403)
  assert.equal((await link(admin.token, body, 'https://evil.test')).status, 403)
  assert.equal((await link(admin.token, { ...body, issuer: 'https://user:secret@issuer.test' })).status, 400)
  assert.equal((await link(admin.token, { ...body, issuer: 'http://untrusted.example' })).status, 400)
  assert.equal((await link(admin.token, { ...body, issuer: `${p.issuer}/other-issuer` })).status, 201)
  assert.equal((await finish(await begin(f))).status, 403)
  let response = await link(admin.token)
  assert.equal(response.status, 201)
  assert.deepEqual(Object.keys(await response.json() as object).sort(), ['createdAt', 'id', 'userId'])
  assert.equal((await link(admin.token, { ...body, userId: admin.id })).status, 409)
  p.state.claims = { email_verified: false, email: admin.email }
  response = await finish(await begin(f))
  assert.equal(response.status, 302, await response.clone().text())
  const cookie = responseCookie(response)
  assert.equal((await (await f.request('/auth/me', { cookie })).json() as { id: string }).id, target.id)
  const flow = await begin(f)
  p.state.onToken = () => { f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(target.id) }
  assert.equal((await finish(flow)).status, 403)
  assert.equal((await f.request('/auth/me', { cookie })).status, 401)
  assert.equal((await link(admin.token, { ...body, subject: 'another' })).status, 404)
  assert.equal((f.db.prepare('SELECT count(*) AS count FROM users').get() as { count: number }).count, 2)
  const audit = JSON.stringify(f.db.prepare("SELECT * FROM audit_logs WHERE action='admin.oidc.link'").all())
  assert.equal(audit.includes('provider-subject'), false)
  assert.equal(audit.includes(target.id), true)
})

test('OIDC HTTP requires explicit loopback test opt-in and remains forbidden in production', { timeout: 60000 }, async (t) => {
  const p = await provider(t)
  for (const env of [{ ...p.env, OIDC_ALLOW_INSECURE_HTTP: 'false' }, { ...p.env, NODE_ENV: 'production' }, { ...p.env, OIDC_ISSUER: 'http://insecure.example' }]) {
    const f = await integrationServer(t, env)
    f.user(true)
    const response = await f.request('/auth/sso')
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'SSO provider unavailable' })
  }
  assert.equal(p.state.discoveryCalls, 0)
})
