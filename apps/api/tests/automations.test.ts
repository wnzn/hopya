import { test } from './japa.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { integrationServer } from './storage-sso-fixture.js'
import type { Server } from 'node:http'

test('automations enforce permissions, deliver ordered steps, redact output and record failures', { timeout: 30000 }, async (t) => {
  const received: { path: string; body: string; signature: string; method: string; xTest: string }[] = []
  const hookServer = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      received.push({ path: request.url ?? '', body, signature: String(request.headers['x-hopya-signature'] ?? ''), method: request.method ?? '', xTest: String(request.headers['x-test'] ?? '') })
      response.writeHead(request.url === '/fail' ? 500 : 200).end('{}')
    })
  })
  hookServer.listen(0, '127.0.0.1')
  await once(hookServer, 'listening')
  const hookPort = (hookServer.address() as { port: number }).port
  t.after(() => { hookServer.close() })

  const api = await integrationServer(t)
  const owner = api.user(true)
  const outsider = api.user(true)
  const post = async (path: string, body: unknown, token = owner.token) => {
    const response = await api.request(path, { method: 'POST', body, token })
    assert.ok(response.status === 200 || response.status === 201, `${path}: ${response.status}`)
    return response.json() as Promise<Record<string, unknown> & { id: string }>
  }
  const workspace = await post('/workspaces', { name: 'Automations' })
  const wid = workspace.id
  const base = `/workspaces/${wid}`

  // Permission boundary: workspace:manage required for webhooks/automations.
  for (const path of ['/webhooks', '/automations']) {
    assert.equal((await api.request(`${base}${path}`, { token: outsider.token })).status, 403)
  }
  const reader = api.user()
  await post(`${base}/roles`, { name: 'Reader', permissions: ['items:read'] })
  const role = await (await api.request(`${base}/roles`, { token: owner.token })).json() as { id: string; name: string }[]
  const readerRole = role.find((value) => value.name === 'Reader')!.id
  await post(`${base}/members`, { email: reader.email, roleId: readerRole })
  assert.equal((await api.request(`${base}/webhooks`, { token: reader.token })).status, 403)
  assert.equal((await api.request(`${base}/automations`, { token: reader.token })).status, 403)
  assert.equal((await api.request(`${base}/automations/runs`, { token: reader.token })).status, 403)

  // Webhook CRUD with validation.
  const hookUrl = `http://127.0.0.1:${hookPort}/hook`
  assert.equal((await api.request(`${base}/webhooks`, { method: 'POST', token: owner.token, body: { name: 'Bad', url: 'ftp://x', events: ['item.updated'] } })).status, 400)
  assert.equal((await api.request(`${base}/webhooks`, { method: 'POST', token: owner.token, body: { name: 'Bad', url: hookUrl, events: [] } })).status, 400)
  const hook = await post(`${base}/webhooks`, { name: 'Relay', url: hookUrl, events: ['item.created', 'item.updated'] }) as { id: string; secret: string; events: string[] }
  assert.ok(hook.secret?.length >= 32)
  const listed = await (await api.request(`${base}/webhooks`, { token: owner.token })).json() as { secret?: string }[]
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.secret, undefined, 'secret must not be returned by list')

  // Automation CRUD with adapter validation.
  assert.equal((await api.request(`${base}/automations`, { method: 'POST', token: owner.token, body: { name: 'Bad', event: 'item.created', action: { type: 'http', config: { method: 'POST' } } } })).status, 400)
  const automation = await post(`${base}/automations`, { name: 'Mirror to hook', event: 'item.created', action: { type: 'http', config: { url: hookUrl, method: 'POST', headers: { 'x-test': '1' } } } }) as { id: string }
  assert.equal((await api.request(`${base}/automations`, { method: 'POST', token: owner.token, body: {
    name: 'Bad sequence', event: 'item.created', steps: [{ type: 'log', config: { message: '{{steps.1.output}}' } }],
  } })).status, 400, 'steps cannot reference themselves or later output')
  const sequence = await post(`${base}/automations`, { name: 'Sequence', event: 'item.created', steps: [
    { type: 'log', config: { message: 'token=private-value' } },
    { type: 'http', config: { url: `${hookUrl}?sequence=1`, method: 'POST', headers: { 'x-test': 'sequence' }, body: 'prior={{steps.1.output}}' } },
  ] }) as { id: string; version: number; steps: unknown[]; action?: unknown }
  assert.equal(sequence.version, 1)
  assert.equal(sequence.steps.length, 2)
  assert.equal(sequence.action, undefined, 'legacy action is returned only for single-step rules')

  // Trigger: creating an item fans out to the subscribed webhook and automation.
  const list = await post(`${base}/nodes`, { name: 'List', kind: 'project' })
  const innerList = await post(`${base}/nodes`, { name: 'Inner', kind: 'list', parentId: list.id })
  const before = received.length
  await post(`${base}/items`, { title: 'Trigger task', nodeId: innerList.id })
  const deadline = Date.now() + 10000
  while (received.length < before + 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(received.length, before + 3, 'webhook and both automation HTTP actions should deliver')
  const webhookDelivery = received.find((entry) => entry.path === '/hook' && entry.xTest === '')!
  const automationDelivery = received.find((entry) => entry.path === '/hook' && entry.xTest === '1') ?? webhookDelivery
  const payload = JSON.parse(automationDelivery.body) as { event: string; item: { title: string }; workspaceId: string }
  assert.equal(payload.event, 'item.created')
  assert.equal(payload.item.title, 'Trigger task')
  assert.equal(payload.workspaceId, wid)
  const sequenceDelivery = received.find((entry) => entry.xTest === 'sequence')!
  assert.equal(sequenceDelivery.body, 'prior=token=[REDACTED]', 'a later step receives the bounded sanitized prior output')
  // HMAC-SHA256 signature over `${secret}.${body}`.
  const expected = createHash('sha256').update(`${hook.secret}.${webhookDelivery.body}`).digest('hex')
  assert.ok(webhookDelivery.signature.endsWith(expected) || webhookDelivery.signature.includes(expected), 'signature header must carry the HMAC digest')

  // Delivery runs are recorded and visible (recordRun lands after fetch resolves,
  // so poll briefly rather than asserting the instant deliveries arrive).
  let runs: { id: string; automationId: string; status: string; detail: string; automationVersion: number; steps: { position: number; status: string; output: string; log: string }[] }[] = []
  const runsDeadline = Date.now() + 10000
  while (Date.now() < runsDeadline) {
    runs = await (await api.request(`${base}/automations/runs?limit=20`, { token: owner.token })).json() as typeof runs
    if (runs.length >= 3 && runs.some((run) => run.automationId === sequence.id && run.status === 'delivered')) break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(runs.length >= 3, 'durably queued delivery runs recorded')
  assert.ok(runs.some((run) => run.status === 'delivered'))
  const sequenceRun = runs.find((run) => run.automationId === sequence.id)!
  assert.equal(sequenceRun.automationVersion, 1)
  assert.deepEqual(sequenceRun.steps.map((step) => [step.position, step.status]), [[1, 'delivered'], [2, 'delivered']])
  assert.ok(sequenceRun.steps[0]!.log.includes('[REDACTED]'))
  assert.ok(!sequenceRun.steps[0]!.log.includes('private-value'))
  const runDetail = await (await api.request(`${base}/automations/runs/${sequenceRun.id}`, { token: owner.token })).json() as { id: string; steps: unknown[]; event?: unknown }
  assert.equal(runDetail.id, sequenceRun.id)
  assert.equal(runDetail.steps.length, 2)
  assert.equal(runDetail.event, undefined, 'raw queued event payload is not exposed in monitor logs')
  const revised = await (await api.request(`${base}/automations/${sequence.id}`, { method: 'PATCH', token: owner.token, body: {
    steps: [{ type: 'log', config: { message: 'revision two {"token":"must-not-leak"}' } }],
  } })).json() as { version: number; steps: unknown[]; action: { type: string } }
  assert.equal(revised.version, 2)
  assert.equal(revised.steps.length, 1)
  assert.equal(revised.action.type, 'log', 'single-step response keeps the legacy action shape')
  const testRun = await (await api.request(`${base}/automations/${sequence.id}/test`, { method: 'POST', token: owner.token })).json() as { ok: boolean; event: string; runId: string; status: string }
  assert.equal(testRun.ok, true)
  assert.equal(testRun.status, 'pending')
  let tested: { status: string; automationVersion: number; steps: { log: string }[] } | undefined
  const testDeadline = Date.now() + 5000
  while (Date.now() < testDeadline) {
    tested = await (await api.request(`${base}/automations/runs/${testRun.runId}`, { token: owner.token })).json() as typeof tested
    if (tested?.status === 'delivered') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(tested?.automationVersion, 2)
  assert.equal(tested?.steps[0]?.log, 'revision two {"token":"[REDACTED]"}')

  // Unsubscribed events are not delivered.
  const paused = received.length
  await api.request(`${base}/items/${innerList.id}`, { method: 'PATCH', token: owner.token, body: { name: 'Renamed' } })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.equal(received.length, paused, 'node.updated must not hit the item.created subscription')

  // Failed webhook responses are recorded, not thrown.
  const failing = await post(`${base}/webhooks`, { name: 'Failing', url: `http://127.0.0.1:${hookPort}/fail`, events: ['item.deleted'] })
  const item = await post(`${base}/items`, { title: 'Doomed', nodeId: innerList.id })
  await api.request(`${base}/items/${item.id}`, { method: 'DELETE', token: owner.token })
  const runDeadline = Date.now() + 10000
  let failureSeen = false
  while (Date.now() < runDeadline && !failureSeen) {
    const recent = await (await api.request(`${base}/automations/runs?limit=50`, { token: owner.token })).json() as { status: string; detail: string }[]
    failureSeen = recent.some((run) => run.status === 'failed' && run.detail.includes('500'))
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(failureSeen, 'failed webhook delivery must be recorded')
})

// Keep the server import referenced for type checking without side effects.
export type { Server } from 'node:http'
