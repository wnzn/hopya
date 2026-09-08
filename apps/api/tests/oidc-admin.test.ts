import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, scryptSync, sign } from 'node:crypto'
import { integrationServer, responseCookie } from './storage-sso-fixture.js'

type Fixture = Awaited<ReturnType<typeof integrationServer>>
interface Identity { id: string; userId: string; issuer: string; subject: string; createdAt: string }
const path = '/admin/oidc-identities'
const password = 'OIDC admin test local recovery password'
const salt = randomBytes(16).toString('hex')
const passwordHash = `scrypt$32768$8$1$${salt}$${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`

async function link(f: Fixture, token: string, userId: string, subject: string = randomUUID(), issuer = 'https://issuer.example.test'): Promise<Identity> {
  const response = await f.request(path, { method: 'POST', token, body: { userId, issuer, subject } })
  assert.equal(response.status, 201, await response.clone().text())
  const result = await response.json() as { id: string; userId: string; createdAt: string }
  assert.deepEqual(Object.keys(result).sort(), ['createdAt', 'id', 'userId'])
  return { ...result, issuer, subject }
}

async function login(f: Fixture, user: { id: string; email: string }) {
  f.db.prepare('UPDATE users SET passwordHash=? WHERE id=?').run(passwordHash, user.id)
  const response = await f.request('/auth/login', { method: 'POST', origin: f.base, body: { email: user.email, password } })
  assert.equal(response.status, 200, await response.clone().text())
  return responseCookie(response)
}

function snapshot(f: Fixture) {
  return {
    users: f.db.prepare('SELECT * FROM users ORDER BY id').all(),
    identities: f.db.prepare('SELECT * FROM oidc_identities ORDER BY id').all(),
    sessions: f.db.prepare('SELECT * FROM sessions ORDER BY id').all(),
    tokens: f.db.prepare('SELECT * FROM tokens ORDER BY id').all(),
    audits: f.db.prepare('SELECT * FROM audit_logs ORDER BY id').all(),
  }
}

test('OIDC identity listing is admin-only, exact public metadata, strictly UUID-filtered and read-only', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t)
  const admin = f.user(true); const target = f.user(); const other = f.user()
  const identities = [await link(f, admin.token, target.id), await link(f, admin.token, other.id), await link(f, admin.token, target.id)]
  f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(other.id)
  const before = snapshot(f)
  const response = await f.request(path, { token: admin.token })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const rows = await response.json() as Identity[]
  assert.deepEqual(rows, [...identities].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'id', 'issuer', 'subject', 'userId'])
  assert.deepEqual(await (await f.request(`${path}?userId=${target.id}`, { token: admin.token })).json(), rows.filter((row) => row.userId === target.id))
  assert.deepEqual(await (await f.request(`${path}?userId=${randomUUID()}`, { token: admin.token })).json(), [])
  for (const query of ['userId=', 'userId=invalid', `userId=${target.id}&userId=${other.id}`, `userId[]=${target.id}`, `userId[id]=${target.id}`, 'unexpected=true', `userId=${'a'.repeat(2049)}`]) {
    assert.equal((await f.request(`${path}?${query}`, { token: admin.token })).status, 400, query)
  }
  assert.equal((await f.request(path)).status, 401)
  assert.equal((await f.request(`${path}?userId=${target.id}`, { token: target.token })).status, 403)
  assert.equal((await f.request(`${path}?userId=invalid`, { token: target.token })).status, 403)
  assert.equal((await f.request(path, { token: other.token })).status, 401)
  assert.deepEqual(snapshot(f), before)
})

test('OIDC administration denies credential theft, invalid IDs, disabled targets and cross-origin mutation without side effects', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t)
  const admin = f.user(true); const target = f.user(); const other = f.user()
  const identity = await link(f, admin.token, target.id)
  const cookie = await login(f, admin)
  f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(other.id)
  const before = snapshot(f)
  const remove = (id: string, options: Parameters<Fixture['request']>[1] = {}) => f.request(`${path}/${id}`, { method: 'DELETE', ...options })
  assert.equal((await remove(identity.id, { origin: f.base })).status, 401)
  assert.equal((await remove(identity.id, { token: target.token })).status, 403)
  assert.equal((await remove(identity.id, { token: other.token })).status, 401)
  assert.equal((await remove(identity.id, { token: admin.token, origin: 'https://evil.example' })).status, 403)
  assert.equal((await remove(identity.id, { cookie })).status, 403)
  assert.equal((await remove(identity.id, { cookie, origin: 'https://evil.example' })).status, 403)
  assert.equal((await remove('invalid', { token: admin.token })).status, 400)
  assert.equal((await remove(randomUUID(), { token: admin.token })).status, 404)
  const body = { userId: other.id, issuer: identity.issuer, subject: identity.subject }
  assert.equal((await f.request(path, { method: 'POST', token: target.token, body })).status, 403)
  assert.equal((await f.request(path, { method: 'POST', token: admin.token, body })).status, 404)
  assert.equal((await f.request(path, { method: 'POST', token: admin.token, body: { ...body, userId: admin.id } })).status, 409)
  for (const invalid of [
    { userId: 'invalid' }, { userId: randomUUID() }, { subject: '' }, { subject: 'x'.repeat(256) }, { subject: 'bad\nsubject' },
    { issuer: 'https://user:secret@issuer.example.test' }, { issuer: 'https://issuer.example.test/?secret=secret' },
    { issuer: `https://issuer.example.test/${'x'.repeat(2048)}` }, { issuer: 'http://issuer.example.test' }, { isAdmin: true },
  ]) {
    const response = await f.request(path, { method: 'POST', token: admin.token, body: { ...body, userId: admin.id, subject: 'new-subject', ...invalid } })
    assert.equal(response.status, 'userId' in invalid && invalid.userId !== 'invalid' ? 404 : 400, JSON.stringify(invalid))
  }
  assert.deepEqual(snapshot(f), before)
  f.db.prepare('UPDATE users SET isAdmin=0 WHERE id=?').run(admin.id)
  assert.equal((await f.request(path, { cookie })).status, 403)
  assert.equal((await remove(identity.id, { cookie, origin: f.base })).status, 403)
  assert.equal((await f.request(path, { method: 'POST', token: admin.token, body })).status, 403)
})

test('OIDC unlink revokes every session and bearer token atomically, preserves other accounts and audits only safe details', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t)
  const admin = f.user(true); const target = f.user(); const other = f.user()
  const identity = await link(f, admin.token, target.id)
  const otherIdentity = await link(f, admin.token, other.id)
  const cookies = [await login(f, target), await login(f, target)]
  const tokens = [target.token]
  for (const name of ['Automation', 'MCP']) {
    const response = await f.request('/auth/tokens', { method: 'POST', cookie: cookies[0], origin: f.base, body: { name } })
    assert.equal(response.status, 201)
    tokens.push((await response.json() as { token: string }).token)
  }
  const now = new Date().toISOString()
  f.db.prepare('INSERT INTO sessions (id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)').run(randomUUID(), target.id, 'expired-session-hash', '2000-01-01T00:00:00.000Z', now)
  f.db.prepare('INSERT INTO tokens (id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)').run(randomUUID(), target.id, 'Expired', 'expired-token-hash', '2000-01-01T00:00:00.000Z', now)
  const before = snapshot(f)
  const response = await f.request(`${path}/${identity.id}`, { method: 'DELETE', token: admin.token })
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), { success: true })
  assert.deepEqual(f.db.prepare('SELECT * FROM sessions WHERE userId=?').all(target.id), [])
  assert.deepEqual(f.db.prepare('SELECT * FROM tokens WHERE userId=?').all(target.id), [])
  assert.deepEqual(snapshot(f).users, before.users)
  assert.deepEqual(await (await f.request(path, { token: admin.token })).json(), [otherIdentity])
  for (const cookie of cookies) assert.equal((await f.request('/auth/me', { cookie })).status, 401)
  for (const token of tokens) assert.equal((await f.request('/auth/me', { token })).status, 401)
  assert.equal((await f.request('/auth/me', { token: other.token })).status, 200)
  const audit = f.db.prepare("SELECT actorId,workspaceId,resourceId,details FROM audit_logs WHERE action='admin.oidc.unlink'").all()
  assert.deepEqual(audit, [{ actorId: admin.id, workspaceId: null, resourceId: identity.id,
    details: JSON.stringify({ userId: target.id, revokedSessions: 3, revokedTokens: 4 }) }])
  const text = JSON.stringify(audit)
  for (const secret of [identity.issuer, identity.subject, password, passwordHash, ...tokens, ...cookies]) {
    assert.equal(text.includes(secret), false)
    assert.equal(f.output().includes(secret), false)
  }
  const after = snapshot(f)
  assert.equal((await f.request(`${path}/${identity.id}`, { method: 'DELETE', token: admin.token })).status, 404)
  assert.deepEqual(snapshot(f), after)
  assert.equal((await f.request('/auth/me', { cookie: await login(f, target) })).status, 200)
  assert.deepEqual(f.db.pragma('foreign_key_check'), [])
})

test('passwordless recovery requires another identity for the configured issuer, even when disabled', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t, { OIDC_ISSUER: 'https://issuer.example.test', OIDC_CLIENT_ID: 'hopya' })
  const admin = f.user(true); const target = f.user()
  const identity = await link(f, admin.token, target.id)
  const ownIdentity = await link(f, admin.token, admin.id)
  for (const disabled of [0, 1]) {
    f.db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled, target.id)
    const before = snapshot(f)
    const response = await f.request(`${path}/${identity.id}`, { method: 'DELETE', token: admin.token })
    assert.equal(response.status, 409)
    assert.match((await response.json() as { error: string }).error, /last login method.*recovery/)
    assert.deepEqual(snapshot(f), before)
  }
  const before = snapshot(f)
  assert.equal((await f.request(`${path}/${ownIdentity.id}`, { method: 'DELETE', token: admin.token })).status, 409)
  assert.deepEqual(snapshot(f), before)
  f.db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(target.id)
  const inactive = await link(f, admin.token, target.id, 'inactive-subject', 'https://recovery.example.test')
  const withInactive = snapshot(f)
  assert.equal((await f.request(`${path}/${identity.id}`, { method: 'DELETE', token: admin.token })).status, 409)
  assert.deepEqual(snapshot(f), withInactive)
  const recovery = await link(f, admin.token, target.id, 'recovery-subject')
  f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(target.id)
  assert.equal((await f.request(`${path}/${identity.id}`, { method: 'DELETE', token: admin.token })).status, 200)
  assert.deepEqual(await (await f.request(`${path}?userId=${target.id}`, { token: admin.token })).json(), [inactive, recovery])
  assert.deepEqual(f.db.prepare('SELECT id FROM tokens WHERE userId=?').all(target.id), [])
})

test('multiple identities cannot bypass passwordless recovery protection when SSO is not configured', async (t) => {
  const f = await integrationServer(t)
  const admin = f.user(true); const target = f.user()
  const identity = await link(f, admin.token, target.id)
  await link(f, admin.token, target.id, 'second-subject')
  const before = snapshot(f)
  assert.equal((await f.request(`${path}/${identity.id}`, { method: 'DELETE', token: admin.token })).status, 409)
  assert.deepEqual(snapshot(f), before)
})

test('own password-backed unlink withdraws the current admin cookie and all tokens on the next request', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t)
  const admin = f.user(true)
  const identity = await link(f, admin.token, admin.id)
  const cookie = await login(f, admin)
  const response = await f.request(`${path}/${identity.id}`, { method: 'DELETE', cookie, origin: f.base })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true })
  assert.equal((await f.request('/auth/me', { cookie })).status, 401)
  assert.equal((await f.request(path, { cookie })).status, 401)
  assert.equal((await f.request('/auth/me', { token: admin.token })).status, 401)
  assert.equal((await f.request(path, { cookie: await login(f, admin) })).status, 200)
})

test('OIDC unlink rolls back identity, credentials and audit when the audit insertion fails', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t)
  const admin = f.user(true); const target = f.user()
  const identity = await link(f, admin.token, target.id)
  const cookie = await login(f, target)
  const before = snapshot(f)
  f.db.exec("CREATE TRIGGER fail_oidc_audit BEFORE INSERT ON audit_logs WHEN NEW.action='admin.oidc.unlink' BEGIN SELECT RAISE(ABORT, 'private audit failure'); END")
  try {
    const response = await f.request(`${path}/${identity.id}`, { method: 'DELETE', token: admin.token })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'Operation conflicts with existing data' })
  } finally {
    f.db.exec('DROP TRIGGER fail_oidc_audit')
  }
  assert.deepEqual(snapshot(f), before)
  assert.equal((await f.request('/auth/me', { cookie })).status, 200)
  assert.equal((await f.request('/auth/me', { token: target.token })).status, 200)
  assert.equal(f.output().includes('private audit failure'), false)
})

async function delayedProvider(t: TestContext) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>()
  const state = { subject: 'linked-subject', email: 'linked@example.test', onToken: async () => {} }
  let issuer = ''
  const server = createServer(async (request, response) => {
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    try {
      if (request.url === '/.well-known/openid-configuration') {
        json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'] })
      } else if (request.url === '/jwks') {
        json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'oidc-admin-test', use: 'sig', alg: 'RS256' }] })
      } else if (request.url === '/token') {
        const chunks = []; for await (const chunk of request) chunks.push(chunk)
        const body = new URLSearchParams(Buffer.concat(chunks).toString())
        const code = codes.get(body.get('code')!)
        codes.delete(body.get('code')!)
        assert.ok(code)
        assert.equal(body.get('client_id'), 'oidc-admin-client')
        assert.equal(body.get('client_secret'), 'private-admin-provider-secret')
        assert.equal(body.get('grant_type'), 'authorization_code')
        assert.equal(body.get('redirect_uri'), code.redirect)
        assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), code.challenge)
        await state.onToken()
        const now = Math.floor(Date.now() / 1000)
        const claims = { iss: issuer, sub: state.subject, aud: 'oidc-admin-client', nonce: code.nonce, iat: now, exp: now + 300,
          email: state.email, email_verified: true, name: 'Linked user' }
        const input = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'oidc-admin-test' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
        json({ token_type: 'Bearer', access_token: 'private-admin-provider-token', id_token: `${input}.${sign('RSA-SHA256', Buffer.from(input), keys.privateKey).toString('base64url')}` })
      } else json({ error: 'not_found' }, 404)
    } catch (error) {
      json({ error: 'server_error' }, 500)
      throw error
    }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  t.after(() => { server.closeAllConnections(); server.close() })
  return {
    issuer, state,
    env: { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'oidc-admin-client', OIDC_CLIENT_SECRET: 'private-admin-provider-secret', OIDC_ALLOW_INSECURE_HTTP: 'true' },
    async signIn(f: Fixture) {
      const start = await f.request('/auth/sso')
      assert.equal(start.status, 302, await start.clone().text())
      const authorize = new URL(start.headers.get('location')!)
      const code = randomUUID()
      const redirect = authorize.searchParams.get('redirect_uri')!
      codes.set(code, { nonce: authorize.searchParams.get('nonce')!, challenge: authorize.searchParams.get('code_challenge')!, redirect })
      const callback = new URL(redirect)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', authorize.searchParams.get('state')!)
      return fetch(callback, { headers: { cookie: responseCookie(start) }, redirect: 'manual' })
    },
  }
}

test('unlink during a verified token exchange cannot restore a session or JIT identity, including changed email', { timeout: 120000 }, async (t) => {
  for (const scenario of ['closed', 'jit-same-email', 'jit-changed-email', 'relinked', 'audit-rollback', 'unrelated-subject', 'unrelated-issuer']) {
    await t.test(scenario, async (t) => {
      const p = await delayedProvider(t)
      const f = await integrationServer(t, { ...p.env, OIDC_AUTO_PROVISION: scenario.startsWith('jit-') ? 'true' : 'false' })
      const admin = f.user(true); const target = f.user(false, p.state.email)
      const identity = await link(f, admin.token, target.id, p.state.subject, p.issuer)
      const cookie = await login(f, target)
      const control = ['unrelated-subject', 'unrelated-issuer'].includes(scenario)
      const removed = control ? await link(f, admin.token, target.id, scenario === 'unrelated-subject' ? 'other-subject' : p.state.subject,
        scenario === 'unrelated-issuer' ? 'https://other.example.test' : p.issuer) : identity
      if (scenario === 'jit-changed-email') p.state.email = 'changed@example.test'
      const before = snapshot(f)
      p.state.onToken = async () => {
        if (scenario === 'audit-rollback') f.db.exec("CREATE TRIGGER fail_oidc_audit BEFORE INSERT ON audit_logs WHEN NEW.action='admin.oidc.unlink' BEGIN SELECT RAISE(ABORT, 'audit failure'); END")
        try {
          const response = await f.request(`${path}/${removed.id}`, { method: 'DELETE', token: admin.token })
          assert.equal(response.status, scenario === 'audit-rollback' ? 409 : 200, await response.clone().text())
          if (scenario === 'audit-rollback') assert.deepEqual(snapshot(f), before)
          else assert.deepEqual(f.db.prepare('SELECT id FROM sessions WHERE userId=?').all(target.id), [])
        } finally {
          if (scenario === 'audit-rollback') f.db.exec('DROP TRIGGER fail_oidc_audit')
        }
        if (scenario === 'relinked') await link(f, admin.token, admin.id, p.state.subject, p.issuer)
      }
      const response = await p.signIn(f)
      const allowed = scenario === 'audit-rollback' || control
      assert.equal(response.status, allowed ? 302 : 403, await response.clone().text())
      assert.deepEqual(snapshot(f).users, before.users)
      if (allowed) {
        assert.equal((await (await f.request('/auth/me', { cookie: responseCookie(response) })).json() as { id: string }).id, target.id)
      } else {
        assert.deepEqual(await response.json(), { error: 'SSO identity was unlinked; start a new sign-in' })
        assert.equal(response.headers.getSetCookie().some((value) => value.startsWith('hopya_session=')), false)
        assert.deepEqual(f.db.prepare('SELECT id FROM sessions').all(), [])
        assert.deepEqual(f.db.prepare("SELECT id FROM audit_logs WHERE action IN ('auth.sso.login','auth.sso.provision')").all(), [])
        if (scenario !== 'relinked') assert.deepEqual(f.db.prepare('SELECT id FROM oidc_identities').all(), [])
        assert.equal((await f.request('/auth/me', { cookie })).status, 401)
        assert.equal((await f.request('/auth/me', { token: target.token })).status, 401)
      }
      p.state.onToken = async () => {}
      const fresh = await p.signIn(f)
      assert.equal(fresh.status, scenario === 'closed' ? 403 : scenario === 'jit-same-email' ? 409 : 302, await fresh.clone().text())
      if (scenario === 'jit-changed-email') {
        const user = await (await f.request('/auth/me', { cookie: responseCookie(fresh) })).json() as { id: string; isAdmin: boolean }
        assert.notEqual(user.id, target.id)
        assert.equal(user.isAdmin, false)
      }
      const audits = JSON.stringify(snapshot(f).audits)
      for (const secret of ['private-admin-provider-secret', 'private-admin-provider-token', p.state.subject, passwordHash]) {
        assert.equal(audits.includes(secret), false)
        assert.equal(f.output().includes(secret), false)
      }
      assert.deepEqual(f.db.pragma('foreign_key_check'), [])
    })
  }
})
