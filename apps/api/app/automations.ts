import type { Router, HttpContext } from '@adonisjs/core/http'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import { db, audit } from './core.js'
import { authenticate } from './security.js'
import { HttpError, type Item } from './types.js'
import { requirePermission } from './service.js'
import { automationContext, type AutomationCausation } from './automation_context.js'
import { initializeGraphRun, linearGraph, processGraphRun, registerAutomationGraphs } from './automation_graphs.js'
import { registerAutomationCredentials } from './automation_credentials.js'
import { pinnedRequestEffect, resolvePinnedDestination } from './pinned_http.js'

// Events emitted by workspace mutations. Keep names stable: they are part of
// the webhook contract and automation triggers.
export const events = ['item.created', 'item.updated', 'item.deleted', 'node.created', 'node.updated', 'node.deleted', 'field.changed'] as const
export type EventName = typeof events[number]

export type EventPayload = {
  event: EventName
  workspaceId: string
  itemId?: string
  nodeId?: string
  fieldId?: string
  actorId: string | null
  changes?: Record<string, { before?: unknown; after?: unknown }>
  item?: Item
  at: string
  causation?: AutomationCausation
}

const eventSchema = z.enum(events)
const webhookSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().max(2000).refine((value) => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && Boolean(url.hostname) } catch { return false }
  }, 'Webhook URL must be http(s)'),
  events: z.array(eventSchema).min(1).max(events.length).transform((values) => [...new Set(values)]),
  enabled: z.boolean().default(true),
}).strict()
const providers = {
  webhook: z.object({ url: z.string().max(2000).refine((value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) } catch { return false } }, 'URL must be http(s)'), method: z.enum(['POST', 'PUT', 'PATCH']).default('POST') }).strict(),
  email: z.object({ to: z.array(z.string().trim().email().max(254)).min(1).max(10), subject: z.string().trim().min(1).max(200) }).strict(),
  http: z.object({
    url: z.string().max(2000).refine((value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) } catch { return false } }, 'URL must be http(s)'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers: z.record(z.string().max(200), z.string().max(2000)).refine((headers) => Object.keys(headers).length <= 20, 'Too many headers').default({}),
    body: z.string().max(20000).optional(),
  }).strict(),
  log: z.object({ message: z.string().max(2000) }).strict(),
} as const
export const providerTypes = ['webhook', 'email', 'http', 'log'] as const
export type ProviderType = typeof providerTypes[number]
const actionSchema = z.object({ type: z.enum(providerTypes), config: z.record(z.string(), z.unknown()) }).strict()
const automationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  event: eventSchema,
  action: actionSchema.optional(),
  steps: z.array(actionSchema).min(1).max(20).optional(),
  enabled: z.boolean().default(true),
}).strict().refine((value) => Number(value.action !== undefined) + Number(value.steps !== undefined) === 1, 'Provide action or steps')
const automationPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), event: eventSchema.optional(),
  action: actionSchema.optional(), steps: z.array(actionSchema).min(1).max(20).optional(), enabled: z.boolean().optional(),
}).strict().refine((value) => !(value.action && value.steps), 'Provide action or steps, not both')

const STEP_OUTPUT_BYTES = 8192
const STEP_LOG_BYTES = 2000
const EVENT_BYTES = 64 * 1024
const RUN_RETENTION = 500
const referencePattern = /\{\{steps\.(\d+)\.output\}\}/g

// --- Action provider adapter pattern (Effect-based) ------------------------
// Each adapter validates its own config at save time and describes delivery as
// an Effect with typed failures. New providers implement ActionAdapter and
// register in `adapters`; dispatch composes them with the same combinators.
interface WebhookConfig { url: string; method: 'POST' | 'PUT' | 'PATCH' }
interface EmailConfig { to: string[]; subject: string }
interface HttpConfig { url: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; headers: Record<string, string>; body?: string }
interface LogConfig { message: string }
type SomeConfig = WebhookConfig | EmailConfig | HttpConfig | LogConfig

// Typed delivery failures, kept as values so dispatch can record them without
// try/catch. DeliveryError messages land in the run log, never in responses.
class DeliveryError { readonly _tag = 'DeliveryError'; constructor(readonly message: string) {} }
class ProviderUnavailable { readonly _tag = 'ProviderUnavailable'; constructor(readonly message: string) {} }
type DeliveryFail = DeliveryError | ProviderUnavailable

interface ActionAdapter<C extends SomeConfig> {
  // Zod v3 and v4 compatible: only safeParse's discriminated result is used.
  config: z.ZodType<unknown>
  // Human-readable label shown in the automations UI.
  label: string
  // Delivery is an Effect so failures are values: dispatch decides timeouts,
  // bounding and recording without try/catch, and providers stay composable.
  run(config: C, event: EventPayload, webhookSecret: (wid: string, id: string) => string | undefined): Effect.Effect<{ output: string; log: string }, DeliveryFail>
}

const hmac = (secret: string, body: string) => `sha256=${createHash('sha256').update(`${secret}.${body}`).digest('hex')}`

const request = (url: string, init: { method?: string; body?: string; headers?: Record<string, string>; timeoutMs?: number }) =>
  Effect.tryPromise({
    try: async () => resolvePinnedDestination(url),
    catch: (error) => new DeliveryError(error instanceof Error ? error.message : 'Request failed'),
  }).pipe(Effect.flatMap((destination) => pinnedRequestEffect(destination, { ...init, timeoutMs: init.timeoutMs ?? 10_000, totalTimeoutMs: init.timeoutMs ?? 10_000, maxResponseBytes: STEP_OUTPUT_BYTES, truncateResponse: true }).pipe(
    Effect.mapError((error) => new DeliveryError(error.message)),
    Effect.flatMap((response) => response.status >= 200 && response.status < 300
      ? Effect.succeed({ status: response.status, output: response.body.toString('utf8') })
      : Effect.fail(new DeliveryError(`Request responded ${response.status}`))),
  )))

const adapters: {
  webhook: ActionAdapter<WebhookConfig>
  email: ActionAdapter<EmailConfig>
  http: ActionAdapter<HttpConfig>
  log: ActionAdapter<LogConfig>
} = {
  webhook: {
    label: 'Webhook request',
    config: providers.webhook,
    run: (config, event, webhookSecret) => Effect.gen(function* () {
      const secret = webhookSecret(event.workspaceId, event.itemId ?? '')
      const body = JSON.stringify(event)
      const status = yield* request(config.url, {
        method: config.method, body,
        headers: { 'content-type': 'application/json', ...(secret ? { 'x-hopya-signature': hmac(secret, body) } : {}) },
      })
      return { output: status.output || `${status.status}`, log: `Request delivered with status ${status.status}` }
    }),
  },
  email: {
    label: 'Email notification',
    config: providers.email,
    // SMTP is operator-configured; without it the provider is unavailable.
    run: (config, event) => Effect.gen(function* () {
      const relay = process.env.SMTP_URL
      if (!relay) return yield* Effect.fail(new ProviderUnavailable('SMTP is not configured on this instance'))
      // nodemailer is loaded lazily so instances without SMTP never need it.
      const nodemailer = yield* Effect.tryPromise({
        try: async () => (await import('nodemailer' as string)).default as {
          createTransport: (url: string) => { sendMail: (mail: { to: string; subject: string; text: string }) => Promise<{ messageId: string }>; close: () => void }
        },
        catch: () => new ProviderUnavailable('Email delivery is not available on this instance'),
      })
      const info = yield* Effect.tryPromise({
        try: async () => {
          const transport = nodemailer.createTransport(relay)
          try {
            return await transport.sendMail({
              to: config.to.join(', '), subject: config.subject,
              text: `${event.event} in workspace ${event.workspaceId} at ${event.at}`,
            })
          } finally { await transport.close() }
        },
        catch: (error) => new DeliveryError(error instanceof Error ? error.message : 'Email delivery failed'),
      })
      return { output: String(info.messageId), log: 'Email delivered' }
    }),
  },
  http: {
    label: 'HTTP request',
    config: providers.http,
    run: (config, event) => Effect.gen(function* () {
      const headers: Record<string, string> = { ...config.headers }
      let body: string | undefined
      if (!['GET', 'HEAD'].includes(config.method)) {
        if (config.body !== undefined) {
          body = config.body.replaceAll('{{event}}', JSON.stringify(event))
          if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'text/plain'
        } else {
          body = JSON.stringify(event)
          if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
        }
      }
      const status = yield* request(config.url, { method: config.method, headers, body })
      return { output: status.output || `${status.status}`, log: `Request delivered with status ${status.status}` }
    }),
  },
  log: {
    label: 'Run log',
    config: providers.log,
    run: (config) => Effect.succeed({ output: config.message, log: config.message }),
  },
}
export function listProviders() {
  return providerTypes.map((type) => ({ type, label: adapters[type].label }))
}

function decodeAutomationConfig(type: ProviderType, config: unknown): unknown {
  const parsed = adapters[type].config.safeParse(config)
  if (!parsed.success) throw new HttpError(400, `Invalid ${type} action config`)
  return parsed.data
}

function sanitize(value: string, limit: number): string {
  const redacted = value
    .replace(/("(?:password|passwd|token|secret|api[-_]?key)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/(authorization|proxy-authorization)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|token|secret|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  return Buffer.from(redacted).subarray(0, limit).toString('utf8')
}

function validateSteps(steps: { type: ProviderType; config: Record<string, unknown> }[]) {
  return steps.map((step, index) => {
    const config = decodeAutomationConfig(step.type, step.config)
    const encoded = JSON.stringify(config)
    for (const match of encoded.matchAll(referencePattern)) {
      const position = Number(match[1])
      if (position < 1 || position > index) throw new HttpError(400, `Step ${index + 1} may reference only prior step outputs`)
    }
    return { type: step.type, config }
  })
}

const deliverySlots = Effect.runSync(Effect.makeSemaphore(4))
const deliveryTimeout = <A>(effect: Effect.Effect<A, DeliveryFail>): Effect.Effect<A, DeliveryFail> =>
  Effect.timeoutFail(effect, {
    duration: '15 seconds',
    onTimeout: () => new DeliveryError('Delivery timed out'),
  })

interface WebhookRow extends Record<string, unknown> { id: string; workspaceId: string; name: string; url: string; events: string; enabled: number; secret: string; signingVersion: number; createdAt: string; updatedAt: string }
interface AutomationRow extends Record<string, unknown> { id: string; workspaceId: string; name: string; event: string; config: string; version: number; enabled: number; createdAt: string; updatedAt: string }
interface StepRow extends Record<string, unknown> { id: string; workspaceId: string; automationId: string; version: number; position: number; type: ProviderType; config: string; createdAt: string }
interface RunRow extends Record<string, unknown> { id: string; workspaceId: string; automationId: string | null; targetType: 'automation' | 'webhook'; targetId: string; automationVersion: number | null; status: string; event: string; detail: string; createdAt: string; startedAt: string | null; completedAt: string | null; causation: string; leaseId: string | null; heartbeatAt: string | null; attempt: number }
interface StepRunRow extends Record<string, unknown> { id: string; runId: string; stepId: string; position: number; type: ProviderType; status: string; output: string; log: string; startedAt: string | null; completedAt: string | null }
const decodeWebhook = (row: WebhookRow) => ({ id: row.id, name: row.name, url: row.url, events: JSON.parse(row.events) as EventName[], enabled: Boolean(row.enabled), signingVersion: row.signingVersion, createdAt: row.createdAt, updatedAt: row.updatedAt })
const decodeAutomation = async ({ config, ...row }: AutomationRow) => {
  const graphVersion = await db.get<{ format: string }>('SELECT format FROM automation_versions WHERE workspaceId=? AND automationId=? AND version=?', row.workspaceId, row.id, row.version)
  if (graphVersion?.format === 'graph') return { ...row, enabled: Boolean(row.enabled), graph: true }
  const stored = (await db.all<Pick<StepRow, 'type' | 'config'>>('SELECT type,config FROM automation_steps WHERE workspaceId=? AND automationId=? AND version=? ORDER BY position', row.workspaceId, row.id, row.version))
    .map((step) => ({ type: step.type, config: JSON.parse(step.config) as unknown }))
  let legacyHeaderMigrationRequired = false
  const steps = stored.map((step) => {
    const safe = { ...step.config as Record<string, unknown> }
    if (safe.headers && typeof safe.headers === 'object' && Object.keys(safe.headers).length) {
      safe.headers = {}
      legacyHeaderMigrationRequired = true
    }
    return { type: step.type, config: safe }
  })
  return { ...row, enabled: Boolean(row.enabled), steps, ...(steps.length === 1 ? { action: steps[0] } : {}), ...(legacyHeaderMigrationRequired ? { legacyHeaderMigrationRequired: true } : {}) }
}

function eventJson(payload: EventPayload): string {
  let encoded = JSON.stringify(payload)
  if (Buffer.byteLength(encoded) > EVENT_BYTES) encoded = JSON.stringify({ ...payload, item: undefined, changes: undefined })
  if (Buffer.byteLength(encoded) > EVENT_BYTES) throw new HttpError(400, 'Automation event is too large')
  return encoded
}

async function insertRun(workspaceId: string, targetType: 'automation' | 'webhook', targetId: string, version: number | null, event: string, causation: AutomationCausation = { depth: 0, automationIds: [] }): Promise<string> {
  const id = randomUUID()
  const automationId = targetType === 'automation' ? targetId : null
  const createdAt = new Date().toISOString()
  await db.run(`INSERT INTO automation_runs
    (id,workspaceId,automationId,targetType,targetId,automationVersion,status,event,detail,createdAt,causation)
    VALUES (?,?,?,?,?,?,'pending',?,'',?,?)`, id, workspaceId, automationId, targetType, targetId, version, event, createdAt, JSON.stringify(causation))
  if (targetType === 'automation') {
    if (version !== null && await initializeGraphRun(id, workspaceId, targetId, version)) return id
    const steps = await db.all<StepRow>('SELECT * FROM automation_steps WHERE workspaceId=? AND automationId=? AND version=? ORDER BY position', workspaceId, targetId, version)
    for (const step of steps) await db.run(`INSERT INTO automation_step_runs
      (id,workspaceId,runId,stepId,position,type,status) VALUES (?,?,?,?,?,?,'pending')`,
    randomUUID(), workspaceId, id, step.id, step.position, step.type)
  }
  return id
}

async function trimRuns(workspaceId: string): Promise<void> {
  await db.run(`DELETE FROM automation_runs WHERE workspaceId=? AND status IN ('delivered','failed') AND id NOT IN (
    SELECT id FROM automation_runs WHERE workspaceId=? AND status IN ('delivered','failed') ORDER BY createdAt DESC,id DESC LIMIT ?
  )`, workspaceId, workspaceId, RUN_RETENTION)
}

// Called inside service mutation transactions. Queue rows therefore commit or
// roll back with the event-producing mutation and survive process restarts.
export async function emitEvent(input: Omit<EventPayload, 'at'>): Promise<void> {
  const causation = input.causation ?? automationContext.getStore() ?? { depth: 0, automationIds: [] }
  // Causation is queue metadata, not part of the stable webhook event body.
  const payload = { ...input, causation: undefined, at: new Date().toISOString() }
  const encoded = eventJson(payload)
  const automations = await db.all<AutomationRow>('SELECT * FROM automations WHERE workspaceId=? AND event=? AND enabled=1', payload.workspaceId, payload.event)
  for (const automation of automations) {
    if (causation.depth >= 5 || causation.automationIds.includes(automation.id)) continue
    await insertRun(payload.workspaceId, 'automation', automation.id, automation.version, encoded, causation)
  }
  const hooks = await db.all<WebhookRow>('SELECT * FROM webhooks WHERE workspaceId=? AND enabled=1', payload.workspaceId)
  for (const hook of hooks) if ((JSON.parse(hook.events) as EventName[]).includes(payload.event)) await insertRun(payload.workspaceId, 'webhook', hook.id, null, encoded)
  await trimRuns(payload.workspaceId)
}

function resolveReferences(value: unknown, outputs: Map<number, string>): unknown {
  if (typeof value === 'string') return value.replace(referencePattern, (_match, raw: string) => outputs.get(Number(raw)) ?? '')
  if (Array.isArray(value)) return value.map((entry) => resolveReferences(entry, outputs))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveReferences(entry, outputs)]))
  return value
}

async function finishRun(run: RunRow, status: 'delivered' | 'failed', detail: string): Promise<void> {
  await db.run('UPDATE automation_runs SET status=?,detail=?,completedAt=? WHERE workspaceId=? AND id=?',
    status, sanitize(detail, STEP_LOG_BYTES), new Date().toISOString(), run.workspaceId, run.id)
  await trimRuns(run.workspaceId)
}

const processRun = (run: RunRow) => deliverySlots.withPermits(1)(Effect.gen(function* () {
  const payload = JSON.parse(run.event) as EventPayload
  if (run.targetType === 'webhook') {
    const hook = yield* Effect.promise(() => db.get<WebhookRow>('SELECT * FROM webhooks WHERE workspaceId=? AND id=? AND enabled=1', run.workspaceId, run.targetId))
    if (!hook) { yield* Effect.promise(() => finishRun(run, 'failed', 'Webhook is unavailable')); return }
    const body = JSON.stringify(payload)
    const signature = hook.signingVersion >= 2 ? `sha256=${createHmac('sha256', hook.secret).update(body).digest('hex')}` : hmac(hook.secret, body)
    const result = yield* Effect.either(deliveryTimeout(request(hook.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hopya-signature': signature } })))
    if (result._tag === 'Left') yield* Effect.promise(() => finishRun(run, 'failed', `webhook: ${result.left.message}`))
    else yield* Effect.promise(() => finishRun(run, 'delivered', `webhook ${result.right.status}`))
    return
  }
  const automation = yield* Effect.promise(() => db.get('SELECT id FROM automations WHERE workspaceId=? AND id=?', run.workspaceId, run.targetId))
  if (!automation || run.automationVersion === null) { yield* Effect.promise(() => finishRun(run, 'failed', 'Automation is unavailable')); return }
  if (yield* Effect.promise(() => processGraphRun(run))) return
  const steps = yield* Effect.promise(() => db.all<StepRow>('SELECT * FROM automation_steps WHERE workspaceId=? AND automationId=? AND version=? ORDER BY position', run.workspaceId, run.targetId, run.automationVersion))
  const priorRuns = yield* Effect.promise(() => db.all<StepRunRow>('SELECT * FROM automation_step_runs WHERE workspaceId=? AND runId=?', run.workspaceId, run.id))
  const existing = new Map(priorRuns.map((step) => [step.position, step]))
  const outputs = new Map<number, string>()
  for (const step of steps) {
    const prior = existing.get(step.position)
    if (prior?.status === 'delivered') { outputs.set(step.position, prior.output); continue }
    const startedAt = new Date().toISOString()
    yield* Effect.promise(() => db.run("UPDATE automation_step_runs SET status='running',startedAt=? WHERE workspaceId=? AND runId=? AND position=?", startedAt, run.workspaceId, run.id, step.position))
    const adapter = adapters[step.type] as ActionAdapter<SomeConfig>
    const resolved = resolveReferences(JSON.parse(step.config), outputs)
    const parsed = adapter.config.safeParse(resolved)
    const result = parsed.success
      ? yield* Effect.either(deliveryTimeout(adapter.run(parsed.data as SomeConfig, payload, () => undefined)))
      : { _tag: 'Left' as const, left: new DeliveryError(`Invalid ${step.type} action config`) }
    const completedAt = new Date().toISOString()
    if (result._tag === 'Left') {
      const log = sanitize(result.left.message, STEP_LOG_BYTES)
      yield* Effect.promise(() => db.run("UPDATE automation_step_runs SET status='failed',log=?,completedAt=? WHERE workspaceId=? AND runId=? AND position=?", log, completedAt, run.workspaceId, run.id, step.position))
      yield* Effect.promise(() => db.run("UPDATE automation_step_runs SET status='skipped',completedAt=? WHERE workspaceId=? AND runId=? AND position>?", completedAt, run.workspaceId, run.id, step.position))
      yield* Effect.promise(() => finishRun(run, 'failed', `Step ${step.position} failed: ${log}`))
      return
    }
    const output = sanitize(result.right.output, STEP_OUTPUT_BYTES)
    outputs.set(step.position, output)
    yield* Effect.promise(() => db.run("UPDATE automation_step_runs SET status='delivered',output=?,log=?,completedAt=? WHERE workspaceId=? AND runId=? AND position=?",
      output, sanitize(result.right.log, STEP_LOG_BYTES), completedAt, run.workspaceId, run.id, step.position))
  }
  yield* Effect.promise(() => finishRun(run, 'delivered', `${steps.length} step${steps.length === 1 ? '' : 's'} delivered`))
}))

let flushing = false
export async function flushEvents(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    // A 50-node graph can spend up to 12.5 minutes in bounded HTTP actions.
    // Heartbeats advance between nodes. If a graph still loses its 20-minute
    // lease, fail it closed instead of replaying already delivered side effects.
    const stale = new Date(Date.now() - 20 * 60_000).toISOString()
    await db.transaction(async () => {
      const completedAt = new Date().toISOString()
      await db.run(`UPDATE automation_node_runs SET status='failed',log='Worker lease expired; graph was not replayed',completedAt=?
        WHERE status='running' AND runId IN (SELECT id FROM automation_runs WHERE status='running' AND COALESCE(heartbeatAt,startedAt)<?)`, completedAt, stale)
      await db.run(`UPDATE automation_node_runs SET status='skipped',completedAt=? WHERE status='pending' AND runId IN (
        SELECT id FROM automation_runs WHERE status='running' AND COALESCE(heartbeatAt,startedAt)<? AND EXISTS (
          SELECT 1 FROM automation_node_runs WHERE automation_node_runs.runId=automation_runs.id))`, completedAt, stale)
      await db.run(`UPDATE automation_runs SET status='failed',detail='Worker lease expired; graph was not replayed',completedAt=?,leaseId=NULL
        WHERE status='running' AND COALESCE(heartbeatAt,startedAt)<? AND EXISTS (
          SELECT 1 FROM automation_node_runs WHERE automation_node_runs.runId=automation_runs.id)`, completedAt, stale)
      await db.run("UPDATE automation_step_runs SET status='pending',startedAt=NULL WHERE status='running' AND runId IN (SELECT id FROM automation_runs WHERE status='running' AND startedAt<?)", stale)
      await db.run("UPDATE automation_runs SET status='pending',startedAt=NULL,leaseId=NULL,heartbeatAt=NULL WHERE status='running' AND COALESCE(heartbeatAt,startedAt)<? AND NOT EXISTS (SELECT 1 FROM automation_node_runs WHERE automation_node_runs.runId=automation_runs.id)", stale)
    })
    while (true) {
      const batch = await db.transaction(async () => {
        const now = new Date().toISOString(), leaseId = randomUUID()
        const claimSql = db.sql({
          pg: `WITH claimable AS (
            SELECT id FROM automation_runs WHERE status='pending' AND event IS NOT NULL
            ORDER BY createdAt,id LIMIT 20 FOR UPDATE SKIP LOCKED
          )
          UPDATE automation_runs SET status='running',startedAt=?,heartbeatAt=?,leaseId=?,attempt=attempt+1
          WHERE id IN (SELECT id FROM claimable) AND status='pending' RETURNING *`,
          sqlite: `UPDATE automation_runs SET status='running',startedAt=?,heartbeatAt=?,leaseId=?,attempt=attempt+1
          WHERE id IN (
            SELECT id FROM automation_runs WHERE status='pending' AND event IS NOT NULL ORDER BY createdAt,id LIMIT 20
          ) AND status='pending' RETURNING *`,
        })
        const rows = await db.all<RunRow>(claimSql, now, now, leaseId)
        return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      })
      if (!batch.length) break
      await Effect.runPromise(Effect.all(batch.map(processRun), { concurrency: 'unbounded', discard: true }).pipe(Effect.catchAll(() => Effect.void)))
    }
  } finally { flushing = false }
}
// Kick off an asynchronous flush without blocking the response.
export function scheduleFlush(): void {
  void flushEvents().catch(() => {})
}

async function webhookInWorkspace(wid: string, hookId: string): Promise<WebhookRow> {
  const row = await db.get<WebhookRow>('SELECT * FROM webhooks WHERE workspaceId=? AND id=?', wid, hookId)
  if (!row) throw new HttpError(404, 'Webhook not found')
  return row
}
async function automationInWorkspace(wid: string, automationId: string): Promise<AutomationRow> {
  const row = await db.get<AutomationRow>('SELECT * FROM automations WHERE workspaceId=? AND id=?', wid, automationId)
  if (!row) throw new HttpError(404, 'Automation not found')
  return row
}

async function insertSteps(wid: string, automationId: string, version: number, steps: { type: ProviderType; config: unknown }[], createdAt: string): Promise<void> {
  for (const [index, step] of steps.entries()) {
    await db.run('INSERT INTO automation_steps (id,workspaceId,automationId,version,position,type,config,createdAt) VALUES (?,?,?,?,?,?,?,?)',
      randomUUID(), wid, automationId, version, index + 1, step.type, JSON.stringify(step.config), createdAt)
  }
}

async function decodeRun(row: RunRow) {
  const steps = row.targetType === 'automation'
    ? await db.all<StepRunRow>('SELECT id,stepId,position,type,status,output,log,startedAt,completedAt FROM automation_step_runs WHERE workspaceId=? AND runId=? ORDER BY position', row.workspaceId, row.id)
    : []
  const nodes = row.targetType === 'automation'
    ? await db.all('SELECT id,nodeId,type,status,attempt,output,log,startedAt,completedAt FROM automation_node_runs WHERE workspaceId=? AND runId=? ORDER BY startedAt,nodeId', row.workspaceId, row.id)
    : []
  const { event: _event, leaseId: _lease, causation: _causation, ...safe } = row
  return { ...safe, steps, nodes }
}

export function registerAutomations(router: Router): void {
  router.group(() => {
    const user = (ctx: HttpContext) => authenticate(ctx)
    const manageAutomation = async (userId: string, wid: string) => {
      await requirePermission(userId, wid, 'automations:manage')
      await requirePermission(userId, wid, 'items:read')
    }
    router.get('/workspaces/:wid/webhooks', async (ctx) => {
      const { wid } = ctx.params
      await requirePermission((await user(ctx)).id, wid, 'workspace:manage')
      return (await db.all<WebhookRow>('SELECT * FROM webhooks WHERE workspaceId=? ORDER BY createdAt,id', wid)).map(decodeWebhook)
    })
    router.post('/workspaces/:wid/webhooks', async (ctx) => {
      const { wid } = ctx.params
      const userId = (await user(ctx)).id
      const data = webhookSchema.parse(ctx.request.body())
      return db.transaction(async () => {
        await requirePermission(userId, wid, 'workspace:manage')
        if (((await db.get('SELECT count(*) AS count FROM webhooks WHERE workspaceId=?', wid)) as { count: number }).count >= 20) throw new HttpError(400, 'Maximum 20 webhooks per workspace')
        const secret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
        const hook = { id: randomUUID(), workspaceId: wid, ...data, secret, signingVersion: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        await db.run('INSERT INTO webhooks (id,workspaceId,name,url,events,enabled,secret,signingVersion,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
          hook.id, wid, hook.name, hook.url, JSON.stringify(hook.events), Number(hook.enabled), secret, hook.signingVersion, hook.createdAt, hook.updatedAt)
        await audit(userId, wid, 'webhook.create', hook.id, { events: hook.events })
        return { ...decodeWebhook({ ...hook, events: JSON.stringify(hook.events), enabled: Number(hook.enabled) }), secret }
      })
    })
    router.patch('/workspaces/:wid/webhooks/:id', async (ctx) => {
      const { wid, id } = ctx.params
      const userId = (await user(ctx)).id
      const data = webhookSchema.partial().parse(ctx.request.body())
      return db.transaction(async () => {
        await requirePermission(userId, wid, 'workspace:manage')
        const previous = await webhookInWorkspace(wid, id)
        const next = {
          name: data.name ?? previous.name, url: data.url ?? previous.url,
          events: data.events ?? JSON.parse(previous.events), enabled: data.enabled ?? Boolean(previous.enabled),
        }
        await db.run('UPDATE webhooks SET name=?,url=?,events=?,enabled=?,updatedAt=? WHERE workspaceId=? AND id=?',
          next.name, next.url, JSON.stringify(next.events), Number(next.enabled), new Date().toISOString(), wid, id)
        await audit(userId, wid, 'webhook.update', id, { events: next.events })
        return decodeWebhook(await webhookInWorkspace(wid, id))
      })
    })
    router.delete('/workspaces/:wid/webhooks/:id', async (ctx) => {
      const { wid, id } = ctx.params
      const userId = (await user(ctx)).id
      return db.transaction(async () => {
        await requirePermission(userId, wid, 'workspace:manage')
        await webhookInWorkspace(wid, id)
        await db.run("DELETE FROM automation_runs WHERE workspaceId=? AND targetType='webhook' AND targetId=?", wid, id)
        await db.run('DELETE FROM webhooks WHERE workspaceId=? AND id=?', wid, id)
        await audit(userId, wid, 'webhook.delete', id)
        return { success: true }
      })
    })
    router.post('/workspaces/:wid/webhooks/:id/rotate', async (ctx) => {
      const { wid, id } = ctx.params
      const userId = (await user(ctx)).id
      return db.transaction(async () => {
        await requirePermission(userId, wid, 'workspace:manage')
        await webhookInWorkspace(wid, id)
        const secret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
        await db.run('UPDATE webhooks SET secret=?,signingVersion=2,updatedAt=? WHERE workspaceId=? AND id=?', secret, new Date().toISOString(), wid, id)
        await audit(userId, wid, 'webhook.rotate', id, { signingVersion: 2 })
        return { secret, signingVersion: 2 }
      })
    })
    router.get('/workspaces/:wid/automations', async (ctx) => {
      const { wid } = ctx.params
      await manageAutomation((await user(ctx)).id, wid)
      const rows = await db.all<AutomationRow>('SELECT * FROM automations WHERE workspaceId=? ORDER BY createdAt,id', wid)
      return Promise.all(rows.map(decodeAutomation))
    })
    router.post('/workspaces/:wid/automations', async (ctx) => {
      const { wid } = ctx.params
      const userId = (await user(ctx)).id
      const data = automationSchema.parse(ctx.request.body())
      const steps = validateSteps(data.steps ?? [data.action!])
      return db.transaction(async () => {
        await manageAutomation(userId, wid)
        if (((await db.get('SELECT count(*) AS count FROM automations WHERE workspaceId=?', wid)) as { count: number }).count >= 50) throw new HttpError(400, 'Maximum 50 automations per workspace')
        const first = steps[0]!
        const automation = { id: randomUUID(), workspaceId: wid, name: data.name, event: data.event, version: 1, enabled: data.enabled, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        await db.run('INSERT INTO automations (id,workspaceId,name,event,config,enabled,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)',
          automation.id, wid, automation.name, automation.event, JSON.stringify(first), Number(automation.enabled), automation.createdAt, automation.updatedAt)
        await insertSteps(wid, automation.id, automation.version, steps, automation.createdAt)
        await db.run('INSERT INTO automation_versions (workspaceId,automationId,version,format,graph,publisherId,publishedAt) VALUES (?,?,?,?,?,?,?)', wid, automation.id, automation.version, 'linear', JSON.stringify(linearGraph(automation.event, steps)), userId, automation.createdAt)
        await audit(userId, wid, 'automation.create', automation.id, { event: automation.event, stepCount: steps.length, actionTypes: steps.map((step) => step.type) })
        return decodeAutomation({ ...automation, config: JSON.stringify(first), enabled: Number(automation.enabled) })
      })
    })
    router.patch('/workspaces/:wid/automations/:id', async (ctx) => {
      const { wid, id } = ctx.params
      const userId = (await user(ctx)).id
      const data = automationPatchSchema.parse(ctx.request.body())
      return db.transaction(async () => {
        await manageAutomation(userId, wid)
        const previous = await automationInWorkspace(wid, id)
        const requestedSteps = data.steps ?? (data.action ? [data.action] : undefined)
        const currentFormat = await db.get<{ format: string }>('SELECT format FROM automation_versions WHERE workspaceId=? AND automationId=? AND version=?', wid, id, previous.version)
        if (requestedSteps && currentFormat?.format === 'graph') throw new HttpError(409, 'Published graph cannot be replaced through the legacy step API')
        const eventChanged = data.event !== undefined && data.event !== previous.event
        if (eventChanged && currentFormat?.format === 'graph') throw new HttpError(409, 'Published graph trigger must be changed through a graph draft')
        const copied = eventChanged && !requestedSteps
          ? (await db.all<Pick<StepRow, 'type' | 'config'>>('SELECT type,config FROM automation_steps WHERE workspaceId=? AND automationId=? AND version=? ORDER BY position', wid, id, previous.version)).map((step) => ({ type: step.type, config: JSON.parse(step.config) as Record<string, unknown> }))
          : undefined
        const steps = requestedSteps ? validateSteps(requestedSteps) : copied
        const name = data.name ?? previous.name
        const event = data.event ?? previous.event
        const enabled = data.enabled ?? Boolean(previous.enabled)
        const version = steps ? previous.version + 1 : previous.version
        const timestamp = new Date().toISOString()
        const first = steps?.[0] ?? JSON.parse(previous.config) as { type: ProviderType; config: unknown }
        await db.run('UPDATE automations SET name=?,event=?,config=?,version=?,enabled=?,updatedAt=? WHERE workspaceId=? AND id=?',
          name, event, JSON.stringify(first), version, Number(enabled), timestamp, wid, id)
        if (steps) {
          await insertSteps(wid, id, version, steps, timestamp)
          await db.run('INSERT INTO automation_versions (workspaceId,automationId,version,format,graph,publisherId,publishedAt) VALUES (?,?,?,?,?,?,?)', wid, id, version, 'linear', JSON.stringify(linearGraph(event, steps)), userId, timestamp)
        }
        await audit(userId, wid, 'automation.update', id, { event, version, stepCount: steps?.length })
        return decodeAutomation(await automationInWorkspace(wid, id))
      })
    })
    router.delete('/workspaces/:wid/automations/:id', async (ctx) => {
      const { wid, id } = ctx.params
      const userId = (await user(ctx)).id
      return db.transaction(async () => {
        await manageAutomation(userId, wid)
        await automationInWorkspace(wid, id)
        await db.run("DELETE FROM automation_runs WHERE workspaceId=? AND targetType='automation' AND targetId=?", wid, id)
        await db.run('DELETE FROM automations WHERE workspaceId=? AND id=?', wid, id)
        await audit(userId, wid, 'automation.delete', id)
        return { success: true }
      })
    })
    router.get('/workspaces/:wid/automations/runs', async (ctx) => {
      const { wid } = ctx.params
      await manageAutomation((await user(ctx)).id, wid)
      const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), automationId: z.string().uuid().optional(), status: z.enum(['pending', 'running', 'delivered', 'failed']).optional() }).strict().parse(ctx.request.qs())
      const clauses = ['workspaceId=?'], values: unknown[] = [wid]
      if (query.automationId) { clauses.push("targetType='automation' AND automationId=?"); values.push(query.automationId) }
      if (query.status) { clauses.push('status=?'); values.push(query.status) }
      values.push(query.limit)
      const rows = await db.all<RunRow>(`SELECT * FROM automation_runs WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC,id DESC LIMIT ?`, ...values)
      return Promise.all(rows.map(decodeRun))
    })
    router.get('/workspaces/:wid/automations/runs/:runId', async (ctx) => {
      const { wid, runId } = ctx.params
      await manageAutomation((await user(ctx)).id, wid)
      const row = await db.get<RunRow>('SELECT * FROM automation_runs WHERE workspaceId=? AND id=?', wid, runId)
      if (!row) throw new HttpError(404, 'Automation run not found')
      return decodeRun(row)
    })
    router.post('/workspaces/:wid/automations/:id/test', async (ctx) => {
      const { wid, id } = ctx.params
      const userId = (await user(ctx)).id
      const result = await db.transaction(async () => {
        await manageAutomation(userId, wid)
        const automation = await automationInWorkspace(wid, id)
        const version = await db.get<{ format: string; graph: string }>('SELECT format,graph FROM automation_versions WHERE workspaceId=? AND automationId=? AND version=?', wid, id, automation.version)
        if (version?.format === 'graph' && (JSON.parse(version.graph).nodes as { type: string }[]).some((node) => node.type === 'update_item')) throw new HttpError(400, 'Test runs have no triggering task; use a real task event for Update task graphs')
        const payload: EventPayload = { event: eventSchema.parse(automation.event), workspaceId: wid, actorId: userId, at: new Date().toISOString() }
        const runId = await insertRun(wid, 'automation', automation.id, automation.version, eventJson(payload))
        await audit(userId, wid, 'automation.test', id, { runId, version: automation.version })
        await trimRuns(wid)
        return { ok: true, event: automation.event, runId, status: 'pending' as const }
      })
      scheduleFlush()
      return result
    })
  }).prefix('/api/v1')
  registerAutomationGraphs(router)
  registerAutomationCredentials(router)
  // Flush queued events after the response settles, off the transaction path.
  const timer = setInterval(() => { void flushEvents() }, 2000)
  timer.unref()
}

export function secretSign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

export function legacySecretSign(secret: string, body: string): string {
  return createHash('sha256').update(`${secret}.${body}`).digest('hex')
}
