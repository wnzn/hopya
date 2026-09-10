import { test } from './japa.js'
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Effect } from 'effect'
import { integrationServer } from './storage-sso-fixture.js'
import type { Server } from 'node:http'
import { legacyAutomationGraph } from '../database/migrations/0001_automation_graphs.js'
import { upstreamReferenceErrors } from '../app/automation_graph_validation.js'
import { pinnedRequestEffect, resolvePinnedDestination } from '../app/pinned_http.js'

test('automation migration maps legacy steps without losing IDs, order or config', () => {
  const graph = legacyAutomationGraph('item.created', 3, [
    { id: 'old-step-a', position: 1, type: 'log', config: JSON.stringify({ message: 'first' }) },
    { id: 'old-step-b', position: 2, type: 'http', config: JSON.stringify({ url: 'https://example.test', method: 'POST', headers: { authorization: 'legacy-secret' }, body: '{{steps.1.output}}' }) },
  ])
  assert.deepEqual(graph.nodes.map((node) => node.id), ['trigger-3', 'old-step-a', 'old-step-b'])
  assert.deepEqual(graph.edges.map((edge) => [edge.source, edge.target]), [['trigger-3', 'old-step-a'], ['old-step-a', 'old-step-b']])
  assert.deepEqual(graph.nodes[2]!.config, { url: 'https://example.test', method: 'POST', headers: {}, legacyHeaderMigrationRequired: true, body: '{{nodes.old-step-a.output.message}}' })
})

test('graph validation rejects unknown, downstream and branch-only output references', () => {
  const linear = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.created' } },
    { id: 'first', type: 'log', position: { x: 1, y: 0 }, config: { message: 'first' } },
    { id: 'second', type: 'log', position: { x: 2, y: 0 }, config: { message: '{{nodes.missing.output.body}} {{nodes.first.output.message}}' } },
  ], edges: [{ id: 'a', source: 'trigger', target: 'first' }, { id: 'b', source: 'first', target: 'second' }] }
  assert.ok(upstreamReferenceErrors(linear).some((error) => error.includes('unknown node missing')))
  linear.nodes[1]!.config.message = '{{nodes.second.output.message}}'
  assert.ok(upstreamReferenceErrors(linear).some((error) => error.includes('not guaranteed upstream')))
  const branched = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.created' } },
    { id: 'condition', type: 'condition', position: { x: 1, y: 0 }, config: { path: 'item.status', operator: 'equals', value: 'done' } },
    { id: 'left', type: 'log', position: { x: 2, y: -1 }, config: { message: 'left' } },
    { id: 'right', type: 'log', position: { x: 2, y: 1 }, config: { message: 'right' } },
    { id: 'join', type: 'log', position: { x: 3, y: 0 }, config: { message: '{{nodes.left.output.message}}' } },
  ], edges: [
    { id: 'c', source: 'trigger', target: 'condition' }, { id: 'd', source: 'condition', target: 'left', branch: 'true' },
    { id: 'e', source: 'condition', target: 'right', branch: 'false' }, { id: 'f', source: 'left', target: 'join' }, { id: 'g', source: 'right', target: 'join' },
  ] }
  assert.ok(upstreamReferenceErrors(branched).some((error) => error.includes('left') && error.includes('not guaranteed upstream')))
})

test('pinned outbound resolution rejects IPv4-mapped forbidden destinations', async () => {
  await assert.rejects(() => resolvePinnedDestination('http://[::ffff:7f00:1]/metadata'), /blocked/)
})

test('pinned outbound requests enforce an absolute deadline despite active response traffic', { timeout: 5000 }, async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    const interval = setInterval(() => response.write('x'), 5)
    response.once('close', () => clearInterval(interval))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.close() })
  const port = (server.address() as { port: number }).port
  const result = await Effect.runPromise(Effect.either(pinnedRequestEffect({ url: new URL(`http://127.0.0.1:${port}`), address: '127.0.0.1', family: 4 }, { timeoutMs: 1000, totalTimeoutMs: 60, maxResponseBytes: 8192 })))
  assert.equal(result._tag, 'Left'); if (result._tag === 'Left') assert.equal(result.left.message, 'Outbound request timed out')
})

test('automations enforce permissions, deliver ordered steps, redact output and record failures', { timeout: 30000 }, async (t) => {
  const received: { path: string; body: string; signature: string; method: string; xTest: string }[] = []
  const hookServer = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += String(chunk) })
    request.on('end', () => {
      received.push({ path: request.url ?? '', body, signature: String(request.headers['x-hopya-signature'] ?? ''), method: request.method ?? '', xTest: String(request.headers['x-test'] ?? '') })
      if (request.url === '/redirect') response.writeHead(302, { location: '/hook' }).end()
      else if (request.url === '/large') response.writeHead(200).end('x'.repeat(10_000))
      else response.writeHead(request.url === '/fail' ? 500 : 200).end('{}')
    })
  })
  hookServer.listen(0, '127.0.0.1')
  await once(hookServer, 'listening')
  const hookPort = (hookServer.address() as { port: number }).port
  t.after(() => { hookServer.close() })

  const api = await integrationServer(t, { AUTOMATION_NETWORK_EXCEPTIONS: `http://127.0.0.1:${hookPort}` })
  const owner = await api.user(true)
  const outsider = await api.user(true)
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
  const reader = await api.user()
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
  const boundedLegacy = await post(`${base}/automations`, { name: 'Bounded legacy output', event: 'field.changed', enabled: false, action: { type: 'http', config: { url: `http://127.0.0.1:${hookPort}/large`, method: 'GET' } } })
  const boundedTest = await (await api.request(`${base}/automations/${boundedLegacy.id}/test`, { method: 'POST', token: owner.token })).json() as { runId: string }
  let boundedRun: { status: string; steps: { output: string }[] } | undefined
  const boundedDeadline = Date.now() + 5000
  while (Date.now() < boundedDeadline) { boundedRun = await (await api.request(`${base}/automations/runs/${boundedTest.runId}`, { token: owner.token })).json() as typeof boundedRun; if (boundedRun?.status === 'delivered') break; await new Promise((resolve) => setTimeout(resolve, 50)) }
  assert.equal(boundedRun?.status, 'delivered'); assert.equal(boundedRun?.steps[0]?.output, 'x'.repeat(8192))
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
  const legacySecret = await post(`${base}/automations`, { name: 'Legacy secret', event: 'field.changed', enabled: false, steps: [
    { type: 'http', config: { url: hookUrl, method: 'POST', headers: { authorization: 'Bearer legacy-never-expose' } } },
    { type: 'log', config: { message: 'prior={{steps.1.output}}' } },
  ] })
  const secretListText = await (await api.request(`${base}/automations`, { token: owner.token })).text()
  assert.equal(secretListText.includes('legacy-never-expose'), false)
  assert.equal(secretListText.includes('legacyHeaderMigrationRequired'), true)
  const legacyDraftResponse = await api.request(`${base}/automations/${legacySecret.id}/draft`, { token: owner.token }), legacyDraftText = await legacyDraftResponse.clone().text()
  assert.equal(legacyDraftText.includes('legacy-never-expose'), false)
  const legacyDraft = await legacyDraftResponse.json() as { graph: { nodes: { id: string; config: Record<string, unknown> }[] } }
  assert.equal((legacyDraft.graph.nodes[2]!.config.message as string), 'prior={{nodes.step-1.output.body}}')
  assert.equal((legacyDraft.graph.nodes[1]!.config.legacyHeaderMigrationRequired), true)
  assert.equal((await api.request(`${base}/automations/${legacySecret.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph: legacyDraft.graph } })).status, 200)
  assert.equal((await api.request(`${base}/automations/${legacySecret.id}/publish`, { method: 'POST', token: owner.token, body: { expectedRevision: 1 } })).status, 400)

  // Trigger: creating an item fans out to the subscribed webhook and automation.
  const list = await post(`${base}/nodes`, { name: 'List', kind: 'project' })
  const innerList = await post(`${base}/nodes`, { name: 'Inner', kind: 'list', parentId: list.id })
  const before = received.length
  const triggered = await post(`${base}/items`, { title: 'Trigger task', nodeId: innerList.id })
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
  // New webhook rows use true HMAC-SHA256; migrated rows retain signingVersion 1.
  const expected = createHmac('sha256', hook.secret).update(webhookDelivery.body).digest('hex')
  assert.equal(webhookDelivery.signature, `sha256=${expected}`)
  await api.db.run('UPDATE webhooks SET signingVersion=1 WHERE workspaceId=? AND id=?', wid, hook.id)
  const legacyBefore = received.length
  await api.request(`${base}/items/${triggered.id}`, { method: 'PATCH', token: owner.token, body: { description: 'legacy signature event' } })
  while (received.length === legacyBefore && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  const legacyDelivery = received.at(-1)!
  assert.equal(legacyDelivery.signature, `sha256=${createHash('sha256').update(`${hook.secret}.${legacyDelivery.body}`).digest('hex')}`)
  const hookDeliveries = received.filter((entry) => entry.path === '/hook').length
  await api.db.run('UPDATE webhooks SET url=? WHERE workspaceId=? AND id=?', `http://127.0.0.1:${hookPort}/redirect`, wid, hook.id)
  await api.request(`${base}/items/${triggered.id}`, { method: 'PATCH', token: owner.token, body: { description: 'redirect must fail' } })
  const redirectDeadline = Date.now() + 5000
  while (!received.some((entry) => entry.path === '/redirect') && Date.now() < redirectDeadline) await new Promise((resolve) => setTimeout(resolve, 50))
  let redirectFailed = false
  while (!redirectFailed && Date.now() < redirectDeadline) { const recent = await (await api.request(`${base}/automations/runs?limit=20`, { token: owner.token })).json() as { status: string; detail: string }[]; redirectFailed = recent.some((run) => run.status === 'failed' && run.detail.includes('redirect')); if (!redirectFailed) await new Promise((resolve) => setTimeout(resolve, 50)) }
  assert.ok(redirectFailed); assert.equal(received.filter((entry) => entry.path === '/hook').length, hookDeliveries, 'standalone webhook redirects must not be followed')

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
  const eventRevision = await (await api.request(`${base}/automations/${sequence.id}`, { method: 'PATCH', token: owner.token, body: { event: 'item.updated' } })).json() as { version: number; event: string; steps: unknown[] }
  assert.equal(eventRevision.version, 3); assert.equal(eventRevision.event, 'item.updated'); assert.equal(eventRevision.steps.length, 1)
  const versions = await (await api.request(`${base}/automations/${sequence.id}/versions`, { token: owner.token })).json() as { version: number }[]
  assert.deepEqual(versions.map((entry) => entry.version), [3, 2, 1])
  const priorVersion = await (await api.request(`${base}/automations/${sequence.id}/versions/2`, { token: owner.token })).json() as { graph: { nodes: { type: string; config: { event?: string } }[] } }
  assert.equal(priorVersion.graph.nodes.find((node) => node.type === 'trigger')?.config.event, 'item.created')

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

test('graph publishing executes one branch and credentials remain write-only and workspace-bound', { timeout: 30000 }, async (t) => {
  const requests: { path: string; authorization: string }[] = []
  let releaseSlow: (() => void) | undefined
  const provider = createServer((request, response) => {
    requests.push({ path: request.url ?? '', authorization: String(request.headers.authorization ?? '') })
    if (request.url === '/oauth/token') response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'connected-token', refresh_token: 'refresh-token', expires_in: 3600 }))
    else if (request.url === '/oauth/fail') response.writeHead(500, { 'content-type': 'application/json' }).end('{}')
    else if (request.url === '/allowed/huge') response.writeHead(200, { 'content-type': 'text/plain' }).end('oversized-secret'.repeat(50_000))
    else if (request.url === '/slow') releaseSlow = () => response.writeHead(200, { 'content-type': 'text/plain' }).end('released')
    else if (request.url === '/allowed/check') response.writeHead(200, { 'content-type': 'text/plain' }).end(`echo:${request.headers.authorization}:${request.headers['x-public']}:${request.headers['content-type']}`)
    else response.writeHead(200, { 'content-type': 'text/plain' }).end('typed-body')
  })
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => { provider.close() })
  const providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const key = randomBytes(32).toString('base64')
  const api = await integrationServer(t, { AUTOMATION_KEYRING: JSON.stringify({ active: 'test-v1', keys: { 'test-v1': key } }), AUTOMATION_NETWORK_EXCEPTIONS: providerOrigin })
  const owner = await api.user(true)
  const post = async (path: string, body: unknown, token = owner.token) => {
    const response = await api.request(path, { method: 'POST', body, token })
    assert.ok(response.status === 200 || response.status === 201, `${path}: ${response.status} ${await response.clone().text()}`)
    return response.json() as Promise<Record<string, unknown> & { id: string }>
  }
  const workspace = await post('/workspaces', { name: 'Graph workspace' }), wid = workspace.id, base = `/workspaces/${wid}`
  const automation = await post(`${base}/automations`, { name: 'Exclusive graph', event: 'item.created', action: { type: 'log', config: { message: 'legacy' } } })
  const catalog = await (await api.request(`${base}/automations/catalog`, { token: owner.token })).json() as { limits: { maxNodes: number }; nodes: { type: string }[] }
  assert.equal(catalog.limits.maxNodes, 50)
  assert.ok(catalog.nodes.some((node) => node.type === 'update_item'))

  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.created' } },
      { id: 'fetch', type: 'http', position: { x: 100, y: 0 }, config: { url: `${providerOrigin}/typed`, method: 'GET', headers: {} } },
      { id: 'condition', type: 'condition', position: { x: 200, y: 0 }, config: { path: 'nodes.fetch.output.status', operator: 'equals', value: 200 } },
      { id: 'yes', type: 'log', position: { x: 400, y: -100 }, config: { message: 'yes' } },
      { id: 'no', type: 'log', position: { x: 400, y: 100 }, config: { message: 'no' } },
      { id: 'join', type: 'log', position: { x: 600, y: 0 }, config: { message: 'status={{nodes.fetch.output.status}} body={{nodes.fetch.output.body}} title={{event.item.title}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'fetch' }, { id: 'e1', source: 'fetch', target: 'condition' }, { id: 'e2', source: 'condition', target: 'yes', branch: 'true' },
      { id: 'e3', source: 'condition', target: 'no', branch: 'false' }, { id: 'e4', source: 'yes', target: 'join' }, { id: 'e5', source: 'no', target: 'join' },
    ],
  }
  const cyclic = structuredClone(graph); cyclic.edges.push({ id: 'cycle', source: 'join', target: 'condition' })
  const invalid = await (await api.request(`${base}/automations/${automation.id}/validate`, { method: 'POST', token: owner.token, body: { graph: cyclic } })).json() as { valid: boolean; errors: string[] }
  assert.equal(invalid.valid, false); assert.ok(invalid.errors.some((error) => error.includes('acyclic')))
  const sensitive = structuredClone(graph); sensitive.nodes.find((node) => node.id === 'fetch')!.config.headers = { 'x-api-key': 'must-use-a-credential' }
  const sensitiveResult = await (await api.request(`${base}/automations/${automation.id}/validate`, { method: 'POST', token: owner.token, body: { graph: sensitive } })).json() as { valid: boolean; errors: string[] }
  assert.equal(sensitiveResult.valid, false); assert.ok(sensitiveResult.errors.some((error) => error.includes('Sensitive')))
  const duplicateSwitch = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.created' } },
    { id: 'switch', type: 'switch', position: { x: 1, y: 0 }, config: { path: 'item.status', cases: [{ branch: 'same', value: 'todo' }, { branch: 'same', value: 'done' }], defaultBranch: 'other' } },
    { id: 'same', type: 'log', position: { x: 2, y: 0 }, config: { message: 'same' } }, { id: 'other', type: 'log', position: { x: 2, y: 1 }, config: { message: 'other' } },
  ], edges: [{ id: 's1', source: 'trigger', target: 'switch' }, { id: 's2', source: 'switch', target: 'same', branch: 'same' }, { id: 's3', source: 'switch', target: 'other', branch: 'other' }, { id: 's4', source: 'switch', target: 'other', branch: 'extra' }] }
  const switchResult = await (await api.request(`${base}/automations/${automation.id}/validate`, { method: 'POST', token: owner.token, body: { graph: duplicateSwitch } })).json() as { valid: boolean }
  assert.equal(switchResult.valid, false)
  const deletedUpdate = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.deleted' } }, { id: 'update', type: 'update_item', position: { x: 1, y: 0 }, config: { patch: { priority: 'high' } } }], edges: [{ id: 'update-edge', source: 'trigger', target: 'update' }] }
  const deletedUpdateResult = await (await api.request(`${base}/automations/${automation.id}/validate`, { method: 'POST', token: owner.token, body: { graph: deletedUpdate } })).json() as { valid: boolean; errors: string[] }
  assert.equal(deletedUpdateResult.valid, false); assert.ok(deletedUpdateResult.errors.some((error) => error.includes('item.created or item.updated')))
  const savedResponse = await api.request(`${base}/automations/${automation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph } })
  assert.equal(savedResponse.status, 200); const saved = await savedResponse.json() as { revision: number }; assert.equal(saved.revision, 1)
  const unsafeDraft = structuredClone(graph); unsafeDraft.nodes.find((node) => node.id === 'fetch')!.config.headers = { Authorization: 'draft-secret-value', 'Content-Length': '999' }
  const unsafeDraftResponse = await api.request(`${base}/automations/${automation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 1, graph: unsafeDraft } })
  assert.equal(unsafeDraftResponse.status, 400); assert.equal((await unsafeDraftResponse.text()).includes('draft-secret-value'), false)
  const unchangedDraft = await api.db.get<{ revision: number; graph: string }>('SELECT revision,graph FROM automation_drafts WHERE workspaceId=? AND automationId=?', wid, automation.id)
  assert.equal(unchangedDraft?.revision, 1); assert.equal(unchangedDraft?.graph.includes('draft-secret-value'), false)
  assert.equal((await api.request(`${base}/automations/${automation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph } })).status, 409)
  const published = await (await api.request(`${base}/automations/${automation.id}/publish`, { method: 'POST', token: owner.token, body: { expectedRevision: 1 } })).json() as { version: number; format: string }
  assert.equal(published.version, 2); assert.equal(published.format, 'graph')
  const uncertainPreview = await (await api.request(`${base}/automations/${automation.id}/preview`, { method: 'POST', token: owner.token, body: { event: { item: { title: 'Graph task' } } } })).json() as { uncertain: boolean; path: { nodeId: string; uncertain?: boolean }[] }
  assert.equal(uncertainPreview.uncertain, true); assert.equal(uncertainPreview.path.at(-1)?.nodeId, 'condition')
  const mockPreview = await (await api.request(`${base}/automations/${automation.id}/preview`, { method: 'POST', token: owner.token, body: { event: { item: { title: 'Graph task' } }, mockOutputs: { fetch: { status: 200, body: 'mock' } } } })).json() as { uncertain: boolean; path: { nodeId: string }[] }
  assert.equal(mockPreview.uncertain, false); assert.ok(mockPreview.path.some((entry) => entry.nodeId === 'yes'))
  const listed = await (await api.request(`${base}/automations`, { token: owner.token })).json() as { id: string; graph?: boolean; steps?: unknown[] }[]
  const nonlinear = listed.find((entry) => entry.id === automation.id)!; assert.equal(nonlinear.graph, true); assert.equal(nonlinear.steps, undefined)
  assert.equal((await api.request(`${base}/automations/${automation.id}`, { method: 'PATCH', token: owner.token, body: { action: { type: 'log', config: { message: 'flatten' } } } })).status, 409)
  assert.equal((await api.request(`${base}/automations/${automation.id}`, { method: 'PATCH', token: owner.token, body: { event: 'item.updated' } })).status, 409)

  const project = await post(`${base}/nodes`, { name: 'Project', kind: 'project' }), list = await post(`${base}/nodes`, { name: 'List', kind: 'list', parentId: project.id })
  await post(`${base}/items`, { title: 'Graph task', nodeId: list.id })
  let graphRun: { status: string; nodes: { nodeId: string; status: string; output: string }[] } | undefined
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const runs = await (await api.request(`${base}/automations/runs?automationId=${automation.id}`, { token: owner.token })).json() as (typeof graphRun)[]
    graphRun = runs[0]; if (graphRun?.status === 'delivered') break; await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(graphRun?.status, 'delivered')
  assert.equal(graphRun?.nodes.find((node) => node.nodeId === 'yes')?.status, 'delivered')
  assert.equal(graphRun?.nodes.find((node) => node.nodeId === 'no')?.status, 'skipped')
  assert.equal(graphRun?.nodes.find((node) => node.nodeId === 'join')?.status, 'delivered')
  assert.deepEqual(JSON.parse(graphRun!.nodes.find((node) => node.nodeId === 'fetch')!.output), { status: 200, body: 'typed-body' })
  assert.deepEqual(JSON.parse(graphRun!.nodes.find((node) => node.nodeId === 'join')!.output), { message: 'status=200 body=typed-body title=Graph task' })

  assert.equal((await api.request(`${base}/automations/credentials`, { method: 'POST', token: owner.token, body: { name: 'Query key', type: 'api_key', origin: providerOrigin, secret: { name: 'x-api-key', value: 'private', in: 'query' } } })).status, 400)
  assert.equal((await api.request(`${base}/automations/credentials`, { method: 'POST', token: owner.token, body: { name: 'Framing key', type: 'api_key', origin: providerOrigin, secret: { name: 'Content-Length', value: '1' } } })).status, 400)
  assert.equal((await api.request(`${base}/automations/credentials`, { method: 'POST', token: owner.token, body: { name: 'Fragment', type: 'bearer', origin: `${providerOrigin}#fragment`, secret: { token: 'private' } } })).status, 400)
  const credential = await post(`${base}/automations/credentials`, { name: 'Bound bearer', type: 'bearer', origin: providerOrigin, pathPrefix: '/allowed', secret: { token: 'version-one' } }) as { id: string; secret?: unknown }
  assert.equal(credential.secret, undefined)
  const credentials = await (await api.request(`${base}/automations/credentials`, { token: owner.token })).json() as { id: string; secret?: unknown }[]
  assert.equal(credentials[0]?.secret, undefined)
  const other = await post('/workspaces', { name: 'Other workspace' })
  assert.equal((await api.request(`/workspaces/${other.id}/automations/credentials/${credential.id}`, { token: owner.token })).status, 404)

  const credentialAutomation = await post(`${base}/automations`, { name: 'Current credential', event: 'item.created', action: { type: 'log', config: { message: 'seed' } } })
  const credentialGraph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.created' } },
    { id: 'request', type: 'http', position: { x: 200, y: 0 }, config: { url: `${providerOrigin}/allowed/check`, method: 'GET', headers: { 'x-public': 'public-marker', 'content-type': 'application/vnd.hopya-test' }, credentialId: credential.id } },
  ], edges: [{ id: 'credential-edge', source: 'trigger', target: 'request' }] }
  assert.equal((await api.request(`${base}/automations/${credentialAutomation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph: credentialGraph } })).status, 200)
  assert.equal((await api.request(`${base}/automations/${credentialAutomation.id}/publish`, { method: 'POST', token: owner.token, body: { expectedRevision: 1 } })).status, 200)
  assert.equal((await api.request(`${base}/automations/credentials/${credential.id}`, { method: 'PUT', token: owner.token, body: { expectedVersion: 1, secret: { token: 'version-two' } } })).status, 200)

  const manager = await api.user(), role = await post(`${base}/roles`, { name: 'Automation manager', permissions: ['items:read', 'items:write', 'automations:manage'] })
  await post(`${base}/members`, { email: manager.email, roleId: role.id })
  const permissionAutomation = await post(`${base}/automations`, { name: 'Permission recheck', event: 'item.created', action: { type: 'log', config: { message: 'seed' } } }, manager.token)
  const permissionGraph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.created' } },
    { id: 'update', type: 'update_item', position: { x: 200, y: 0 }, config: { patch: { priority: 'urgent' } } },
  ], edges: [{ id: 'permission-edge', source: 'trigger', target: 'update' }] }
  assert.equal((await api.request(`${base}/automations/${permissionAutomation.id}/draft`, { method: 'PUT', token: manager.token, body: { expectedRevision: 0, graph: permissionGraph } })).status, 200)
  assert.equal((await api.request(`${base}/automations/${permissionAutomation.id}/publish`, { method: 'POST', token: manager.token, body: { expectedRevision: 1 } })).status, 200)
  assert.equal((await api.request(`${base}/roles/${role.id}`, { method: 'PATCH', token: owner.token, body: { permissions: ['items:read', 'automations:manage'] } })).status, 200)
  await post(`${base}/items`, { title: 'Permission target', nodeId: list.id })
  let permissionRun: { status: string; detail: string } | undefined
  const permissionDeadline = Date.now() + 8000
  while (Date.now() < permissionDeadline) {
    const runs = await (await api.request(`${base}/automations/runs?automationId=${permissionAutomation.id}`, { token: owner.token })).json() as (typeof permissionRun)[]
    permissionRun = runs[0]; if (permissionRun?.status === 'failed') break; await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(permissionRun?.status, 'failed'); assert.ok(permissionRun?.detail.includes('items:write'))
  const credentialDeadline = Date.now() + 8000
  while (!requests.some((request) => request.path === '/allowed/check') && Date.now() < credentialDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(requests.find((request) => request.path === '/allowed/check')?.authorization, 'Bearer version-two')
  const credentialRuns = await (await api.request(`${base}/automations/runs?automationId=${credentialAutomation.id}`, { token: owner.token })).json() as { nodes: { nodeId: string; output: string }[] }[]
  const captured = credentialRuns[0]!.nodes.find((node) => node.nodeId === 'request')!.output
  assert.equal(captured.includes('version-two'), false); assert.equal(captured.includes('[REDACTED]'), true); assert.equal(captured.includes('public-marker'), true); assert.equal(captured.includes('application/vnd.hopya-test'), true)
  const hugeGraph = structuredClone(credentialGraph); hugeGraph.nodes.find((node) => node.id === 'request')!.config.url = `${providerOrigin}/allowed/huge`
  assert.equal((await api.request(`${base}/automations/${credentialAutomation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph: hugeGraph } })).status, 200)
  assert.equal((await api.request(`${base}/automations/${credentialAutomation.id}/publish`, { method: 'POST', token: owner.token, body: { expectedRevision: 1 } })).status, 200)
  await api.request(`${base}/automations/${credentialAutomation.id}/test`, { method: 'POST', token: owner.token, body: {} })
  let hugeRun: { status: string; detail: string; nodes: { nodeId: string; output: string | null }[] } | undefined
  const hugeDeadline = Date.now() + 8000
  while (Date.now() < hugeDeadline) { const runs = await (await api.request(`${base}/automations/runs?automationId=${credentialAutomation.id}`, { token: owner.token })).json() as (typeof hugeRun)[]; hugeRun = runs[0]; if (hugeRun?.status === 'failed') break; await new Promise((resolve) => setTimeout(resolve, 100)) }
  assert.equal(hugeRun?.status, 'failed'); assert.ok(hugeRun?.detail.includes('too large')); assert.equal(JSON.parse(hugeRun!.nodes.find((node) => node.nodeId === 'request')!.output!), '')

  const oauth = await post(`${base}/automations/credentials`, { name: 'OAuth', type: 'oauth2', origin: providerOrigin, secret: { authorizationUrl: `${providerOrigin}/oauth/authorize`, tokenUrl: `${providerOrigin}/oauth/token`, clientId: 'client', scopes: ['tasks'] } })
  const started = await (await api.request(`${base}/automations/credentials/${oauth.id}/oauth/start`, { method: 'POST', token: owner.token, body: {} })).json() as { authorizationUrl: string }
  const state = new URL(started.authorizationUrl).searchParams.get('state')!
  const callbackPath = `${base}/automations/credentials/${oauth.id}/oauth/callback?state=${encodeURIComponent(state)}&code=test-code`
  const callback = await api.request(callbackPath, { token: owner.token })
  assert.equal(callback.status, 302); assert.equal(callback.headers.get('location'), `${api.base}/integrations?oauth=connected`)
  assert.equal((await api.request(callbackPath, { token: owner.token })).status, 400, 'consumed OAuth state cannot be replayed')
  const failedOauth = await post(`${base}/automations/credentials`, { name: 'Failed OAuth', type: 'oauth2', origin: providerOrigin, secret: { authorizationUrl: `${providerOrigin}/oauth/authorize`, tokenUrl: `${providerOrigin}/oauth/fail`, clientId: 'client' } })
  const failedStart = await (await api.request(`${base}/automations/credentials/${failedOauth.id}/oauth/start`, { method: 'POST', token: owner.token, body: {} })).json() as { authorizationUrl: string }
  const failedState = new URL(failedStart.authorizationUrl).searchParams.get('state')!, failedCallback = `${base}/automations/credentials/${failedOauth.id}/oauth/callback?state=${encodeURIComponent(failedState)}&code=fail`
  assert.equal((await api.request(failedCallback, { token: owner.token })).status, 502)
  assert.equal((await api.request(failedCallback, { token: owner.token })).status, 400, 'failed token exchange still consumes OAuth state')
  const failedMetadata = (await (await api.request(`${base}/automations/credentials`, { token: owner.token })).json() as { id: string; version: number }[]).find((entry) => entry.id === failedOauth.id)!
  assert.equal(failedMetadata.version, 1)

  const raceAutomation = await post(`${base}/automations`, { name: 'Draft race', event: 'node.created', action: { type: 'log', config: { message: 'seed' } } })
  const raceGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'node.created' } }, { id: 'log', type: 'log', position: { x: 1, y: 0 }, config: { message: 'race' } }], edges: [{ id: 'race', source: 'trigger', target: 'log' }] }
  const race = await Promise.all([1, 2].map(() => api.request(`${base}/automations/${raceAutomation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph: raceGraph } })))
  assert.deepEqual(race.map((response) => response.status).sort(), [200, 409])
  const publishRace = await Promise.all([1, 2].map(() => api.request(`${base}/automations/${raceAutomation.id}/publish`, { method: 'POST', token: owner.token, body: { expectedRevision: 1 } })))
  assert.deepEqual(publishRace.map((response) => response.status).sort(), [200, 409])
  const raceVersions = await (await api.request(`${base}/automations/${raceAutomation.id}/versions`, { token: owner.token })).json() as { version: number }[]
  assert.deepEqual(raceVersions.map((entry) => entry.version), [2, 1])

  const leaseAutomation = await post(`${base}/automations`, { name: 'Lease loss', event: 'node.updated', action: { type: 'log', config: { message: 'seed' } } })
  const leaseGraph = { nodes: [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'node.updated' } }, { id: 'slow', type: 'http', position: { x: 1, y: 0 }, config: { url: `${providerOrigin}/slow`, method: 'GET', headers: {} } }], edges: [{ id: 'slow-edge', source: 'trigger', target: 'slow' }] }
  await api.request(`${base}/automations/${leaseAutomation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph: leaseGraph } })
  await api.request(`${base}/automations/${leaseAutomation.id}/publish`, { method: 'POST', token: owner.token, body: { expectedRevision: 1 } })
  const leaseTest = await (await api.request(`${base}/automations/${leaseAutomation.id}/test`, { method: 'POST', token: owner.token, body: {} })).json() as { runId: string }
  const leaseDeadline = Date.now() + 8000
  while (!releaseSlow && Date.now() < leaseDeadline) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(releaseSlow, 'slow action must start before simulating lease loss')
  await api.db.run("UPDATE automation_runs SET leaseId='replacement-lease' WHERE id=?", leaseTest.runId)
  releaseSlow!(); await new Promise((resolve) => setTimeout(resolve, 200))
  const uncommitted = await api.db.get<{ status: string }>('SELECT status FROM automation_node_runs WHERE runId=? AND nodeId=?', leaseTest.runId, 'slow')
  assert.equal(uncommitted?.status, 'running', 'worker losing its lease cannot commit action success')
  await api.db.run('UPDATE automation_runs SET heartbeatAt=?,startedAt=? WHERE id=?', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z', leaseTest.runId)
  await api.request(`${base}/automations/${raceAutomation.id}/test`, { method: 'POST', token: owner.token, body: {} })
  let expired: { status: string; detail: string } | undefined
  const expiryDeadline = Date.now() + 8000
  while (Date.now() < expiryDeadline) { expired = await api.db.get<{ status: string; detail: string }>('SELECT status,detail FROM automation_runs WHERE id=?', leaseTest.runId); if (expired?.status === 'failed') break; await new Promise((resolve) => setTimeout(resolve, 50)) }
  assert.equal(expired?.status, 'failed'); assert.ok(expired?.detail.includes('not replayed')); assert.equal(requests.filter((request) => request.path === '/slow').length, 1)

  const updateAutomation = await post(`${base}/automations`, { name: 'Update once', event: 'item.updated', action: { type: 'log', config: { message: 'seed' } } })
  const updateGraph = { nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event: 'item.updated' } },
    { id: 'update', type: 'update_item', position: { x: 200, y: 0 }, config: { patch: { priority: 'high' } } },
  ], edges: [{ id: 'update-edge', source: 'trigger', target: 'update' }] }
  await api.request(`${base}/automations/${updateAutomation.id}/draft`, { method: 'PUT', token: owner.token, body: { expectedRevision: 0, graph: updateGraph } })
  await api.request(`${base}/automations/${updateAutomation.id}/publish`, { method: 'POST', token: owner.token, body: { expectedRevision: 1 } })
  const task = await post(`${base}/items`, { title: 'Re-entry task', nodeId: list.id }) as { id: string }
  await api.request(`${base}/items/${task.id}`, { method: 'PATCH', token: owner.token, body: { description: 'trigger update' } })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const updateRuns = await (await api.request(`${base}/automations/runs?automationId=${updateAutomation.id}`, { token: owner.token })).json() as { status: string }[]
  assert.equal(updateRuns.length, 1, 'same automation re-entry must be suppressed')
  assert.equal(updateRuns[0]?.status, 'delivered')
})

// Keep the server import referenced for type checking without side effects.
export type { Server } from 'node:http'
