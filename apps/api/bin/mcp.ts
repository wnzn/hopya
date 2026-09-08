import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from '../app/mcp_tools.js'

const token = process.env.HOPYA_API_TOKEN
const base = new URL(process.env.HOPYA_API_URL || 'http://localhost:8080')
if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('Set HOPYA_API_TOKEN to a Hopya personal API token')
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('HOPYA_API_URL must be an HTTP(S) origin without credentials or a path')

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
const server = createMcpServer(request)
await server.connect(new StdioServerTransport())
