import { test } from 'node:test'
import assert from 'node:assert/strict'
import { integrationServer } from './storage-sso-fixture.js'
import { randomBytes, scryptSync } from 'node:crypto'

test('one trusted proxy hop isolates client limits without trusting a longer supplied chain', async (t) => {
  const api = await integrationServer(t, { TRUST_PROXY_HOPS: '1' })
  const attempt = (forwarded: string, email = 'target@example.test') => api.request('/auth/login', {
    method: 'POST', origin: api.base, headers: { 'x-forwarded-for': forwarded }, body: { email, password: 'wrong' },
  })
  for (let i = 0; i < 10; i++) assert.equal((await attempt('192.0.2.10')).status, 401)
  assert.equal((await attempt('192.0.2.10')).status, 429)
  assert.equal((await attempt('192.0.2.11')).status, 401)
  assert.equal((await attempt('192.0.2.11, 192.0.2.10')).status, 429, 'Only the nearest forwarded address is trusted')
  assert.equal((await attempt('192.0.2.10', 'another@example.test')).status, 401, 'Shared NAT must not block unrelated accounts')
})

test('arbitrary login emails cannot exhaust unrelated IPs or other authentication categories', { timeout: 60000 }, async (t) => {
  const api = await integrationServer(t, { TRUST_PROXY_HOPS: '1' })
  const statuses = new Map<number, number>()
  for (let index = 0; index < 10100; index++) {
    const response = await api.request('/auth/login', { method: 'POST', origin: api.base,
      headers: { 'x-forwarded-for': '192.0.2.60' }, body: { email: `flood-${index}@example.test` } })
    statuses.set(response.status, (statuses.get(response.status) || 0) + 1)
    if (response.status === 429) assert.ok(Number(response.headers.get('retry-after')) > 0)
    await response.arrayBuffer()
  }
  const user = api.user(true)
  const password = 'legitimate login after invalid flood'
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')
  api.db.prepare('UPDATE users SET passwordHash=? WHERE id=?').run(`scrypt$32768$8$1$${salt}$${hash}`, user.id)
  assert.equal((await api.request('/auth/login', { method: 'POST', origin: api.base, headers: { 'x-forwarded-for': '192.0.2.61' }, body: { email: user.email, password } })).status, 200)
  assert.equal((await api.request('/auth/register', { method: 'POST', origin: api.base, headers: { 'x-forwarded-for': '192.0.2.60' }, body: {} })).status, 403)
  assert.equal((await api.request('/auth/sso', { headers: { 'x-forwarded-for': '192.0.2.60' } })).status, 503)
  assert.deepEqual(Object.fromEntries(statuses), { 400: 100, 429: 10000 })
})
