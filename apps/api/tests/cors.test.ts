import { test } from './japa.js'
import assert from 'node:assert/strict'
import { integrationServer } from './storage-sso-fixture.js'

test('ALLOW_ANY_ORIGIN opens CORS for dev while the default still rejects foreign origins', async (t) => {
  const evil = 'https://evil.example'
  const open = await integrationServer(t, { ALLOW_ANY_ORIGIN: 'true' })
  // Foreign-origin mutation passes the origin check (400 = reached validation).
  const login = await open.request('/auth/login', { method: 'POST', origin: evil, body: {} })
  assert.equal(login.status, 400)
  assert.equal(login.headers.get('access-control-allow-origin'), evil)
  assert.equal(login.headers.get('access-control-allow-credentials'), 'true')
  // Preflight is answered without routing.
  const preflight = await open.request('/auth/login', {
    method: 'OPTIONS', origin: evil, headers: { 'access-control-request-method': 'POST' },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), evil)
  assert.ok((preflight.headers.get('access-control-allow-methods') ?? '').includes('POST'))
  // Reads carry CORS headers too.
  const config = await open.request('/config', { headers: { origin: evil } })
  assert.equal(config.status, 200)
  assert.equal(config.headers.get('access-control-allow-origin'), evil)

  // Control: without the flag the same request is rejected before validation.
  const locked = await integrationServer(t)
  assert.equal((await locked.request('/auth/login', { method: 'POST', origin: evil, body: {} })).status, 403)
})
