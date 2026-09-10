import type { HttpContext, Router } from '@adonisjs/core/http'
import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import { audit, db } from './core.js'
import { authenticate } from './security.js'
import { requirePermission, service } from './service.js'
import { HttpError } from './types.js'
import { applyCredential, assertSafeDestination, redactCredentialOutput } from './automation_credentials.js'
import { automationContext, type AutomationCausation } from './automation_context.js'
import { nodePathPattern, nodeReferencePattern, remediateLegacyConfig, upstreamReferenceErrors } from './automation_graph_validation.js'
import { outboundHttpError, pinnedRequestEffect, resolvePinnedDestination } from './pinned_http.js'

const nodeId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/)
const position = z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict()
export const graphNodeTypes = ['trigger', 'http', 'webhook', 'email', 'log', 'update_item', 'condition', 'switch'] as const
export type GraphNodeType = typeof graphNodeTypes[number]
const graphNode = z.object({ id: nodeId, type: z.enum(graphNodeTypes), position, config: z.record(z.string(), z.unknown()).refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024, 'Node config is too large') }).strict()
const graphEdge = z.object({ id: nodeId, source: nodeId, target: nodeId, branch: z.string().min(1).max(100).optional() }).strict()
export const graphSchema = z.object({ nodes: z.array(graphNode).max(50), edges: z.array(graphEdge).max(75) }).strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024, 'Automation graph is too large')
export type AutomationGraph = z.output<typeof graphSchema>

const triggerConfig = z.object({ event: z.enum(['item.created', 'item.updated', 'item.deleted', 'node.created', 'node.updated', 'node.deleted', 'field.changed']) }).strict()
const publicHeaders = z.record(z.string().max(100), z.string().max(2000)).refine((headers) => Object.keys(headers).length <= 20, 'Too many headers')
const requestConfig = z.object({
  url: z.string().url().max(2000), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'), headers: publicHeaders.default({}),
  body: z.string().max(20000).optional(), credentialId: z.string().uuid().optional(), legacyHeaderMigrationRequired: z.literal(true).optional(),
}).strict()
const webhookConfig = requestConfig.extend({ method: z.enum(['POST', 'PUT', 'PATCH']).default('POST') }).strict()
const emailConfig = z.object({ to: z.array(z.string().email().max(254)).min(1).max(10), subject: z.string().min(1).max(200) }).strict()
const logConfig = z.object({ message: z.string().max(2000) }).strict()
const updateConfig = z.object({ patch: z.object({
  title: z.string().trim().min(1).max(300).optional(), description: z.string().max(50000).optional(), status: z.string().min(1).max(64).optional(),
  priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(), startDate: z.string().max(64).nullable().optional(), dueDate: z.string().max(64).nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(), tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'Update patch is empty') }).strict()
const conditionConfig = z.object({ path: z.string().min(1).max(200), operator: z.enum(['equals', 'not_equals', 'exists', 'contains']), value: z.unknown().optional() }).strict()
const switchConfig = z.object({ path: z.string().min(1).max(200), cases: z.array(z.object({ branch: z.string().min(1).max(100), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }).strict()).min(1).max(20), defaultBranch: z.string().min(1).max(100) }).strict()
  .refine((value) => new Set(value.cases.map((entry) => entry.branch)).size === value.cases.length, 'Switch case branches must be unique')
const configs = { trigger: triggerConfig, http: requestConfig, webhook: webhookConfig, email: emailConfig, log: logConfig, update_item: updateConfig, condition: conditionConfig, switch: switchConfig } as const
const sensitiveHeaders = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive', 'x-api-key', 'api-key', 'apikey', 'x-auth-token', 'x-access-token'])
const unsafePublicHeaderNode = (graph: AutomationGraph) => graph.nodes.find((node) => (node.type === 'http' || node.type === 'webhook') && Object.keys((node.config.headers as Record<string, string> | undefined) ?? {}).some((name) => sensitiveHeaders.has(name.toLowerCase())))

export const automationCatalog = {
  limits: { maxNodes: 50, maxEdges: 75, maxGraphBytes: 262144, maxNodeConfigBytes: 32768, maxExecutionNodes: 50 },
  events: [
    { type: 'item.created', output: { event: 'string', workspaceId: 'string', item: { id: 'string', workspaceId: 'string', title: 'string', description: 'string', status: 'string', priority: 'string', nodeId: 'string', assigneeId: 'string|null', startDate: 'date|null', dueDate: 'date|null', tags: 'string[]', customFields: 'record', checklist: 'record[]', parentId: 'string|null', archivedAt: 'datetime|null', createdAt: 'datetime', updatedAt: 'datetime' }, itemId: 'string', actorId: 'string|null', at: 'datetime' } },
    { type: 'item.updated', output: { event: 'string', workspaceId: 'string', item: { id: 'string', workspaceId: 'string', title: 'string', description: 'string', status: 'string', priority: 'string', nodeId: 'string', assigneeId: 'string|null', startDate: 'date|null', dueDate: 'date|null', tags: 'string[]', customFields: 'record', checklist: 'record[]', parentId: 'string|null', archivedAt: 'datetime|null', createdAt: 'datetime', updatedAt: 'datetime' }, itemId: 'string', changes: 'record', actorId: 'string|null', at: 'datetime' } },
    { type: 'item.deleted', output: { event: 'string', workspaceId: 'string', item: { id: 'string', workspaceId: 'string', title: 'string', description: 'string', status: 'string', priority: 'string', nodeId: 'string', assigneeId: 'string|null', startDate: 'date|null', dueDate: 'date|null', tags: 'string[]', customFields: 'record', checklist: 'record[]', parentId: 'string|null', archivedAt: 'datetime|null', createdAt: 'datetime', updatedAt: 'datetime' }, itemId: 'string', actorId: 'string|null', at: 'datetime' } },
    { type: 'node.created', output: { event: 'string', workspaceId: 'string', nodeId: 'string', actorId: 'string|null', at: 'datetime' } },
    { type: 'node.updated', output: { event: 'string', workspaceId: 'string', nodeId: 'string', changes: 'record', actorId: 'string|null', at: 'datetime' } },
    { type: 'node.deleted', output: { event: 'string', workspaceId: 'string', nodeId: 'string', actorId: 'string|null', at: 'datetime' } },
    { type: 'field.changed', output: { event: 'string', workspaceId: 'string', fieldId: 'string', changes: 'record', actorId: 'string|null', at: 'datetime' } },
  ],
  nodes: [
    { type: 'trigger', kind: 'trigger', inputs: {}, outputs: { event: 'EventPayload' }, config: { event: { type: 'event', required: true } } },
    { type: 'http', kind: 'action', inputs: { event: 'EventPayload', upstream: 'unknown' }, outputs: { body: 'string', status: 'number' }, config: { url: { type: 'url', required: true }, method: { type: 'enum', values: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, headers: { type: 'headers' }, body: { type: 'template' }, credentialId: { type: 'credential' } } },
    { type: 'webhook', kind: 'action', inputs: { event: 'EventPayload' }, outputs: { body: 'string', status: 'number' }, config: { url: { type: 'url', required: true }, method: { type: 'enum', values: ['POST', 'PUT', 'PATCH'] }, credentialId: { type: 'credential' } } },
    { type: 'email', kind: 'action', inputs: { event: 'EventPayload' }, outputs: { messageId: 'string' }, config: { to: { type: 'email[]', required: true }, subject: { type: 'template', required: true } } },
    { type: 'log', kind: 'action', inputs: { event: 'EventPayload', upstream: 'unknown' }, outputs: { message: 'string' }, config: { message: { type: 'template', required: true } } },
    { type: 'update_item', kind: 'action', inputs: { itemId: 'string', item: 'Item' }, outputs: { item: { id: 'string', title: 'string', status: 'string', priority: 'string', nodeId: 'string', assigneeId: 'string|null', startDate: 'date|null', dueDate: 'date|null', tags: 'string[]', updatedAt: 'datetime' } }, config: { patch: { type: 'itemPatch', required: true } } },
    { type: 'condition', kind: 'control', inputs: { event: 'EventPayload', upstream: 'node.output' }, outputs: { matched: 'boolean', branch: 'string' }, config: { path: { type: 'dataPath', required: true }, operator: { type: 'enum', values: ['equals', 'not_equals', 'exists', 'contains'] }, value: { type: 'unknown' } } },
    { type: 'switch', kind: 'control', inputs: { event: 'EventPayload', upstream: 'node.output' }, outputs: { branch: 'string' }, config: { path: { type: 'dataPath', required: true }, cases: { type: 'switchCases' }, defaultBranch: { type: 'string' } } },
  ],
} as const

export function linearGraph(event: string, steps: { type: string; config: unknown }[]): AutomationGraph {
  const nodes: AutomationGraph['nodes'] = [{ id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, config: { event } }]
  const ids = steps.map((_step, index) => `step-${index + 1}`), types = steps.map((step) => step.type)
  for (const [index, step] of steps.entries()) nodes.push({ id: ids[index]!, type: step.type as GraphNodeType, position: { x: 300 * (index + 1), y: 0 }, config: remediateLegacyConfig(step.config, ids, types) })
  return { nodes, edges: nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, source: nodes[index]!.id, target: node.id })) }
}

export function graphErrors(graph: AutomationGraph): string[] {
  const errors: string[] = [], ids = new Set<string>(), edgeIds = new Set<string>()
  const triggerEvent = graph.nodes.find((node) => node.type === 'trigger')?.config.event
  for (const node of graph.nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`); ids.add(node.id)
    const parsed = configs[node.type].safeParse(node.config); if (!parsed.success) errors.push(`Invalid ${node.type} config on node ${node.id}`)
    if (node.config.legacyHeaderMigrationRequired === true) errors.push(`Node ${node.id} requires legacy header migration`)
    if (node.type === 'http' || node.type === 'webhook') for (const name of Object.keys((node.config.headers as Record<string, string> | undefined) ?? {})) if (sensitiveHeaders.has(name.toLowerCase())) errors.push(`Sensitive or hop-by-hop header is not allowed on node ${node.id}`)
    if (node.type === 'update_item' && triggerEvent !== 'item.created' && triggerEvent !== 'item.updated') errors.push(`update_item node ${node.id} requires an item.created or item.updated trigger`)
  }
  const triggers = graph.nodes.filter((node) => node.type === 'trigger'); if (triggers.length !== 1) errors.push('Graph must contain exactly one trigger')
  const outgoing = new Map<string, typeof graph.edges>(), incoming = new Map<string, typeof graph.edges>()
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) errors.push(`Duplicate edge id: ${edge.id}`); edgeIds.add(edge.id)
    if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push(`Edge ${edge.id} references an unknown node`)
    outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge]); incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge])
  }
  for (const node of graph.nodes) {
    const outs = outgoing.get(node.id) ?? []
    if (!['condition', 'switch'].includes(node.type) && outs.length > 1) errors.push(`Node ${node.id} creates parallel control flow`)
    if (node.type === 'condition' && (outs.length !== 2 || new Set(outs.map((edge) => edge.branch)).size !== 2 || !outs.some((edge) => edge.branch === 'true') || !outs.some((edge) => edge.branch === 'false'))) errors.push(`Condition ${node.id} requires true and false edges`)
    if (node.type === 'switch') {
      const parsed = switchConfig.safeParse(node.config)
      if (parsed.success) {
        const expected = new Set([...parsed.data.cases.map((entry) => entry.branch), parsed.data.defaultBranch]), counts = new Map<string | undefined, number>()
        for (const edge of outs) counts.set(edge.branch, (counts.get(edge.branch) ?? 0) + 1)
        if (outs.length !== expected.size || [...expected].some((branch) => counts.get(branch) !== 1) || [...counts.keys()].some((branch) => branch === undefined || !expected.has(branch))) errors.push(`Switch ${node.id} requires exactly one edge for every selectable branch`)
      }
    }
    if (node.type === 'trigger' && (incoming.get(node.id)?.length ?? 0) > 0) errors.push('Trigger cannot have incoming edges')
  }
  if (triggers[0]) {
    const visiting = new Set<string>(), visited = new Set<string>()
    const walk = (id: string) => { if (visiting.has(id)) { errors.push('Graph must be acyclic'); return }; if (visited.has(id)) return; visiting.add(id); for (const edge of outgoing.get(id) ?? []) walk(edge.target); visiting.delete(id); visited.add(id) }
    walk(triggers[0].id); for (const id of ids) if (!visited.has(id)) errors.push(`Node ${id} is unreachable from the trigger`)
    if (!errors.includes('Graph must be acyclic')) errors.push(...upstreamReferenceErrors(graph, automationCatalog))
  }
  return [...new Set(errors)]
}

async function validateCredentials(wid: string, graph: AutomationGraph, resolveNetwork = true): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  for (const node of graph.nodes) {
    if (node.type !== 'http' && node.type !== 'webhook') continue
    if (resolveNetwork) await assertSafeDestination(String(node.config.url), Boolean(node.config.credentialId))
    if (!node.config.credentialId) continue
    const credential = await db.get<{ version: number; origin: string; pathPrefix: string | null }>("SELECT version,origin,pathPrefix FROM automation_credentials WHERE workspaceId=? AND id=? AND status='active'", wid, node.config.credentialId)
    if (!credential) throw new HttpError(400, `Credential on node ${node.id} is unavailable`)
    const destination = new URL(String(node.config.url))
    if (destination.origin !== credential.origin || credential.pathPrefix && !(destination.pathname === credential.pathPrefix || destination.pathname.startsWith(`${credential.pathPrefix.replace(/\/$/, '')}/`))) throw new HttpError(400, `Credential binding does not match node ${node.id}`)
    result.set(node.id, credential.version)
  }
  return result
}

interface VersionRow extends Record<string, unknown> { workspaceId: string; automationId: string; version: number; format: string; graph: string; publisherId: string | null; publishedAt: string }
interface GraphRun extends Record<string, unknown> { id: string; workspaceId: string; automationId: string | null; automationVersion: number | null; event: string; causation: string; leaseId?: string | null }
export async function initializeGraphRun(runId: string, wid: string, automationId: string, version: number): Promise<boolean> {
  const row = await db.get<VersionRow>("SELECT * FROM automation_versions WHERE workspaceId=? AND automationId=? AND version=? AND format='graph'", wid, automationId, version)
  if (!row) return false
  const graph = graphSchema.parse(JSON.parse(row.graph))
  for (const node of graph.nodes) await db.run("INSERT INTO automation_node_runs (id,workspaceId,runId,nodeId,type,status) VALUES (?,?,?,?,?,'pending')", randomUUID(), wid, runId, node.id, node.type)
  return true
}

const valueAt = (root: unknown, path: string): unknown => path.split('.').filter(Boolean).reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, root)
const sanitize = (value: string, limit: number) => Buffer.from(value
  .replace(/("(?:password|passwd|token|secret|api[-_]?key)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
  .replace(/(authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
  .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
  .replace(/((?:password|passwd|token|secret|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]'))
  .subarray(0, limit).toString('utf8')
const display = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value)
const resolvePath = (path: string, payload: Record<string, unknown>, outputs: Map<string, unknown>): unknown => {
  const node = path.match(nodePathPattern)
  if (node) return valueAt(outputs.get(node[1]!), node[2] ?? '')
  return valueAt(payload, path.startsWith('event.') ? path.slice(6) : path)
}
const resolveTemplates = (value: unknown, payload: Record<string, unknown>, outputs: Map<string, unknown>): unknown => {
  if (typeof value === 'string') return value.replace(/\{\{event\.([A-Za-z0-9_.]+)\}\}/g, (_all, path: string) => display(valueAt(payload, path))).replace(nodeReferencePattern, (_all, id: string, path: string | undefined) => display(valueAt(outputs.get(id), path ?? '')))
  if (Array.isArray(value)) return value.map((entry) => resolveTemplates(entry, payload, outputs))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveTemplates(entry, payload, outputs)]))
  return value
}
function boundedOutput(output: unknown): string {
  const encoded = sanitize(JSON.stringify(output ?? null), 8192)
  try { JSON.parse(encoded); return encoded } catch { return JSON.stringify({ truncated: true, previewBase64: Buffer.from(sanitize(JSON.stringify(output ?? null), 6000)).toString('base64') }) }
}
class LeaseLost extends Error {}
async function heartbeat(run: GraphRun): Promise<void> {
  if (!run.leaseId) throw new LeaseLost('Automation lease is unavailable')
  const result = await db.run("UPDATE automation_runs SET heartbeatAt=? WHERE workspaceId=? AND id=? AND status='running' AND leaseId=?", new Date().toISOString(), run.workspaceId, run.id, run.leaseId)
  if (!result.changes) throw new LeaseLost('Automation lease was lost')
}
async function markNode(run: GraphRun, nodeId: string, status: string, output: unknown = null, log = '') {
  const timestamp = new Date().toISOString()
  const result = await db.run(`UPDATE automation_node_runs SET status=?,output=?,log=?,startedAt=COALESCE(startedAt,?),completedAt=?
    WHERE workspaceId=? AND runId=? AND nodeId=? AND EXISTS (SELECT 1 FROM automation_runs WHERE id=? AND workspaceId=? AND status='running' AND leaseId=?)`,
  status, boundedOutput(output), sanitize(log, 2000), timestamp, timestamp, run.workspaceId, run.id, nodeId, run.id, run.workspaceId, run.leaseId)
  if (!result.changes) throw new LeaseLost('Automation lease was lost')
  await heartbeat(run)
}
async function startNode(run: GraphRun, nodeId: string): Promise<void> {
  const timestamp = new Date().toISOString()
  const result = await db.run(`UPDATE automation_node_runs SET status='running',attempt=attempt+1,startedAt=?,completedAt=NULL
    WHERE workspaceId=? AND runId=? AND nodeId=? AND EXISTS (SELECT 1 FROM automation_runs WHERE id=? AND workspaceId=? AND status='running' AND leaseId=?)`,
  timestamp, run.workspaceId, run.id, nodeId, run.id, run.workspaceId, run.leaseId)
  if (!result.changes) throw new LeaseLost('Automation lease was lost')
  await heartbeat(run)
}
async function action(node: AutomationGraph['nodes'][number], run: GraphRun, payload: Record<string, unknown>, outputs: Map<string, unknown>, publisherId: string | null): Promise<{ output: unknown; log: string }> {
  const config = resolveTemplates(configs[node.type].parse(node.config), payload, outputs) as Record<string, unknown>
  if (node.type === 'log') return { output: { message: String(config.message) }, log: String(config.message) }
  if (node.type === 'update_item') {
    if (!publisherId) throw new HttpError(403, 'Automation publisher is unavailable')
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : undefined; if (!itemId) throw new HttpError(400, 'Trigger has no task to update')
    const causation = JSON.parse(run.causation || '{}') as AutomationCausation
    if ((causation.depth ?? 0) >= 5 || (causation.automationIds ?? []).includes(run.automationId!)) throw new HttpError(409, 'Automation re-entry limit reached')
    await requirePermission(publisherId, run.workspaceId, 'items:read'); await requirePermission(publisherId, run.workspaceId, 'items:write')
    const item = await automationContext.run({ depth: (causation.depth ?? 0) + 1, automationIds: [...causation.automationIds ?? [], run.automationId!] }, () => service.updateItem(publisherId, run.workspaceId, itemId, config.patch))
    const { id, title, status, priority, nodeId, assigneeId, startDate, dueDate, tags, updatedAt } = item
    return { output: { item: { id, title, status, priority, nodeId, assigneeId, startDate, dueDate, tags, updatedAt } }, log: 'Triggering task updated' }
  }
  if (node.type === 'email') {
    if (!process.env.SMTP_URL) throw new HttpError(503, 'SMTP is not configured')
    const nodemailer = (await import('nodemailer' as string)).default as { createTransport: (url: string) => { sendMail: (mail: Record<string, unknown>) => Promise<{ messageId: string }>; close: () => void } }
    const transport = nodemailer.createTransport(process.env.SMTP_URL)
    try {
      const sent = Effect.tryPromise({ try: () => transport.sendMail({ to: (config.to as string[]).join(', '), subject: config.subject, text: JSON.stringify(payload) }), catch: () => new HttpError(502, 'Email delivery failed') })
        .pipe(Effect.timeoutFail({ duration: '15 seconds', onTimeout: () => new HttpError(502, 'Email delivery timed out') }), Effect.either)
      const result = await Effect.runPromise(sent); if (result._tag === 'Left') throw result.left
      return { output: { messageId: result.right.messageId }, log: 'Email delivered' }
    } finally { transport.close() }
  }
  if (node.type === 'http' || node.type === 'webhook') {
    const destination = await resolvePinnedDestination(String(config.url), Boolean(config.credentialId)), headers = { ...(config.headers as Record<string, string>) }
    let redactions: string[] = []
    if (config.credentialId) {
      const ref = await db.get<{ credentialVersion: number }>('SELECT credentialVersion FROM automation_version_credentials WHERE workspaceId=? AND automationId=? AND automationVersion=? AND nodeId=?', run.workspaceId, run.automationId, run.automationVersion, node.id)
      if (!ref) throw new HttpError(400, 'Published credential reference is unavailable')
      const applied = await applyCredential(run.workspaceId, String(config.credentialId), destination.url, headers); redactions = applied.redactions
    }
    const method = String(config.method), body = ['GET'].includes(method) ? undefined : String(config.body ?? JSON.stringify(payload))
    if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
    const outcome = await Effect.runPromise(Effect.either(pinnedRequestEffect(destination, { method, headers, body, timeoutMs: 15_000, maxResponseBytes: 7600 })))
    if (outcome._tag === 'Left') throw outboundHttpError(outcome.left)
    if (outcome.right.status < 200 || outcome.right.status >= 300) throw new HttpError(502, `Request responded ${outcome.right.status}`)
    const bodyOutput = redactCredentialOutput(outcome.right.body.toString('utf8'), redactions)
    return { output: { status: outcome.right.status, body: bodyOutput }, log: `Request delivered with status ${outcome.right.status}` }
  }
  return { output: '', log: '' }
}

export async function processGraphRun(run: GraphRun): Promise<boolean> {
  if (!run.automationId || run.automationVersion === null) return false
  const version = await db.get<VersionRow>("SELECT * FROM automation_versions WHERE workspaceId=? AND automationId=? AND version=? AND format='graph'", run.workspaceId, run.automationId, run.automationVersion)
  if (!version) return false
  const graph = graphSchema.parse(JSON.parse(version.graph)), payload = JSON.parse(run.event) as Record<string, unknown>, byId = new Map(graph.nodes.map((node) => [node.id, node])), outgoing = new Map<string, typeof graph.edges>()
  for (const edge of graph.edges) outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge])
  let current = graph.nodes.find((node) => node.type === 'trigger'), count = 0; const outputs = new Map<string, unknown>(), visited = new Set<string>()
  try {
    if (!version.publisherId) throw new HttpError(403, 'Automation publisher is unavailable')
    await requirePermission(version.publisherId, run.workspaceId, 'items:read')
    while (current) {
      await requirePermission(version.publisherId, run.workspaceId, 'items:read')
      if (++count > 50 || visited.has(current.id)) throw new HttpError(400, 'Automation execution bound exceeded'); visited.add(current.id)
      await startNode(run, current.id)
      let branch: string | undefined, output: unknown = null
      if (current.type === 'trigger') output = { event: payload }
      else if (current.type === 'condition') {
        const config = conditionConfig.parse(current.config), value = resolvePath(config.path, payload, outputs)
        const matched = config.operator === 'exists' ? value !== undefined && value !== null : config.operator === 'equals' ? value === config.value : config.operator === 'not_equals' ? value !== config.value : typeof value === 'string' && value.includes(String(config.value ?? ''))
        branch = String(matched); output = { matched, branch }
      } else if (current.type === 'switch') {
        const config = switchConfig.parse(current.config), value = resolvePath(config.path, payload, outputs); branch = config.cases.find((entry) => entry.value === value)?.branch ?? config.defaultBranch; output = { branch }
      } else { const result = await action(current, run, payload, outputs, version.publisherId); output = result.output; await markNode(run, current.id, 'delivered', output, result.log) }
      if (['trigger', 'condition', 'switch'].includes(current.type)) await markNode(run, current.id, 'delivered', output, branch ? `Selected ${branch}` : 'Trigger received')
      outputs.set(current.id, output); const edges = outgoing.get(current.id) ?? [], next = branch === undefined ? edges[0] : edges.find((edge) => edge.branch === branch); current = next ? byId.get(next.target) : undefined
    }
    const timestamp = new Date().toISOString(); await db.run(`UPDATE automation_node_runs SET status='skipped',completedAt=? WHERE workspaceId=? AND runId=? AND status='pending'
      AND EXISTS (SELECT 1 FROM automation_runs WHERE id=? AND workspaceId=? AND status='running' AND leaseId=?)`, timestamp, run.workspaceId, run.id, run.id, run.workspaceId, run.leaseId)
    const finished = await db.run("UPDATE automation_runs SET status='delivered',detail=?,completedAt=?,heartbeatAt=?,leaseId=NULL WHERE workspaceId=? AND id=? AND status='running' AND leaseId=?", `${count} graph nodes delivered`, timestamp, timestamp, run.workspaceId, run.id, run.leaseId)
    if (!finished.changes) throw new LeaseLost('Automation lease was lost')
  } catch (error) {
    if (error instanceof LeaseLost) return true
    const message = sanitize(error instanceof Error ? error.message : 'Graph execution failed', 2000), timestamp = new Date().toISOString()
    try {
      if (current) await markNode(run, current.id, 'failed', '', message)
      await db.run(`UPDATE automation_node_runs SET status='skipped',completedAt=? WHERE workspaceId=? AND runId=? AND status='pending'
        AND EXISTS (SELECT 1 FROM automation_runs WHERE id=? AND workspaceId=? AND status='running' AND leaseId=?)`, timestamp, run.workspaceId, run.id, run.id, run.workspaceId, run.leaseId)
      await db.run("UPDATE automation_runs SET status='failed',detail=?,completedAt=?,heartbeatAt=?,leaseId=NULL WHERE workspaceId=? AND id=? AND status='running' AND leaseId=?", message, timestamp, timestamp, run.workspaceId, run.id, run.leaseId)
    } catch (failure) { if (!(failure instanceof LeaseLost)) throw failure }
  }
  return true
}

async function automation(wid: string, id: string) {
  const row = await db.get<{ id: string; event: string; version: number }>('SELECT id,event,version FROM automations WHERE workspaceId=? AND id=?', wid, id)
  if (!row) throw new HttpError(404, 'Automation not found'); return row
}
async function published(wid: string, id: string, version: number) {
  const row = await db.get<VersionRow>('SELECT * FROM automation_versions WHERE workspaceId=? AND automationId=? AND version=?', wid, id, version)
  if (!row) throw new HttpError(404, 'Automation version not found'); return { version: row.version, format: row.format, graph: JSON.parse(row.graph), publisherId: row.publisherId, publishedAt: row.publishedAt }
}

export function registerAutomationGraphs(router: Router): void {
  router.group(() => {
    const manage = async (ctx: HttpContext) => { const user = await authenticate(ctx); await requirePermission(user.id, ctx.params.wid, 'automations:manage'); await requirePermission(user.id, ctx.params.wid, 'items:read'); return user }
    router.get('/workspaces/:wid/automations/catalog', async (ctx) => { await manage(ctx); return automationCatalog })
    router.get('/workspaces/:wid/automations/:id/draft', async (ctx) => {
      await manage(ctx); const { wid, id } = ctx.params, current = await automation(wid, id)
      const draft = await db.get<{ revision: number; graph: string; updatedAt: string }>('SELECT revision,graph,updatedAt FROM automation_drafts WHERE workspaceId=? AND automationId=?', wid, id)
      return draft ? { revision: draft.revision, graph: JSON.parse(draft.graph), updatedAt: draft.updatedAt } : { revision: 0, graph: (await published(wid, id, current.version)).graph, updatedAt: null }
    })
    router.put('/workspaces/:wid/automations/:id/draft', async (ctx) => {
      const user = await manage(ctx), { wid, id } = ctx.params, data = z.object({ expectedRevision: z.number().int().min(0), graph: graphSchema }).strict().parse(ctx.request.body()); await automation(wid, id)
      if (unsafePublicHeaderNode(data.graph)) throw new HttpError(400, 'Sensitive or hop-by-hop public headers are not allowed in drafts')
      return db.transaction(async () => {
        await requirePermission(user.id, wid, 'automations:manage')
        await requirePermission(user.id, wid, 'items:read')
        const next = data.expectedRevision + 1, timestamp = new Date().toISOString()
        const changed = data.expectedRevision === 0
          ? await db.run('INSERT INTO automation_drafts (workspaceId,automationId,revision,graph,updatedBy,updatedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(workspaceId,automationId) DO NOTHING', wid, id, next, JSON.stringify(data.graph), user.id, timestamp)
          : await db.run('UPDATE automation_drafts SET revision=?,graph=?,updatedBy=?,updatedAt=? WHERE workspaceId=? AND automationId=? AND revision=?', next, JSON.stringify(data.graph), user.id, timestamp, wid, id, data.expectedRevision)
        if (!changed.changes) throw new HttpError(409, 'Draft changed; reload before saving')
        await audit(user.id, wid, 'automation.draft.save', id, { revision: next, nodeCount: data.graph.nodes.length, edgeCount: data.graph.edges.length }); return { revision: next, graph: data.graph, updatedAt: timestamp, validation: { valid: graphErrors(data.graph).length === 0, errors: graphErrors(data.graph) } }
      })
    })
    router.post('/workspaces/:wid/automations/:id/validate', async (ctx) => {
      await manage(ctx); const { wid, id } = ctx.params; await automation(wid, id)
      const body = z.object({ graph: graphSchema.optional() }).strict().parse(ctx.request.body()), graph = body.graph ?? graphSchema.parse(JSON.parse((await db.get<{ graph: string }>('SELECT graph FROM automation_drafts WHERE workspaceId=? AND automationId=?', wid, id))?.graph ?? 'null'))
      const errors = graphErrors(graph); if (!errors.length) try { await validateCredentials(wid, graph) } catch (error) { errors.push(error instanceof Error ? error.message : 'Credential validation failed') }
      return { valid: errors.length === 0, errors }
    })
    router.post('/workspaces/:wid/automations/:id/publish', async (ctx) => {
      const user = await manage(ctx), { wid, id } = ctx.params, data = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(ctx.request.body())
      await automation(wid, id)
      const candidate = await db.get<{ graph: string }>('SELECT graph FROM automation_drafts WHERE workspaceId=? AND automationId=? AND revision=?', wid, id, data.expectedRevision)
      if (!candidate) throw new HttpError(409, 'Draft changed; reload before publishing')
      const candidateGraph = graphSchema.parse(JSON.parse(candidate.graph)), candidateErrors = graphErrors(candidateGraph)
      if (candidateErrors.length) throw new HttpError(400, candidateErrors[0]!)
      for (const node of candidateGraph.nodes) node.config = configs[node.type].parse(node.config)
      graphSchema.parse(candidateGraph)
      await validateCredentials(wid, candidateGraph)
      return db.transaction(async () => {
        await requirePermission(user.id, wid, 'automations:manage')
        await requirePermission(user.id, wid, 'items:read')
        const consumed = await db.get<{ graph: string }>('UPDATE automation_drafts SET revision=revision+1 WHERE workspaceId=? AND automationId=? AND revision=? RETURNING graph', wid, id, data.expectedRevision)
        if (!consumed || consumed.graph !== candidate.graph) throw new HttpError(409, 'Draft changed; reload before publishing')
        const current = await automation(wid, id), graph = candidateGraph, credentials = await validateCredentials(wid, graph, false)
        const version = current.version + 1, timestamp = new Date().toISOString(), trigger = graph.nodes.find((node) => node.type === 'trigger')!, event = triggerConfig.parse(trigger.config).event
        await db.run('INSERT INTO automation_versions (workspaceId,automationId,version,format,graph,publisherId,publishedAt) VALUES (?,?,?,?,?,?,?)', wid, id, version, 'graph', JSON.stringify(graph), user.id, timestamp)
        for (const [node, credentialVersion] of credentials) await db.run('INSERT INTO automation_version_credentials (workspaceId,automationId,automationVersion,nodeId,credentialId,credentialVersion) VALUES (?,?,?,?,?,?)', wid, id, version, node, graph.nodes.find((entry) => entry.id === node)!.config.credentialId, credentialVersion)
        await db.run('UPDATE automations SET event=?,version=?,config=?,updatedAt=? WHERE workspaceId=? AND id=?', event, version, JSON.stringify({ graph: true }), timestamp, wid, id)
        await audit(user.id, wid, 'automation.publish', id, { version, revision: data.expectedRevision, nodeCount: graph.nodes.length })
        return published(wid, id, version)
      })
    })
    router.get('/workspaces/:wid/automations/:id/versions', async (ctx) => { await manage(ctx); const { wid, id } = ctx.params; await automation(wid, id); return db.all('SELECT version,format,publisherId,publishedAt FROM automation_versions WHERE workspaceId=? AND automationId=? ORDER BY version DESC', wid, id) })
    router.get('/workspaces/:wid/automations/:id/versions/:version', async (ctx) => { await manage(ctx); const { wid, id } = ctx.params; return published(wid, id, z.coerce.number().int().positive().parse(ctx.params.version)) })
    router.post('/workspaces/:wid/automations/:id/preview', async (ctx) => {
      await manage(ctx); const { wid, id } = ctx.params, body = z.object({ graph: graphSchema.optional(), event: z.record(z.string(), z.unknown()).default({}), mockOutputs: z.record(nodeId, z.unknown()).default({}) }).strict().parse(ctx.request.body()), current = await automation(wid, id)
      const graph = body.graph ?? (await published(wid, id, current.version)).graph as AutomationGraph, errors = graphErrors(graph); if (errors.length) return { valid: false, errors, path: [], uncertain: false }
      const outgoing = new Map<string, typeof graph.edges>(); for (const edge of graph.edges) outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge])
      const byId = new Map(graph.nodes.map((node) => [node.id, node])), outputs = new Map<string, unknown>()
      const unknown = (shape: string) => ({ unknown: true, shape }), isUnknown = (value: unknown) => Boolean(value && typeof value === 'object' && (value as { unknown?: boolean }).unknown)
      let node = graph.nodes.find((entry) => entry.type === 'trigger'), count = 0
      const path: { nodeId: string; type: GraphNodeType; branch?: string; effect: 'none'; output?: unknown; uncertain?: boolean; candidateBranches?: string[] }[] = []
      while (node && count++ < 50) {
        let branch: string | undefined, output: unknown = body.mockOutputs[node.id]
        if (output === undefined) {
          if (node.type === 'trigger') output = { event: body.event }
          else if (node.type === 'log') output = { message: String((resolveTemplates(node.config, body.event, outputs) as Record<string, unknown>).message) }
          else if (node.type === 'http' || node.type === 'webhook') output = { status: unknown('number'), body: unknown('string') }
          else if (node.type === 'email') output = { messageId: unknown('string') }
          else if (node.type === 'update_item') output = { item: unknown('Item') }
        }
        if (node.type === 'condition' || node.type === 'switch') {
          const config = node.type === 'condition' ? conditionConfig.parse(node.config) : switchConfig.parse(node.config), value = resolvePath(config.path, body.event, outputs)
          if (isUnknown(value) || value === undefined && config.path.startsWith('nodes.')) {
            path.push({ nodeId: node.id, type: node.type, effect: 'none', uncertain: true, candidateBranches: (outgoing.get(node.id) ?? []).map((edge) => edge.branch!).filter(Boolean) }); break
          }
          if (node.type === 'condition') { const condition = config as z.output<typeof conditionConfig>; const matched = condition.operator === 'exists' ? value != null : condition.operator === 'equals' ? value === condition.value : condition.operator === 'not_equals' ? value !== condition.value : typeof value === 'string' && value.includes(String(condition.value ?? '')); branch = String(matched); output = { matched, branch } }
          else { const selection = config as z.output<typeof switchConfig>; branch = selection.cases.find((entry) => entry.value === value)?.branch ?? selection.defaultBranch; output = { branch } }
        }
        outputs.set(node.id, output); path.push({ nodeId: node.id, type: node.type, ...(branch ? { branch } : {}), effect: 'none', output })
        const edges = outgoing.get(node.id) ?? [], edge = branch ? edges.find((entry) => entry.branch === branch) : edges[0]; node = edge ? byId.get(edge.target) : undefined
      }
      return { valid: true, errors: [], path, uncertain: path.some((entry) => entry.uncertain) }
    })
  }).prefix('/api/v1')
}
