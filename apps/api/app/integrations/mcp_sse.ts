import type { HttpContext, Router } from '@adonisjs/core/http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { authenticate, db, service } from '../core.js'
import { scheduleFlush } from '../automations.js'
import { createMcpServer, type McpResult } from '../mcp_tools.js'
import { HttpError } from '../types.js'

const sessions = new Map<string, { userId: string; transport: SSEServerTransport; timer: NodeJS.Timeout }>()
const SESSION_LIMIT = 32
const USER_SESSION_LIMIT = 4
const SESSION_TTL_MS = 30 * 60 * 1000
const MESSAGE_LIMIT = 4 * 1024 * 1024

async function enabled(): Promise<boolean> {
  return (await db.get<{ value: string }>("SELECT value FROM site_settings WHERE key='mcpSseEnabled'"))?.value === '1'
}

async function bearerUser(ctx: HttpContext) {
  if (!/^Bearer\s+[A-Za-z0-9_-]{32,256}$/i.test(ctx.request.header('authorization') || '')) throw new HttpError(401, 'Bearer token required')
  return authenticate(ctx)
}

async function result(operation: () => unknown | Promise<unknown>, mutation = false): Promise<McpResult> {
  try {
    const value = await operation()
    if (mutation) scheduleFlush()
    const text = JSON.stringify(value ?? null)
    if (Buffer.byteLength(text) > MESSAGE_LIMIT) return { isError: true, content: [{ type: 'text', text: 'Response too large; request a smaller page or use the REST API.' }] }
    return { content: [{ type: 'text', text }] }
  } catch (error) {
    const text = error instanceof HttpError ? error.message : 'Hopya could not complete the request.'
    return { isError: true, content: [{ type: 'text', text }] }
  }
}

function requestFor(userId: string) {
  return async (path: string, method = 'GET', body?: unknown): Promise<McpResult> => {
    if (path === '/workspaces' && method === 'GET') return result(() => service.listWorkspaces(userId))
    const workspace = path.match(/^\/workspaces\/([0-9a-f-]+)$/i)
    if (workspace && method === 'GET') return result(() => service.getWorkspace(userId, workspace[1]))
    const page = path.match(/^\/workspaces\/([0-9a-f-]+)\/items\/page\?(.*)$/i)
    if (page && method === 'GET') return result(() => service.pageItems(userId, page[1], Object.fromEntries(new URLSearchParams(page[2]))))
    const collection = path.match(/^\/workspaces\/([0-9a-f-]+)\/items$/i)
    if (collection && method === 'POST') return result(() => service.createItem(userId, collection[1], body), true)
    const item = path.match(/^\/workspaces\/([0-9a-f-]+)\/items\/([0-9a-f-]+)$/i)
    if (item && method === 'GET') return result(() => service.getItem(userId, item[1], item[2]))
    if (item && method === 'PATCH') return result(() => service.updateItem(userId, item[1], item[2], body), true)
    if (item && method === 'DELETE') return result(() => service.deleteItem(userId, item[1], item[2]), true)
    return { isError: true, content: [{ type: 'text', text: 'Unsupported MCP operation.' }] }
  }
}

async function removeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  clearTimeout(session.timer)
  await session.transport.close().catch(() => {})
}

export async function closeMcpSseSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map(removeSession))
}

export function registerMcpSse(router: Router): void {
  router.get('/api/v1/mcp/sse', async (ctx) => {
    if (!await enabled()) throw new HttpError(404, 'Not found')
    const user = await bearerUser(ctx)
    if (sessions.size >= SESSION_LIMIT || [...sessions.values()].filter((session) => session.userId === user.id).length >= USER_SESSION_LIMIT) {
      ctx.response.header('Retry-After', '5')
      throw new HttpError(429, 'Too many MCP sessions')
    }
    const transport = new SSEServerTransport('/api/v1/mcp/messages', ctx.response.response)
    const server = createMcpServer(requestFor(user.id))
    const sessionId = transport.sessionId
    const timer = setTimeout(() => void removeSession(sessionId), SESSION_TTL_MS)
    timer.unref()
    sessions.set(sessionId, { userId: user.id, transport, timer })
    transport.onclose = () => {
      const session = sessions.get(sessionId)
      if (session) clearTimeout(session.timer)
      sessions.delete(sessionId)
    }
    await server.connect(transport)
  })

  router.post('/api/v1/mcp/messages', async (ctx) => {
    if (!await enabled()) throw new HttpError(404, 'Not found')
    const user = await bearerUser(ctx)
    const sessionId = ctx.request.qs().sessionId
    if (typeof sessionId !== 'string' || sessionId.length > 64) throw new HttpError(400, 'Invalid MCP session')
    const session = sessions.get(sessionId)
    if (!session || session.userId !== user.id) throw new HttpError(404, 'MCP session not found')
    const body = ctx.request.body()
    if (Buffer.byteLength(JSON.stringify(body)) > MESSAGE_LIMIT) throw new HttpError(413, 'MCP message too large')
    await session.transport.handlePostMessage(ctx.request.request, ctx.response.response, body)
  })
}
