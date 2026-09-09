import { test } from './japa.js'
import assert from 'node:assert/strict'
import { integrationServer } from './storage-sso-fixture.js'

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
