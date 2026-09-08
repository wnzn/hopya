import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const token = process.env.HOPYA_API_TOKEN
const base = new URL(process.env.HOPYA_API_URL || 'http://localhost:8080')
if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Set HOPYA_API_TOKEN to a Hopya personal API token')
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('HOPYA_API_URL must be an HTTP(S) origin without credentials or a path')
const server = new McpServer({ name: 'hopya', version: '0.1.0' })
const wid = z.string().uuid().describe('Workspace ID, obtained from list_workspaces')
const itemId = z.string().uuid()
const status = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent'])
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()

async function request(path: string, method = 'GET', body?: unknown) {
  try {
    const response = await fetch(new URL(`/api/v1${path}`, base), {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000),
    })
    const chunks: Uint8Array[] = []
    let bytes = 0
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 4 * 1024 * 1024) return { isError: true, content: [{ type: 'text' as const, text: 'Response too large; request a smaller page or use the REST API.' }] }
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return { isError: !response.ok, content: [{ type: 'text' as const, text }] }
  } catch { return { isError: true, content: [{ type: 'text' as const, text: 'Hopya API unavailable. Check endpoint, certificate, and token configuration.' }] } }
}
const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
server.registerTool('list_workspaces', { description: 'List workspaces accessible to the authenticated account.', annotations: read }, () => request('/workspaces'))
server.registerTool('get_workspace', { description: 'Read authorized workspace hierarchy, custom fields, members and roles.', inputSchema: { workspaceId: wid }, annotations: read }, ({ workspaceId }) => request(`/workspaces/${workspaceId}`))
server.registerTool('list_items', { description: 'Read one bounded task page. Returns items and nextCursor; follow a non-null cursor with the same workspace/filters to continue. Default 200, maximum 500 items. Not a cross-request snapshot.', inputSchema: { workspaceId: wid, nodeId: itemId.optional(), search: z.string().max(300).optional(), status: status.optional(), limit: z.number().int().min(1).max(500).optional(), cursor: z.string().min(1).max(1024).optional() }, annotations: read }, ({ workspaceId, ...filters }) => {
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))
  return request(`/workspaces/${workspaceId}/items/page?${query}`)
})
server.registerTool('get_item', { description: 'Read one task with workspace permission checks.', inputSchema: { workspaceId: wid, itemId }, annotations: read }, ({ workspaceId, itemId }) => request(`/workspaces/${workspaceId}/items/${itemId}`))

// Default is read-only. This switch is operator consent to expose write tools,
// not proof of per-action human consent. The MCP host must enforce its own UI
// approval policy; a model-supplied boolean would not establish human approval.
if (process.env.HOPYA_MCP_ALLOW_WRITES === 'true') {
  const fields = { title: z.string().min(1).max(300), nodeId: itemId, description: z.string().max(50000).optional(), status: status.optional(), priority: priority.optional(), startDate: date.optional(), dueDate: date.optional(), tags: z.array(z.string().max(60)).max(30).optional(), assigneeId: itemId.nullable().optional(), customFields: z.record(z.string().uuid(), z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.array(z.string().min(1).max(120)).max(100), z.null()])).refine((values) => Object.keys(values).length <= 100).optional() }
  server.registerTool('create_item', { description: 'Create a task. Host MUST obtain human approval before calling. Requires items:write.', inputSchema: { workspaceId: wid, ...fields }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, ({ workspaceId, ...input }) => request(`/workspaces/${workspaceId}/items`, 'POST', input))
  server.registerTool('update_item', { description: 'Update a task. Host MUST obtain human approval. Pass expectedUpdatedAt from get_item to prevent stale overwrites.', inputSchema: { workspaceId: wid, itemId, ...fields, title: fields.title.optional(), nodeId: fields.nodeId.optional(), expectedUpdatedAt: z.string().datetime().optional() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, ({ workspaceId, itemId, ...input }) => request(`/workspaces/${workspaceId}/items/${itemId}`, 'PATCH', input))
  server.registerTool('delete_item', { description: 'Permanently delete a task and its attachment references. Host MUST obtain human approval.', inputSchema: { workspaceId: wid, itemId }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }, ({ workspaceId, itemId }) => request(`/workspaces/${workspaceId}/items/${itemId}`, 'DELETE'))
}
await server.connect(new StdioServerTransport())
