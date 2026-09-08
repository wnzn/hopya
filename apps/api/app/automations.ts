import type { Router, HttpContext } from '@adonisjs/core/http'
import { createHash, randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import { db, audit } from './core.js'
import { authenticate } from './security.js'
import { HttpError, type Item } from './types.js'
import { requirePermission } from './service.js'

// Events emitted by workspace mutations. Keep names stable: they are part of
// the webhook contract and automation triggers.
export const events = ['item.created', 'item.updated', 'item.deleted', 'node.created', 'node.updated', 'node.deleted', 'field.changed'] as const
export type EventName = typeof events[number]

type EventPayload = {
  event: EventName
  workspaceId: string
  itemId?: string
  nodeId?: string
  fieldId?: string
  actorId: string | null
  changes?: Record<string, { before?: unknown; after?: unknown }>
  item?: Item
  at: string
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
    try: async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 10000) })
      if (!response.ok) throw new Error(`Request responded ${response.status}`)
      if (!response.body) return { status: response.status, output: '' }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (size < STEP_OUTPUT_BYTES) {
          const { done, value } = await reader.read()
          if (done) break
          const remaining = STEP_OUTPUT_BYTES - size
          chunks.push(value.subarray(0, remaining))
          size += Math.min(value.byteLength, remaining)
          if (value.byteLength > remaining) break
        }
      } finally { await reader.cancel().catch(() => {}) }
      return { status: response.status, output: Buffer.concat(chunks).toString('utf8') }
    },
    catch: (error) => new DeliveryError(error instanceof Error ? error.message : 'Request failed'),
  })

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

interface WebhookRow { id: string; workspaceId: string; name: string; url: string; events: string; enabled: number; secret: string; createdAt: string; updatedAt: string }
interface AutomationRow { id: string; workspaceId: string; name: string; event: string; config: string; version: number; enabled: number; createdAt: string; updatedAt: string }
interface StepRow { id: string; workspaceId: string; automationId: string; version: number; position: number; type: ProviderType; config: string; createdAt: string }
interface RunRow { id: string; workspaceId: string; automationId: string | null; targetType: 'automation' | 'webhook'; targetId: string; automationVersion: number | null; status: string; event: string; detail: string; createdAt: string; startedAt: string | null; completedAt: string | null }
interface StepRunRow { id: string; runId: string; stepId: string; position: number; type: ProviderType; status: string; output: string; log: string; startedAt: string | null; completedAt: string | null }
const decodeWebhook = (row: WebhookRow) => ({ id: row.id, name: row.name, url: row.url, events: JSON.parse(row.events) as EventName[], enabled: Boolean(row.enabled), createdAt: row.createdAt, updatedAt: row.updatedAt })
const decodeAutomation = ({ config, ...row }: AutomationRow) => {
  const steps = (db.prepare('SELECT type,config FROM automation_steps WHERE workspaceId=? AND automationId=? AND version=? ORDER BY position').all(row.workspaceId, row.id, row.version) as Pick<StepRow, 'type' | 'config'>[])
    .map((step) => ({ type: step.type, config: JSON.parse(step.config) as unknown }))
  return { ...row, enabled: Boolean(row.enabled), steps, ...(steps.length === 1 ? { action: steps[0] } : {}) }
}

function eventJson(payload: EventPayload): string {
  let encoded = JSON.stringify(payload)
  if (Buffer.byteLength(encoded) > EVENT_BYTES) encoded = JSON.stringify({ ...payload, item: undefined, changes: undefined })
  if (Buffer.byteLength(encoded) > EVENT_BYTES) throw new HttpError(400, 'Automation event is too large')
  return encoded
}

function insertRun(workspaceId: string, targetType: 'automation' | 'webhook', targetId: string, version: number | null, event: string): string {
  const id = randomUUID()
  const automationId = targetType === 'automation' ? targetId : null
  const createdAt = new Date().toISOString()
  db.prepare(`INSERT INTO automation_runs
    (id,workspaceId,automationId,targetType,targetId,automationVersion,status,event,detail,createdAt)
    VALUES (?,?,?,?,?,?,'pending',?,'',?)`).run(id, workspaceId, automationId, targetType, targetId, version, event, createdAt)
  if (targetType === 'automation') {
    const steps = db.prepare('SELECT * FROM automation_steps WHERE workspaceId=? AND automationId=? AND version=? ORDER BY position').all(workspaceId, targetId, version) as StepRow[]
    for (const step of steps) db.prepare(`INSERT INTO automation_step_runs
      (id,workspaceId,runId,stepId,position,type,status) VALUES (?,?,?,?,?,?,'pending')`)
      .run(randomUUID(), workspaceId, id, step.id, step.position, step.type)
  }
  return id
}

function trimRuns(workspaceId: string): void {
  db.prepare(`DELETE FROM automation_runs WHERE workspaceId=? AND status IN ('delivered','failed') AND id IN (
    SELECT id FROM automation_runs WHERE workspaceId=? AND status IN ('delivered','failed') ORDER BY createdAt DESC,id DESC LIMIT -1 OFFSET ?
  )`).run(workspaceId, workspaceId, RUN_RETENTION)
}

// Called inside service mutation transactions. Queue rows therefore commit or
// roll back with the event-producing mutation and survive process restarts.
export function emitEvent(input: Omit<EventPayload, 'at'>): void {
  const payload = { ...input, at: new Date().toISOString() }
  const encoded = eventJson(payload)
  const automations = db.prepare('SELECT * FROM automations WHERE workspaceId=? AND event=? AND enabled=1').all(payload.workspaceId, payload.event) as AutomationRow[]
  for (const automation of automations) insertRun(payload.workspaceId, 'automation', automation.id, automation.version, encoded)
  const hooks = db.prepare('SELECT * FROM webhooks WHERE workspaceId=? AND enabled=1').all(payload.workspaceId) as WebhookRow[]
  for (const hook of hooks) if ((JSON.parse(hook.events) as EventName[]).includes(payload.event)) insertRun(payload.workspaceId, 'webhook', hook.id, null, encoded)
  trimRuns(payload.workspaceId)
}

function resolveReferences(value: unknown, outputs: Map<number, string>): unknown {
  if (typeof value === 'string') return value.replace(referencePattern, (_match, raw: string) => outputs.get(Number(raw)) ?? '')
  if (Array.isArray(value)) return value.map((entry) => resolveReferences(entry, outputs))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveReferences(entry, outputs)]))
  return value
}

function finishRun(run: RunRow, status: 'delivered' | 'failed', detail: string): void {
  db.prepare('UPDATE automation_runs SET status=?,detail=?,completedAt=? WHERE workspaceId=? AND id=?')
    .run(status, sanitize(detail, STEP_LOG_BYTES), new Date().toISOString(), run.workspaceId, run.id)
  trimRuns(run.workspaceId)
}

const processRun = (run: RunRow) => deliverySlots.withPermits(1)(Effect.gen(function* () {
  const payload = JSON.parse(run.event) as EventPayload
  if (run.targetType === 'webhook') {
    const hook = db.prepare('SELECT * FROM webhooks WHERE workspaceId=? AND id=? AND enabled=1').get(run.workspaceId, run.targetId) as WebhookRow | undefined
    if (!hook) { finishRun(run, 'failed', 'Webhook is unavailable'); return }
    const body = JSON.stringify(payload)
    const result = yield* Effect.either(deliveryTimeout(request(hook.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hopya-signature': hmac(hook.secret, body) } })))
    if (result._tag === 'Left') finishRun(run, 'failed', `webhook: ${result.left.message}`)
    else finishRun(run, 'delivered', `webhook ${result.right.status}`)
    return
  }
  const automation = db.prepare('SELECT id FROM automations WHERE workspaceId=? AND id=?').get(run.workspaceId, run.targetId)
  if (!automation || run.automationVersion === null) { finishRun(run, 'failed', 'Automation is unavailable'); return }
  const steps = db.prepare('SELECT * FROM automation_steps WHERE workspaceId=? AND automationId=? AND version=? ORDER BY position').all(run.workspaceId, run.targetId, run.automationVersion) as StepRow[]
  const existing = new Map((db.prepare('SELECT * FROM automation_step_runs WHERE workspaceId=? AND runId=?').all(run.workspaceId, run.id) as StepRunRow[]).map((step) => [step.position, step]))
  const outputs = new Map<number, string>()
  for (const step of steps) {
    const prior = existing.get(step.position)
    if (prior?.status === 'delivered') { outputs.set(step.position, prior.output); continue }
    const startedAt = new Date().toISOString()
    db.prepare("UPDATE automation_step_runs SET status='running',startedAt=? WHERE workspaceId=? AND runId=? AND position=?").run(startedAt, run.workspaceId, run.id, step.position)
    const adapter = adapters[step.type] as ActionAdapter<SomeConfig>
    const resolved = resolveReferences(JSON.parse(step.config), outputs)
    const parsed = adapter.config.safeParse(resolved)
    const result = parsed.success
      ? yield* Effect.either(deliveryTimeout(adapter.run(parsed.data as SomeConfig, payload, () => undefined)))
      : { _tag: 'Left' as const, left: new DeliveryError(`Invalid ${step.type} action config`) }
    const completedAt = new Date().toISOString()
    if (result._tag === 'Left') {
      const log = sanitize(result.left.message, STEP_LOG_BYTES)
      db.prepare("UPDATE automation_step_runs SET status='failed',log=?,completedAt=? WHERE workspaceId=? AND runId=? AND position=?").run(log, completedAt, run.workspaceId, run.id, step.position)
      db.prepare("UPDATE automation_step_runs SET status='skipped',completedAt=? WHERE workspaceId=? AND runId=? AND position>?").run(completedAt, run.workspaceId, run.id, step.position)
      finishRun(run, 'failed', `Step ${step.position} failed: ${log}`)
      return
    }
    const output = sanitize(result.right.output, STEP_OUTPUT_BYTES)
    outputs.set(step.position, output)
    db.prepare("UPDATE automation_step_runs SET status='delivered',output=?,log=?,completedAt=? WHERE workspaceId=? AND runId=? AND position=?")
      .run(output, sanitize(result.right.log, STEP_LOG_BYTES), completedAt, run.workspaceId, run.id, step.position)
  }
  finishRun(run, 'delivered', `${steps.length} step${steps.length === 1 ? '' : 's'} delivered`)
}))

let flushing = false
export async function flushEvents(): Promise<void> {
  if (flushing) return
  flushing = true
  try {
    const stale = new Date(Date.now() - 60_000).toISOString()
    db.transaction(() => {
      db.prepare("UPDATE automation_step_runs SET status='pending',startedAt=NULL WHERE status='running' AND runId IN (SELECT id FROM automation_runs WHERE status='running' AND startedAt<?)").run(stale)
      db.prepare("UPDATE automation_runs SET status='pending',startedAt=NULL WHERE status='running' AND startedAt<?").run(stale)
    }).immediate()
    while (true) {
      const batch = db.transaction(() => {
        const rows = db.prepare("SELECT * FROM automation_runs WHERE status='pending' AND event IS NOT NULL ORDER BY createdAt,id LIMIT 20").all() as RunRow[]
        const now = new Date().toISOString()
        for (const row of rows) db.prepare("UPDATE automation_runs SET status='running',startedAt=? WHERE id=? AND status='pending'").run(now, row.id)
        return rows
      }).immediate()
      if (!batch.length) break
      await Effect.runPromise(Effect.all(batch.map(processRun), { concurrency: 'unbounded', discard: true }).pipe(Effect.catchAll(() => Effect.void)))
    }
  } finally { flushing = false }
}
// Kick off an asynchronous flush without blocking the response.
export function scheduleFlush(): void {
  void flushEvents().catch(() => {})
}

function webhookInWorkspace(wid: string, hookId: string): WebhookRow {
  const row = db.prepare('SELECT * FROM webhooks WHERE workspaceId=? AND id=?').get(wid, hookId) as WebhookRow | undefined
  if (!row) throw new HttpError(404, 'Webhook not found')
  return row
}
function automationInWorkspace(wid: string, automationId: string): AutomationRow {
  const row = db.prepare('SELECT * FROM automations WHERE workspaceId=? AND id=?').get(wid, automationId) as AutomationRow | undefined
  if (!row) throw new HttpError(404, 'Automation not found')
  return row
}

function insertSteps(wid: string, automationId: string, version: number, steps: { type: ProviderType; config: unknown }[], createdAt: string): void {
  const insert = db.prepare('INSERT INTO automation_steps (id,workspaceId,automationId,version,position,type,config,createdAt) VALUES (?,?,?,?,?,?,?,?)')
  steps.forEach((step, index) => insert.run(randomUUID(), wid, automationId, version, index + 1, step.type, JSON.stringify(step.config), createdAt))
}

function decodeRun(row: RunRow) {
  const steps = row.targetType === 'automation'
    ? db.prepare('SELECT id,stepId,position,type,status,output,log,startedAt,completedAt FROM automation_step_runs WHERE workspaceId=? AND runId=? ORDER BY position').all(row.workspaceId, row.id) as StepRunRow[]
    : []
  const { event: _event, ...safe } = row
  return { ...safe, steps }
}

export function registerAutomations(router: Router): void {
  router.group(() => {
    const user = (ctx: HttpContext) => authenticate(ctx)
    router.get('/workspaces/:wid/webhooks', (ctx) => {
      const { wid } = ctx.params
      requirePermission(user(ctx).id, wid, 'workspace:manage')
      return (db.prepare('SELECT * FROM webhooks WHERE workspaceId=? ORDER BY createdAt,id').all(wid) as WebhookRow[]).map(decodeWebhook)
    })
    router.post('/workspaces/:wid/webhooks', (ctx) => {
      const { wid } = ctx.params
      const userId = user(ctx).id
      const data = webhookSchema.parse(ctx.request.body())
      return db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        if ((db.prepare('SELECT count(*) AS count FROM webhooks WHERE workspaceId=?').get(wid) as { count: number }).count >= 20) throw new HttpError(400, 'Maximum 20 webhooks per workspace')
        const secret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
        const hook = { id: randomUUID(), workspaceId: wid, ...data, secret, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        db.prepare('INSERT INTO webhooks (id,workspaceId,name,url,events,enabled,secret,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(hook.id, wid, hook.name, hook.url, JSON.stringify(hook.events), Number(hook.enabled), secret, hook.createdAt, hook.updatedAt)
        audit(userId, wid, 'webhook.create', hook.id, { events: hook.events })
        return { ...decodeWebhook({ ...hook, events: JSON.stringify(hook.events), enabled: Number(hook.enabled) }), secret }
      })()
    })
    router.patch('/workspaces/:wid/webhooks/:id', (ctx) => {
      const { wid, id } = ctx.params
      const userId = user(ctx).id
      const data = webhookSchema.partial().parse(ctx.request.body())
      return db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        const previous = webhookInWorkspace(wid, id)
        const next = {
          name: data.name ?? previous.name, url: data.url ?? previous.url,
          events: data.events ?? JSON.parse(previous.events), enabled: data.enabled ?? Boolean(previous.enabled),
        }
        db.prepare('UPDATE webhooks SET name=?,url=?,events=?,enabled=?,updatedAt=? WHERE workspaceId=? AND id=?')
          .run(next.name, next.url, JSON.stringify(next.events), Number(next.enabled), new Date().toISOString(), wid, id)
        audit(userId, wid, 'webhook.update', id, { events: next.events })
        return decodeWebhook(webhookInWorkspace(wid, id))
      }).immediate()
    })
    router.delete('/workspaces/:wid/webhooks/:id', (ctx) => {
      const { wid, id } = ctx.params
      const userId = user(ctx).id
      return db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        webhookInWorkspace(wid, id)
        db.prepare("DELETE FROM automation_runs WHERE workspaceId=? AND targetType='webhook' AND targetId=?").run(wid, id)
        db.prepare('DELETE FROM webhooks WHERE workspaceId=? AND id=?').run(wid, id)
        audit(userId, wid, 'webhook.delete', id)
        return { success: true }
      })()
    })
    router.post('/workspaces/:wid/webhooks/:id/rotate', (ctx) => {
      const { wid, id } = ctx.params
      const userId = user(ctx).id
      return db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        webhookInWorkspace(wid, id)
        const secret = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
        db.prepare('UPDATE webhooks SET secret=?,updatedAt=? WHERE workspaceId=? AND id=?').run(secret, new Date().toISOString(), wid, id)
        audit(userId, wid, 'webhook.rotate', id)
        return { secret }
      })()
    })
    router.get('/workspaces/:wid/automations', (ctx) => {
      const { wid } = ctx.params
      requirePermission(user(ctx).id, wid, 'workspace:manage')
      return (db.prepare('SELECT * FROM automations WHERE workspaceId=? ORDER BY createdAt,id').all(wid) as AutomationRow[]).map((row) => decodeAutomation(row))
    })
    router.post('/workspaces/:wid/automations', (ctx) => {
      const { wid } = ctx.params
      const userId = user(ctx).id
      const data = automationSchema.parse(ctx.request.body())
      const steps = validateSteps(data.steps ?? [data.action!])
      return db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        if ((db.prepare('SELECT count(*) AS count FROM automations WHERE workspaceId=?').get(wid) as { count: number }).count >= 50) throw new HttpError(400, 'Maximum 50 automations per workspace')
        const first = steps[0]!
        const automation = { id: randomUUID(), workspaceId: wid, name: data.name, event: data.event, version: 1, enabled: data.enabled, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
        db.prepare('INSERT INTO automations (id,workspaceId,name,event,config,enabled,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)')
          .run(automation.id, wid, automation.name, automation.event, JSON.stringify(first), Number(automation.enabled), automation.createdAt, automation.updatedAt)
        insertSteps(wid, automation.id, automation.version, steps, automation.createdAt)
        audit(userId, wid, 'automation.create', automation.id, { event: automation.event, stepCount: steps.length, actionTypes: steps.map((step) => step.type) })
        return decodeAutomation({ ...automation, config: JSON.stringify(first), enabled: Number(automation.enabled) })
      })()
    })
    router.patch('/workspaces/:wid/automations/:id', (ctx) => {
      const { wid, id } = ctx.params
      const userId = user(ctx).id
      const data = automationPatchSchema.parse(ctx.request.body())
      return db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        const previous = automationInWorkspace(wid, id)
        const requestedSteps = data.steps ?? (data.action ? [data.action] : undefined)
        const steps = requestedSteps ? validateSteps(requestedSteps) : undefined
        const name = data.name ?? previous.name
        const event = data.event ?? previous.event
        const enabled = data.enabled ?? Boolean(previous.enabled)
        const version = steps ? previous.version + 1 : previous.version
        const timestamp = new Date().toISOString()
        const first = steps?.[0] ?? JSON.parse(previous.config) as { type: ProviderType; config: unknown }
        db.prepare('UPDATE automations SET name=?,event=?,config=?,version=?,enabled=?,updatedAt=? WHERE workspaceId=? AND id=?')
          .run(name, event, JSON.stringify(first), version, Number(enabled), timestamp, wid, id)
        if (steps) insertSteps(wid, id, version, steps, timestamp)
        audit(userId, wid, 'automation.update', id, { event, version, stepCount: steps?.length })
        return decodeAutomation(automationInWorkspace(wid, id))
      }).immediate()
    })
    router.delete('/workspaces/:wid/automations/:id', (ctx) => {
      const { wid, id } = ctx.params
      const userId = user(ctx).id
      return db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        automationInWorkspace(wid, id)
        db.prepare("DELETE FROM automation_runs WHERE workspaceId=? AND targetType='automation' AND targetId=?").run(wid, id)
        db.prepare('DELETE FROM automations WHERE workspaceId=? AND id=?').run(wid, id)
        audit(userId, wid, 'automation.delete', id)
        return { success: true }
      })()
    })
    router.get('/workspaces/:wid/automations/runs', (ctx) => {
      const { wid } = ctx.params
      requirePermission(user(ctx).id, wid, 'workspace:manage')
      const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), automationId: z.string().uuid().optional(), status: z.enum(['pending', 'running', 'delivered', 'failed']).optional() }).strict().parse(ctx.request.qs())
      const clauses = ['workspaceId=?'], values: unknown[] = [wid]
      if (query.automationId) { clauses.push("targetType='automation' AND automationId=?"); values.push(query.automationId) }
      if (query.status) { clauses.push('status=?'); values.push(query.status) }
      values.push(query.limit)
      return (db.prepare(`SELECT * FROM automation_runs WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC,id DESC LIMIT ?`).all(...values) as RunRow[]).map(decodeRun)
    })
    router.get('/workspaces/:wid/automations/runs/:runId', (ctx) => {
      const { wid, runId } = ctx.params
      requirePermission(user(ctx).id, wid, 'workspace:manage')
      const row = db.prepare('SELECT * FROM automation_runs WHERE workspaceId=? AND id=?').get(wid, runId) as RunRow | undefined
      if (!row) throw new HttpError(404, 'Automation run not found')
      return decodeRun(row)
    })
    router.post('/workspaces/:wid/automations/:id/test', (ctx) => {
      const { wid, id } = ctx.params
      const userId = user(ctx).id
      const result = db.transaction(() => {
        requirePermission(userId, wid, 'workspace:manage')
        const automation = automationInWorkspace(wid, id)
        const payload: EventPayload = { event: eventSchema.parse(automation.event), workspaceId: wid, actorId: userId, at: new Date().toISOString() }
        const runId = insertRun(wid, 'automation', automation.id, automation.version, eventJson(payload))
        audit(userId, wid, 'automation.test', id, { runId, version: automation.version })
        trimRuns(wid)
        return { ok: true, event: automation.event, runId, status: 'pending' as const }
      }).immediate()
      scheduleFlush()
      return result
    })
  }).prefix('/api/v1')
  // Flush queued events after the response settles, off the transaction path.
  const timer = setInterval(() => { void flushEvents() }, 2000)
  timer.unref()
}

export function secretSign(secret: string, body: string): string {
  return createHash('sha256').update(`${secret}.${body}`).digest('hex')
}
