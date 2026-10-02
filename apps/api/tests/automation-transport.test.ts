import { test } from './japa.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createSmtpServer } from 'node:net'
import { Resolver } from 'node:dns/promises'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Fiber } from 'effect'
import { Ignitor } from '@adonisjs/core'
import { pinnedRequestEffect, resolvePinnedDestinationEffect } from '../app/pinned_http.js'
import { integrationServer } from './storage-sso-fixture.js'
import type { TestContext } from './japa.js'

async function boot(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'hopya-transport-')), previous = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  const root = new URL('../', import.meta.url)
  const app = new Ignitor(root, { importer: (path) => import(path.startsWith('.') ? new URL(path, root).href : path) }).createApp('test')
  t.after(async () => { await app.terminate(); rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous })
  await app.init(); await app.boot()
}

test('hostname requests use a fresh pinned socket and preserve the destination Host', async (t) => {
  const server = createServer((request, response) => response.end(request.headers.host))
  let connections = 0
  server.on('connection', () => { connections++ })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = (server.address() as { port: number }).port
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await Effect.runPromise(Effect.result(pinnedRequestEffect({ url: new URL(`http://unresolvable.invalid:${port}/`), address: '127.0.0.1', family: 4 }, {})))
    assert.equal(result._tag, 'Success')
    if (result._tag === 'Success') assert.equal(result.success.body.toString(), `unresolvable.invalid:${port}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(connections, 2)
  const invalid = await Effect.runPromise(Effect.result(pinnedRequestEffect({ url: new URL(`http://127.0.0.1:${port}/`), address: '127.0.0.1', family: 4 }, { headers: { 'secret-invalid-header\n': 'private-token' } })))
  assert.equal(invalid._tag, 'Failure', 'native header exceptions must be typed failures, not defects')
  if (invalid._tag === 'Failure') assert.equal(invalid.failure.message, 'Outbound request configuration is invalid')
  assert.equal(connections, 2, 'invalid headers must not open an outbound socket')
})

test('stalled requests close safely after timeout or Effect interruption', async (t) => {
  const server = createServer(() => {})
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const destination = { url: new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`), address: '127.0.0.1', family: 4 as const }
  for (const interrupt of [false, true]) {
    const received = once(server, 'request')
    const fiber = Effect.runFork(Effect.result(pinnedRequestEffect(destination, { timeoutMs: interrupt ? 5000 : 100 })))
    const [request] = await received
    const closed = once(request.socket, 'close')
    if (interrupt) await Effect.runPromise(Fiber.interrupt(fiber))
    else {
      const result = await Effect.runPromise(Fiber.join(fiber))
      assert.equal(result._tag, 'Failure')
      if (result._tag === 'Failure') assert.equal(result.failure.message, 'Outbound request timed out')
    }
    await closed
    await new Promise((resolve) => setImmediate(resolve))
  }
})

test('credential output redaction covers JSON escapes and plaintext without changing unrelated JSON', async (t) => {
  await boot(t)
  const { redactCredentialOutput } = await import('../app/automation_credentials.js')
  const secret = 'quote"back\\slash/value'
  const body = JSON.stringify({ echo: secret, nested: [secret], [secret]: 'public', count: 2 }, null, 2)
  assert.deepEqual(JSON.parse(redactCredentialOutput(body, [secret])), { echo: '[REDACTED]', nested: ['[REDACTED]'], '[REDACTED]': 'public', count: 2 })
  const escaped = body.replaceAll('quote', '\\u0071uote').replaceAll('/value', '\\/value')
  assert.deepEqual(JSON.parse(redactCredentialOutput(escaped, [secret])), JSON.parse(redactCredentialOutput(body, [secret])))
  assert.equal(redactCredentialOutput('plain:' + secret, [secret]), 'plain:[REDACTED]')
  assert.equal(redactCredentialOutput('fragment:' + JSON.stringify(secret).slice(1, -1), [secret]), 'fragment:[REDACTED]')
  assert.equal(redactCredentialOutput(body, ['unrelated', '']), body)
})

test('interrupted DNS resolution cancels its owned resolver before returning', async (t) => {
  let queries = 0, cancelled = 0
  const stalled = () => { queries++; return new Promise<never>(() => {}) }
  t.mock.method(Resolver.prototype, 'resolve4', stalled)
  t.mock.method(Resolver.prototype, 'resolve6', stalled)
  t.mock.method(Resolver.prototype, 'cancel', () => { cancelled++ })
  const fiber = Effect.runFork(resolvePinnedDestinationEffect('https://stalled.example.test'))
  assert.equal(queries, 2, 'IPv4 and IPv6 checks start together')
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.equal(cancelled, 1)
})

test('SMTP interruption closes real sockets and releases permits for subsequent delivery', async (t) => {
  await boot(t)
  const previous = process.env.SMTP_URL
  const server = createSmtpServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  process.env.SMTP_URL = `smtp://127.0.0.1:${(server.address() as { port: number }).port}`
  t.after(() => { server.close(); if (previous === undefined) delete process.env.SMTP_URL; else process.env.SMTP_URL = previous })
  const { sendMailEffect } = await import('../app/mail.js')
  for (let attempt = 0; attempt < 3; attempt++) {
    const connected = once(server, 'connection')
    const fiber = Effect.runFork(sendMailEffect({ to: 'recipient@example.test', subject: 'Cancellation', text: 'fixture' }))
    const [socket] = await connected
    const closed = once(socket, 'close')
    await Effect.runPromise(Fiber.interrupt(fiber))
    await closed
  }
  let accepted = ''
  server.once('connection', (socket) => {
    socket.setEncoding('utf8'); socket.write('220 localhost fixture\r\n')
    let buffered = '', data = false
    socket.on('data', (chunk: string) => {
      buffered += chunk
      while (buffered.includes('\r\n')) {
        const end = buffered.indexOf('\r\n'), line = buffered.slice(0, end); buffered = buffered.slice(end + 2)
        if (data && line !== '.') { accepted += line + '\n'; continue }
        if (data) { data = false; socket.write('250 accepted\r\n') }
        else if (line === 'DATA') { data = true; socket.write('354 continue\r\n') }
        else socket.write('250 localhost\r\n')
      }
    })
  })
  const sent = await Effect.runPromise(sendMailEffect({ to: 'recipient@example.test', subject: 'Recovered permit', text: 'fixture delivered' }))
  assert.ok(sent.messageId)
  assert.match(accepted, /fixture delivered/)
})

test('OAuth callbacks accept bounded extensions and reject malformed extensions before consuming state', async (t) => {
  let exchanges = 0
  const provider = createServer((_request, response) => { exchanges++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 })) })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening')
  t.after(() => { provider.closeAllConnections(); provider.close() })
  const origin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const api = await integrationServer(t, { AUTOMATION_NETWORK_EXCEPTIONS: origin, AUTOMATION_KEYRING: JSON.stringify({ active: 'test', keys: { test: randomBytes(32).toString('base64') } }) })
  const owner = await api.user(true)
  const post = async (path: string, body: unknown) => {
    const response = await api.request(path, { method: 'POST', token: owner.token, body })
    assert.ok(response.ok, await response.clone().text())
    return response.json() as Promise<{ id: string; authorizationUrl: string }>
  }
  const workspace = await post('/workspaces', { name: 'OAuth callback' }), base = `/workspaces/${workspace.id}/automations/credentials`
  const credential = await post(base, { name: 'OAuth', type: 'oauth2', origin, secret: { authorizationUrl: `${origin}/authorize`, tokenUrl: `${origin}/token`, clientId: 'client' } })
  const started = await post(`${base}/${credential.id}/oauth/start`, {})
  const state = new URL(started.authorizationUrl).searchParams.get('state')!
  const callback = `${base}/${credential.id}/oauth/callback?state=${state}&code=fixture-code`
  for (const extension of [`scope=${'x'.repeat(4001)}`, 'scope=a&scope=b', 'scope[nested]=a', Array.from({ length: 19 }, (_, index) => `extra${index}=x`).join('&')]) {
    assert.equal((await api.request(`${callback}&${extension}`, { token: owner.token })).status, 400)
  }
  assert.equal(exchanges, 0)
  const extended = `${callback}&scope=tasks&iss=${encodeURIComponent('https://issuer.example/tenant')}&session_state=provider-state`
  assert.equal((await api.request(extended, { token: owner.token })).status, 302)
  assert.equal(exchanges, 1)
  assert.equal((await api.request(extended, { token: owner.token })).status, 400)
})
