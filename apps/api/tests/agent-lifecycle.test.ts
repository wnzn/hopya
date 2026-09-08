import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { integrationServer } from './storage-sso-fixture.js'

type Api = Awaited<ReturnType<typeof integrationServer>>
type Auth = { token?: string; cookie?: string }
type Context = ReturnType<Api['user']> & { wid: string }
type Outcome = { kind: 'response'; status: number; headers: IncomingHttpHeaders; body: string }
  | { kind: 'closed'; reason: string }
type ProviderCall = {
  message: string; response: ServerResponse; payload: string; partial: boolean
  receivedAt: number; socketClosedAt?: number
}
const providerError = 'AI provider failed or returned an invalid answer. No tasks were changed.'
const answer = (message: string) => ({ reply: `Review only: ${message}`, proposal: { title: `Unconfirmed: ${message}` } })

async function until(predicate: () => boolean, message: string, milliseconds = 3000) {
  const deadline = performance.now() + milliseconds
  while (!predicate() && performance.now() < deadline) await delay(20)
  assert.ok(predicate(), message)
}

async function fixture(t: TestContext) {
  const calls: ProviderCall[] = []
  const sockets = new Set<Socket>()
  const clients = new Set<() => void>()
  const providerErrors: string[] = []
  const provider = createServer((req, res) => {
    let raw = ''
    req.on('error', () => {})
    res.on('error', () => {})
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
      if (raw.length > 128 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        assert.equal(req.url, '/v1/chat/completions')
        assert.equal(req.headers.authorization, undefined, 'The local provider needs no credential')
        const body = JSON.parse(raw) as { messages: { role: string; content: string }[] }
        const { message } = JSON.parse(body.messages.find((entry) => entry.role === 'user')!.content) as { message: string }
        assert.equal(typeof message, 'string')
        const call: ProviderCall = { message, response: res, partial: false, receivedAt: performance.now(),
          payload: JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(message)) } }] }) }
        req.socket.once('close', () => { call.socketClosedAt = performance.now() })
        calls.push(call)
      } catch (error) {
        providerErrors.push(String(error))
        res.writeHead(500).end('Invalid test provider request')
      }
    })
  })
  provider.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  // Register ownership before listening/starting Adonis, including assertion failures.
  t.after(async () => {
    for (const close of clients) close()
    for (const socket of sockets) socket.destroy()
    provider.closeAllConnections()
    await new Promise<void>((resolve) => provider.close(() => resolve()))
  })
  provider.listen(0, '127.0.0.1')
  await once(provider, 'listening', { signal: AbortSignal.timeout(3000) })
  const api = await integrationServer(t, { AI_PROVIDER: 'openai-compatible', AI_MODEL: 'local-lifecycle-fixture',
    AI_API_KEY: '', AI_BASE_URL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1` })

  function send(path: string, auth: Auth, body: unknown, milliseconds = 5000) {
    const raw = JSON.stringify(body)
    let outcome: Outcome | undefined
    let finish!: (value: Outcome) => void
    const result = new Promise<Outcome>((resolve) => { finish = resolve })
    let response: import('node:http').IncomingMessage | undefined
    let sent = false
    const req = request(`${api.base}/api/v1${path}`, { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), origin: api.base,
        ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}), ...(auth.cookie ? { cookie: auth.cookie } : {}) } })
    const settle = (value: Outcome) => {
      if (outcome) return
      outcome = value
      clearTimeout(timer)
      finish(value)
    }
    const close = () => { response?.destroy(); req.destroy() }
    const timer = setTimeout(() => {
      settle({ kind: 'closed', reason: 'Test client deadline exceeded' })
      close()
    }, milliseconds)
    clients.add(close)
    req.once('finish', () => { sent = true })
    req.on('error', (error) => settle({ kind: 'closed', reason: error.message }))
    req.once('close', () => {
      settle({ kind: 'closed', reason: 'Request closed without a complete response' })
      clients.delete(close)
    })
    req.once('response', (res) => {
      response = res
      const chunks: Buffer[] = []; let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 512 * 1024) {
          settle({ kind: 'closed', reason: 'Test response size exceeded' }); close()
        } else chunks.push(chunk)
      })
      res.on('error', (error) => settle({ kind: 'closed', reason: error.message }))
      res.once('end', () => settle(res.complete
        ? { kind: 'response', status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }
        : { kind: 'closed', reason: 'Incomplete HTTP response' }))
      res.once('close', () => settle({ kind: 'closed', reason: 'Response closed before completion' }))
    })
    req.end(raw)
    return { result, close, get sent() { return sent && req.writableFinished }, get outcome() { return outcome } }
  }

  async function context(): Promise<Context> {
    const user = api.user()
    const post = async (path: string, body: unknown) => JSON.parse((await received(send(path, user, body), 201)).body) as { id: string }
    const workspace = await post('/workspaces', { name: 'Agent lifecycle' })
    const project = await post(`/workspaces/${workspace.id}/nodes`, { name: 'Project', kind: 'project' })
    const list = await post(`/workspaces/${workspace.id}/nodes`, { name: 'List', kind: 'list', parentId: project.id })
    await post(`/workspaces/${workspace.id}/items`, { title: 'Must remain unchanged', nodeId: list.id })
    return { ...user, wid: workspace.id }
  }
  const ask = (user: { wid: string } & Auth, message: string = randomUUID()) =>
    send(`/workspaces/${user.wid}/agent`, user, { message }, 55000)
  function pending(user: { wid: string } & Auth, message: string = randomUUID()) {
    const client = send(`/workspaces/${user.wid}/agent`, user, { message }, 55000)
    return { client, message }
  }
  async function reached(message: string) {
    await until(() => calls.some((call) => call.message === message) || providerErrors.length > 0,
      `Provider did not receive ${message}`)
    assert.deepEqual(providerErrors, [])
    return calls.find((call) => call.message === message)!
  }
  function partial(call: ProviderCall) {
    assert.equal(call.partial, false)
    call.partial = true
    call.response.writeHead(200, { 'content-type': 'application/json' })
    call.response.write(call.payload.slice(0, 20))
  }
  function complete(call: ProviderCall, error = false) {
    if (error) call.response.writeHead(503).end('PRIVATE-provider-error-not-for-client')
    else {
      if (!call.partial) call.response.setHeader('content-type', 'application/json')
      call.response.end(call.partial ? call.payload.slice(20) : call.payload)
    }
  }
  function snapshot(all = false) {
    const tables = all ? ['users', 'tokens', 'sessions', 'workspaces', 'roles', 'memberships', 'nodes', 'fields', 'items', 'audit_logs']
      : ['nodes', 'fields', 'items']
    return tables.map((table) => api.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  }
  function audits(user: Context) {
    return api.db.prepare("SELECT * FROM audit_logs WHERE actorId=? AND workspaceId=? AND action='agent.answer'").all(user.id, user.wid)
  }
  return { api, calls, send, context, ask, pending, reached, partial, complete, snapshot, audits }
}

async function received(client: { result: Promise<Outcome> }, status: number) {
  const result = await client.result
  assert.equal(result.kind, 'response', JSON.stringify(result))
  assert.ok(result.kind === 'response')
  assert.equal(result.status, status, result.body)
  return result
}

test('agent global admission: four users/workspaces, fifth Retry-After, denied calls and reusable success/error slots', { timeout: 30000 }, async (t) => {
  const f = await fixture(t)
  const users = await Promise.all(Array.from({ length: 5 }, () => f.context()))
  const before = f.snapshot()
  const requests = users.slice(0, 4).map((user) => f.pending(user))
  const calls = await Promise.all(requests.map(({ message }) => f.reached(message)))
  assert.equal(f.calls.length, 4)
  for (const { client } of requests) assert.equal(client.outcome, undefined)

  const outsider = f.api.user()
  await received(f.ask({ ...outsider, wid: users[0].wid }), 403)
  const busy = await received(f.ask(users[4]), 429)
  assert.match(busy.body, /Assistant is busy/)
  assert.equal(f.calls.length, 4, 'Neither forbidden nor capacity-denied requests may reach the provider')

  f.complete(calls[0])
  await received(requests[0].client, 200)
  const replacement = f.pending(users[4])
  const replacementCall = await f.reached(replacement.message)
  f.complete(calls[1], true)
  const failed = await received(requests[1].client, 502)
  assert.deepEqual(JSON.parse(failed.body), { error: providerError })
  const afterError = f.pending(users[1])
  const afterErrorCall = await f.reached(afterError.message)
  for (const call of [calls[2], calls[3], replacementCall, afterErrorCall]) f.complete(call)
  for (const client of [requests[2].client, requests[3].client, replacement.client, afterError.client]) await received(client, 200)
  assert.equal(f.calls.length, 6)
  assert.deepEqual(users.map((user) => f.audits(user).length), [1, 1, 1, 1, 1])
  assert.deepEqual(f.snapshot(), before)
  assert.match(String(busy.headers['retry-after'] ?? ''), /^[1-9]\d*$/, 'Busy admission must advertise a positive Retry-After')
})

test('agent actual 45s deadline covers concurrent headers-stall and partial-body-stall and closes provider sockets', { timeout: 70000 }, async (t) => {
  const f = await fixture(t)
  const users = await Promise.all(Array.from({ length: 4 }, () => f.context()))
  const before = f.snapshot(true)
  const tasksBefore = f.snapshot()
  const started = performance.now()
  const requests = users.slice(0, 2).map((user) => f.pending(user))
  const calls = await Promise.all(requests.map(({ message }) => f.reached(message)))
  f.partial(calls[1])
  await Promise.all(requests.map(async ({ client }, index) => {
    const result = await received(client, 502)
    const elapsed = performance.now() - calls[index].receivedAt
    assert.ok(elapsed >= 44000 && performance.now() - started < 53000, `Expected a real 45s deadline, observed ${elapsed}ms`)
    assert.deepEqual(JSON.parse(result.body), { error: providerError })
  }))
  await until(() => calls.every((call) => call.socketClosedAt !== undefined), 'Both timed-out provider sockets must close')
  assert.deepEqual(f.snapshot(true), before, 'Timeouts must not audit an answer or mutate any application rows')
  // Refill all four slots: a lone successful request would not prove both deadlines released admission.
  const retries = users.map((user) => f.pending(user))
  const retryCalls = await Promise.all(retries.map(({ message }) => f.reached(message)))
  for (const call of retryCalls) f.complete(call)
  for (const { client } of retries) await received(client, 200)
  assert.deepEqual(users.map((user) => f.audits(user).length), [1, 1, 1, 1])
  assert.deepEqual(f.snapshot(), tasksBefore)
})

for (const phase of ['before response headers', 'during partial provider body']) {
  test(`agent client disconnect ${phase} cancels promptly, releases its slot and cannot succeed or audit`, { timeout: 25000 }, async (t) => {
    const f = await fixture(t)
    const users = await Promise.all(Array.from({ length: 5 }, () => f.context()))
    const before = f.snapshot()
    const requests = users.slice(0, 4).map((user) => f.pending(user))
    const calls = await Promise.all(requests.map(({ message }) => f.reached(message)))
    const abandoned = requests[0].client
    assert.ok(abandoned.sent, 'The original POST body must be fully sent, not aborted during upload')
    if (phase === 'during partial provider body') { f.partial(calls[0]); await delay(150) }
    assert.equal(abandoned.outcome, undefined, 'Adonis must still be waiting for the provider')
    const disconnectedAt = performance.now()
    abandoned.close()
    assert.equal((await abandoned.result).kind, 'closed', 'A disconnected request cannot return a complete success')
    await until(() => calls[0].socketClosedAt !== undefined, `Provider socket stayed open after client disconnect ${phase}`)
    assert.ok(calls[0].socketClosedAt! - disconnectedAt < 3000, 'Provider cancellation must propagate within 3 seconds')
    assert.deepEqual(f.audits(users[0]), [])

    const replacement = f.pending(users[4])
    const replacementCall = await f.reached(replacement.message)
    assert.equal(f.calls.length, 5, 'Cancelled slot must be reusable while the other three remain pending')
    assert.ok(calls.slice(1).every((call) => call.socketClosedAt === undefined))
    // Even a late provider completion must never resurrect an answer for the closed request.
    calls[0].response.end(calls[0].partial ? calls[0].payload.slice(20) : calls[0].payload)
    for (const call of [...calls.slice(1), replacementCall]) f.complete(call)
    for (const { client } of [...requests.slice(1), replacement]) await received(client, 200)
    assert.equal((await abandoned.result).kind, 'closed')
    assert.deepEqual(users.map((user) => f.audits(user).length), [0, 1, 1, 1, 1])
    assert.deepEqual(f.snapshot(), before)
  })
}

test('agent normal POST completion does not cancel a long provider wait', { timeout: 20000 }, async (t) => {
  const f = await fixture(t)
  const user = await f.context()
  const before = f.snapshot()
  const { client, message } = f.pending(user)
  const call = await f.reached(message)
  assert.ok(client.sent)
  // IncomingMessage close after a fully consumed POST is not a disconnected response.
  await delay(3200)
  assert.equal(call.socketClosedAt, undefined)
  assert.equal(client.outcome, undefined)
  f.complete(call)
  assert.deepEqual(JSON.parse((await received(client, 200)).body), answer(message))
  assert.equal(f.audits(user).length, 1)
  assert.deepEqual(f.snapshot(), before)
})

test('agent pending token/session revocation, live expiry, all-credential withdrawal and suspension deny completed answers', { timeout: 45000 }, async (t) => {
  const f = await fixture(t)
  const password = randomBytes(24).toString('base64url')
  const salt = randomBytes(16).toString('hex')
  const passwordHash = `scrypt$32768$8$1$${salt}$${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`
  for (const scenario of ['token-revoke', 'token-expiry', 'session-revoke', 'session-expiry', 'all-credentials', 'disabled']) {
    const user = await f.context()
    f.api.db.prepare('UPDATE users SET passwordHash=? WHERE id=?').run(passwordHash, user.id)
    const login = await received(f.send('/auth/login', {}, { email: user.email, password }), 200)
    const cookie = login.headers['set-cookie']!.map((value) => value.split(';')[0]).join('; ')
    const tokenHash = createHash('sha256').update(user.token).digest('hex')
    const token = f.api.db.prepare('SELECT id FROM tokens WHERE tokenHash=?').get(tokenHash) as { id: string }
    const session = f.api.db.prepare('SELECT id FROM sessions WHERE userId=?').get(user.id) as { id: string }
    assert.ok(token.id && session.id)
    const credentials: Auth[] = scenario === 'all-credentials' || scenario === 'disabled' ? [{ token: user.token }, { cookie }]
      : scenario.startsWith('session') ? [{ cookie }] : [{ token: user.token }]
    const requests = credentials.map((auth) => f.pending({ wid: user.wid, ...auth }))
    const calls = await Promise.all(requests.map(({ message }) => f.reached(message)))
    for (const { client } of requests) assert.equal(client.outcome, undefined, scenario)
    // Change the very credentials used by these pending HTTP requests, with no replacement login.
    if (scenario === 'token-revoke') f.api.db.prepare('DELETE FROM tokens WHERE id=?').run(token.id)
    else if (scenario === 'session-revoke') f.api.db.prepare('DELETE FROM sessions WHERE id=?').run(session.id)
    else if (scenario === 'token-expiry') f.api.db.prepare('UPDATE tokens SET expiresAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z', token.id)
    else if (scenario === 'session-expiry') f.api.db.prepare('UPDATE sessions SET expiresAt=? WHERE id=?').run('2000-01-01T00:00:00.000Z', session.id)
    else if (scenario === 'disabled') f.api.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(user.id)
    else f.api.db.transaction(() => {
      f.api.db.prepare('DELETE FROM tokens WHERE userId=?').run(user.id)
      f.api.db.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)
    })()
    const before = f.snapshot(true)
    for (const call of calls) f.complete(call)
    for (const { client } of requests) {
      const denied = await received(client, 401)
      assert.deepEqual(JSON.parse(denied.body), { error: 'Authentication required' }, scenario)
    }
    assert.deepEqual(f.audits(user), [], scenario)
    assert.deepEqual(f.snapshot(true), before, `${scenario}: no answer audit, task mutation or credential resurrection`)
  }
})

test('agent pending membership and either required permission withdrawal deny completed answers without mutations', { timeout: 30000 }, async (t) => {
  const f = await fixture(t)
  for (const scenario of ['membership', 'agent:use', 'items:read', 'role-reassignment']) {
    const owner = await f.context()
    const member = { ...f.api.user(), wid: owner.wid }
    const roleId = randomUUID()
    f.api.db.prepare('INSERT INTO roles (id,workspaceId,name,permissions) VALUES (?,?,?,?)')
      .run(roleId, owner.wid, 'Assistant reader', JSON.stringify(['agent:use', 'items:read']))
    f.api.db.prepare('INSERT INTO memberships (workspaceId,userId,roleId) VALUES (?,?,?)').run(owner.wid, member.id, roleId)
    const { client, message } = f.pending(member)
    const call = await f.reached(message)
    assert.equal(client.outcome, undefined)
    if (scenario === 'membership') f.api.db.prepare('DELETE FROM memberships WHERE workspaceId=? AND userId=?').run(owner.wid, member.id)
    else if (scenario === 'role-reassignment') {
      const deniedRole = randomUUID()
      f.api.db.prepare('INSERT INTO roles (id,workspaceId,name,permissions) VALUES (?,?,?,?)').run(deniedRole, owner.wid, 'No access', '[]')
      f.api.db.prepare('UPDATE memberships SET roleId=? WHERE workspaceId=? AND userId=?').run(deniedRole, owner.wid, member.id)
    } else f.api.db.prepare('UPDATE roles SET permissions=? WHERE id=? AND workspaceId=?')
      .run(JSON.stringify(scenario === 'agent:use' ? ['items:read'] : ['agent:use']), roleId, owner.wid)
    const before = f.snapshot(true)
    f.complete(call)
    const denied = await received(client, 403)
    assert.deepEqual(JSON.parse(denied.body), { error: scenario === 'membership' ? 'Workspace access denied'
      : `Permission required: ${scenario === 'role-reassignment' ? 'agent:use' : scenario}` })
    assert.deepEqual(f.audits(member), [])
    assert.deepEqual(f.snapshot(true), before, scenario)
    const count = f.calls.length
    await received(f.ask(member), 403)
    assert.equal(f.calls.length, count, 'Withdrawn authorization must also deny before provider admission')
    assert.deepEqual(f.snapshot(true), before)
  }
})
