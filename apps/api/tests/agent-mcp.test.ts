import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { integrationServer } from './storage-sso-fixture.js'

test('agent provider adapters, bounded untrusted output and workspace authorization', { timeout: 60000 }, async (t) => {
  let mode = 'valid'; let payload: Record<string, any> = {}; let calls = 0; let onRequest = () => {}
  let selectedList = ''; const requests: { path: string; headers: Record<string, unknown>; body: any }[] = []
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    calls++; requests.push({ path: req.url!, headers: req.headers, body: JSON.parse(raw) }); onRequest()
    const answer = JSON.stringify(mode === 'foreign-list' ? { reply: 'Try this', proposal: { title: 'Bad reference', nodeId: '00000000-0000-4000-8000-000000000000' } }
      : { reply: 'Review this suggestion. No changes were made.', proposal: { title: 'Proposed task', nodeId: selectedList, dueDate: '2026-09-20', priority: 'high' } })
    if (mode === 'error') { res.writeHead(500); res.end('SECRET-provider-error'); return }
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:9/stolen' }); res.end(); return }
    const text = mode === 'malformed' ? 'not json SECRET-provider-error' : answer
    payload = req.url === '/v1/messages' ? { content: [{ type: 'text', text }] }
      : req.url?.includes(':generateContent') ? { candidates: [{ content: { parts: [{ text }] } }] }
      : { choices: [{ message: { content: text } }] }
    res.setHeader('content-type', 'application/json'); res.end(mode === 'huge' ? 'x'.repeat(270000) : JSON.stringify(payload))
  }).listen(0, '127.0.0.1')
  await once(mock, 'listening')
  t.after(() => new Promise<void>((resolve) => { mock.closeAllConnections(); mock.close(() => resolve()) }))
  const providerUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`
  for (const provider of ['openai-compatible', 'openai', 'anthropic', 'google']) {
    await t.test(provider, async (t) => {
      mode = 'valid'; onRequest = () => {}
      const api = await integrationServer(t, { AI_PROVIDER: provider, AI_BASE_URL: providerUrl, AI_MODEL: 'test-model', AI_API_KEY: 'SECRET-api-key', AI_MAX_OUTPUT_TOKENS: '4096' })
      const admin = api.user(true); const stranger = api.user()
      const task = await api.item(admin.token)
      selectedList = (api.db.prepare('SELECT nodeId FROM items WHERE id=?').get(task.id) as { nodeId: string }).nodeId
      const endpoint = `/workspaces/${task.wid}/agent`
      const ask = () => api.request(endpoint, { method: 'POST', token: admin.token, body: { message: 'PRIVATE-prompt: propose a task' } })
      const count = calls
      assert.equal((await api.request(endpoint, { method: 'POST', token: stranger.token, body: { message: 'Steal workspace' } })).status, 403)
      assert.equal(calls, count)
      const result = await ask()
      assert.equal(result.status, 200, await result.clone().text())
      const answer = await result.json() as any
      assert.equal(answer.proposal.nodeId, selectedList)
      assert.equal((api.db.prepare('SELECT count(*) AS n FROM items').get() as any).n, 1, 'An AI answer cannot mutate tasks')
      const outbound = requests.at(-1)!
      assert.equal(outbound.path.includes('SECRET'), false)
      assert.equal(JSON.stringify(outbound.body).includes(admin.email), false)
      if (provider === 'anthropic') assert.equal(outbound.headers['x-api-key'], 'SECRET-api-key')
      else if (provider === 'google') assert.equal(outbound.headers['x-goog-api-key'], 'SECRET-api-key')
      else assert.equal(outbound.headers.authorization, 'Bearer SECRET-api-key')
      if (provider === 'openai') {
        assert.equal(outbound.body.max_completion_tokens, 4096)
        assert.equal(outbound.body.store, false)
        assert.equal(Object.hasOwn(outbound.body, 'max_tokens'), false)
      } else if (provider === 'google') assert.equal(outbound.body.generationConfig.maxOutputTokens, 4096)
      else {
        assert.equal(outbound.body.max_tokens, 4096)
        assert.equal(Object.hasOwn(outbound.body, 'max_completion_tokens'), false)
        assert.equal(Object.hasOwn(outbound.body, 'store'), false)
      }
      const audits = JSON.stringify(api.db.prepare('SELECT * FROM audit_logs').all())
      for (const secret of ['PRIVATE-prompt', 'SECRET-api-key', admin.token]) assert.equal(audits.includes(secret), false)
      if (provider === 'openai-compatible') {
        for (mode of ['foreign-list', 'error', 'redirect', 'malformed', 'huge']) {
          const rejected = await ask()
          assert.equal(rejected.status, 502, await rejected.clone().text())
          assert.equal((await rejected.text()).includes('SECRET'), false)
        }
        mode = 'valid'
        onRequest = () => { api.db.prepare('DELETE FROM memberships WHERE workspaceId=? AND userId=?').run(task.wid, admin.id) }
        const revoked = await ask()
        assert.equal(revoked.status, 403)
        assert.equal((api.db.prepare('SELECT count(*) AS n FROM items').get() as any).n, 1)
      }
    })
  }
  await t.test('invalid operator token budget fails before any provider call', async (t) => {
    const api = await integrationServer(t, { AI_PROVIDER: 'openai', AI_BASE_URL: providerUrl, AI_MODEL: 'test-model', AI_API_KEY: 'SECRET-api-key', AI_MAX_OUTPUT_TOKENS: '32769' })
    const user = api.user(true)
    const task = await api.item(user.token)
    const count = calls
    const result = await api.request(`/workspaces/${task.wid}/agent`, { method: 'POST', token: user.token, body: { message: 'Budget validation' } })
    assert.equal(result.status, 503)
    assert.equal(calls, count)
  })
})

test('official MCP client negotiates stdio; read-only default, opt-in mutations and token revocation', { timeout: 45000 }, async (t) => {
  const api = await integrationServer(t)
  const owner = api.user(true)
  const task = await api.item(owner.token)
  const nodeId = (api.db.prepare('SELECT nodeId FROM items WHERE id=?').get(task.id) as { nodeId: string }).nodeId
  async function connect(writes: boolean) {
    const client = new Client({ name: 'hopya-test', version: '1.0' })
    const transport = new StdioClientTransport({ command: process.execPath, args: process.env.HOPYA_TEST_BUILD === 'true' ? [fileURLToPath(new URL('../build/bin/mcp.js', import.meta.url))] : ['--import', 'tsx', fileURLToPath(new URL('../bin/mcp.ts', import.meta.url))],
      env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), HOPYA_API_URL: api.base, HOPYA_API_TOKEN: owner.token, HOPYA_MCP_ALLOW_WRITES: String(writes) }, stderr: 'pipe' })
    await client.connect(transport)
    t.after(() => client.close())
    return client
  }
  const readonly = await connect(false)
  assert.deepEqual((await readonly.listTools()).tools.map((tool) => tool.name).sort(), ['get_item', 'get_workspace', 'list_items', 'list_workspaces'])
  const workspaces = await readonly.callTool({ name: 'list_workspaces', arguments: {} })
  assert.equal(workspaces.isError, false)
  assert.ok(JSON.stringify(workspaces).includes(task.wid))
  const badWorkspace = await readonly.callTool({ name: 'list_items', arguments: { workspaceId: '00000000-0000-4000-8000-000000000000' } })
  assert.equal(badWorkspace.isError, true)
  const writer = await connect(true)
  assert.equal((await writer.listTools()).tools.length, 7)
  const created = await writer.callTool({ name: 'create_item', arguments: { workspaceId: task.wid, nodeId, title: 'Created through MCP', description: '' } })
  assert.equal(created.isError, false, JSON.stringify(created))
  assert.equal((api.db.prepare('SELECT count(*) AS n FROM items').get() as any).n, 2)
  const firstPage = await readonly.callTool({ name: 'list_items', arguments: { workspaceId: task.wid, limit: 1 } })
  assert.equal(firstPage.isError, false)
  const pageOne = JSON.parse((firstPage.content as { text: string }[])[0].text) as { items: { id: string }[]; nextCursor: string }
  assert.equal(pageOne.items.length, 1)
  assert.equal(typeof pageOne.nextCursor, 'string')
  const nextPage = await readonly.callTool({ name: 'list_items', arguments: { workspaceId: task.wid, limit: 1, cursor: pageOne.nextCursor } })
  const pageTwo = JSON.parse((nextPage.content as { text: string }[])[0].text) as { items: { id: string }[]; nextCursor: string | null }
  assert.equal(nextPage.isError, false)
  assert.equal(pageTwo.items.length, 1)
  assert.equal(pageTwo.nextCursor, null)
  assert.equal(new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id)).size, 2)
  assert.equal((await readonly.callTool({ name: 'list_items', arguments: { workspaceId: task.wid, limit: 1, cursor: pageOne.nextCursor, search: 'different filter' } })).isError, true)
  const createdRow = api.db.prepare('SELECT id,updatedAt FROM items WHERE workspaceId=? AND title=?').get(task.wid, 'Created through MCP') as { id: string; updatedAt: string }
  const update = await writer.callTool({ name: 'update_item', arguments: { workspaceId: task.wid, itemId: createdRow.id, status: 'done', expectedUpdatedAt: createdRow.updatedAt } })
  assert.equal(update.isError, false)
  assert.equal((api.db.prepare('SELECT status FROM items WHERE id=?').get(createdRow.id) as { status: string }).status, 'done')
  assert.equal((await writer.callTool({ name: 'update_item', arguments: { workspaceId: task.wid, itemId: createdRow.id, status: 'todo', expectedUpdatedAt: createdRow.updatedAt } })).isError, true)
  assert.equal((await writer.callTool({ name: 'delete_item', arguments: { workspaceId: task.wid, itemId: createdRow.id } })).isError, false)
  assert.equal(api.db.prepare('SELECT id FROM items WHERE id=?').get(createdRow.id), undefined)
  const project = api.db.prepare("SELECT id FROM nodes WHERE workspaceId=? AND kind='project'").get(task.wid) as { id: string }
  const config = await api.request(`/workspaces/${task.wid}/projects/${project.id}/fields`, { token: owner.token })
  const configuration = await config.json() as { statuses: unknown[] }
  const statuses = [...configuration.statuses, { id: 'custom-ready', name: 'Custom ready', color: '#123456', completed: false }]
  assert.equal((await api.request(`/workspaces/${task.wid}/projects/${project.id}/fields`, { method: 'PATCH', token: owner.token, body: { statuses } })).status, 200)
  const checklist = await api.request(`/workspaces/${task.wid}/fields`, { method: 'POST', token: owner.token, body: { name: 'MCP checks', type: 'checklist', options: ['One', 'Two'] } })
  assert.equal(checklist.status, 201)
  const checklistField = await checklist.json() as { id: string }
  const custom = await writer.callTool({ name: 'update_item', arguments: { workspaceId: task.wid, itemId: task.id, status: 'custom-ready', customFields: { [checklistField.id]: ['Two'] } } })
  assert.equal(custom.isError, false, JSON.stringify(custom))
  const filtered = await readonly.callTool({ name: 'list_items', arguments: { workspaceId: task.wid, status: 'custom-ready' } })
  assert.equal(filtered.isError, false)
  const customItem = JSON.parse((filtered.content as { text: string }[])[0].text).items[0]
  assert.equal(customItem.status, 'custom-ready')
  assert.deepEqual(customItem.customFields[checklistField.id], ['Two'])
  api.db.prepare('DELETE FROM tokens WHERE userId=?').run(owner.id)
  assert.equal((await writer.callTool({ name: 'get_item', arguments: { workspaceId: task.wid, itemId: task.id } })).isError, true)
  assert.equal((await readonly.callTool({ name: 'list_items', arguments: { workspaceId: task.wid, cursor: pageOne.nextCursor } })).isError, true)
})

test('MCP SSE is admin-controlled, bearer-only and workspace-scoped', { timeout: 30000 }, async (t) => {
  const api = await integrationServer(t)
  const admin = api.user(true)
  const member = api.user()
  const outsider = api.user()
  const task = await api.item(member.token)
  assert.equal((await fetch(`${api.base}/api/v1/mcp/sse`, { headers: { authorization: `Bearer ${member.token}` } })).status, 404)
  assert.equal((await api.request('/site/settings', { method: 'PATCH', token: member.token, body: { mcpSseEnabled: true } })).status, 403)
  const enabled = await api.request('/site/settings', { method: 'PATCH', token: admin.token, body: { mcpSseEnabled: true } })
  assert.equal(enabled.status, 200, await enabled.clone().text())
  assert.equal((await fetch(`${api.base}/api/v1/mcp/sse`)).status, 401, 'browser cookies and anonymous requests cannot authenticate MCP')

  const client = new Client({ name: 'hopya-sse-test', version: '1.0' })
  const transport = new SSEClientTransport(new URL(`${api.base}/api/v1/mcp/sse`), { requestInit: { headers: { authorization: `Bearer ${member.token}` } } })
  t.after(() => client.close())
  await client.connect(transport)
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ['get_item', 'get_workspace', 'list_items', 'list_workspaces'])
  assert.ok(JSON.stringify(await client.callTool({ name: 'list_workspaces', arguments: {} })).includes(task.wid))
  const foreign = await client.callTool({ name: 'list_items', arguments: { workspaceId: (await api.item(outsider.token)).wid } })
  assert.equal(foreign.isError, true)

  api.db.prepare('DELETE FROM tokens WHERE userId=?').run(member.id)
  await assert.rejects(() => client.callTool({ name: 'get_item', arguments: { workspaceId: task.wid, itemId: task.id } }))
  const disabled = await api.request('/site/settings', { method: 'PATCH', token: admin.token, body: { mcpSseEnabled: false } })
  assert.equal(disabled.status, 200)
})

test('MCP cancels oversized multibyte responses before buffering the entire upstream body', { timeout: 30000 }, async (t) => {
  const frame = Buffer.from(JSON.stringify('\u754c'.repeat(32768)) + ',')
  let sent = 0; let finish!: () => void
  const closed = new Promise<void>((resolve) => { finish = resolve })
  const mock = createServer((_req, response) => {
    response.setHeader('content-type', 'application/json')
    response.once('close', finish)
    response.write('[')
    let count = 0
    const pump = () => {
      if (response.destroyed || response.writableEnded) return
      if (count++ === 256) { response.end('null]'); return }
      sent += frame.byteLength
      // Pace the fixture so sent bytes test cancellation, not how much the
      // kernel can buffer while the child is competing for CPU time.
      if (response.write(frame)) setTimeout(pump, 2)
      else response.once('drain', () => setTimeout(pump, 2))
    }
    pump()
  }).listen(0, '127.0.0.1')
  await once(mock, 'listening')
  t.after(() => new Promise<void>((resolve) => { mock.closeAllConnections(); mock.close(() => resolve()) }))
  const client = new Client({ name: 'mcp-byte-bound-test', version: '1.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args: process.env.HOPYA_TEST_BUILD === 'true' ? [fileURLToPath(new URL('../build/bin/mcp.js', import.meta.url))] : ['--import', 'tsx', fileURLToPath(new URL('../bin/mcp.ts', import.meta.url))],
    env: { PATH: process.env.PATH || '', HOPYA_API_URL: `http://127.0.0.1:${(mock.address() as { port: number }).port}`, HOPYA_API_TOKEN: 'a'.repeat(43) }, stderr: 'pipe' })
  t.after(() => client.close())
  await client.connect(transport)
  const result = await client.callTool({ name: 'list_workspaces', arguments: {} })
  assert.equal(result.isError, true)
  assert.match((result.content as { text: string }[])[0].text, /Response too large/)
  await closed
  assert.ok(sent < frame.byteLength * 256, 'Client must cancel instead of collecting the full response')
  assert.ok(sent < 12 * 1024 * 1024, 'Byte-bound cancellation must precede the old character-based limit')
})
