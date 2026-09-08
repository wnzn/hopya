import Database from 'better-sqlite3'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import type { HttpContext } from '@adonisjs/core/http'
import { Effect } from 'effect'
import { db } from './database.js'
import { authenticate } from './security.js'
import { requirePermission, decodeField } from './service.js'
import { HttpError } from './types.js'
import { decodeItem, encodeRecord, itemColumns, itemQuery, type ItemRow } from './task_reads.js'

export const STREAM_DEADLINE_MS = 30_000
export const STREAM_CHUNK_BYTES = 64 * 1024
const users = new Map<string, number>()
let active = 0

// --- Typed bulk-read failures (Effect values, mapped at the stream boundary) ---
// Statuses and messages match the existing HttpError contract; the Effects only
// let admission and per-chunk checkpoints compose without try/catch.
class BulkReadDenied { readonly _tag = 'BulkReadDenied'; constructor(readonly message = 'Too many bulk reads; try again later') {} }
class BulkReadClosed { readonly _tag = 'BulkReadClosed'; constructor(readonly message = 'Bulk read closed') {} }
class BulkReadDeadline { readonly _tag = 'BulkReadDeadline'; constructor(readonly message = 'Bulk read deadline exceeded') {} }
class BulkReadAuth { readonly _tag = 'BulkReadAuth'; constructor(readonly message = 'Authentication required') {} }
type BulkReadFailure = BulkReadDenied | BulkReadClosed | BulkReadDeadline | BulkReadAuth

const bulkReadStatus = (failure: BulkReadFailure): number =>
  failure._tag === 'BulkReadDenied' ? 429
  : failure._tag === 'BulkReadClosed' ? 499
  : failure._tag === 'BulkReadDeadline' ? 504 : 401
const bulkReadHttpError = (failure: BulkReadFailure | HttpError): HttpError =>
  failure instanceof HttpError ? failure : new HttpError(bulkReadStatus(failure), failure.message)

// Admission as an Effect: global and per-user slot checks fail as values while
// the counters stay synchronous, as before.
const acquireSlotEffect = (userId: string): Effect.Effect<void, BulkReadDenied> =>
  active >= 8 || (users.get(userId) ?? 0) >= 2
    ? Effect.fail(new BulkReadDenied())
    : Effect.sync(() => { active++; users.set(userId, (users.get(userId) ?? 0) + 1) })

export function streamTasks(ctx: HttpContext, exporting: boolean): void {
  const userId = authenticate(ctx).id
  const wid: string = ctx.params.wid
  requirePermission(userId, wid, 'items:read')
  const query = itemQuery(db, wid, exporting ? { archived: 'include' } : ctx.request.qs())
  ctx.response.type('application/json')
  if (ctx.request.method() === 'HEAD') { ctx.response.status(200).send(''); return }
  const admission = Effect.runSync(Effect.either(acquireSlotEffect(userId)))
  if (admission._tag === 'Left') {
    ctx.response.header('Retry-After', '1')
    throw bulkReadHttpError(admission.left)
  }
  let snapshot: Database.Database | undefined
  let rows: IterableIterator<unknown> | undefined
  let stream: Readable | undefined
  let timer: NodeJS.Timeout | undefined
  let closed = false
  const response = ctx.response.response
  const request = ctx.request.request
  const deadline = Date.now() + STREAM_DEADLINE_MS
  function cleanup() {
    if (closed) return
    closed = true
    clearTimeout(timer)
    request.off('aborted', disconnected)
    response.off('close', disconnected)
    response.off('finish', disconnected)
    // SQLite iterators must be returned before rolling back/closing, even if
    // the async generator is suspended by backpressure or never started.
    try { rows?.return?.() } finally {
      try { if (snapshot?.inTransaction) snapshot.exec('ROLLBACK') } finally {
        try { snapshot?.close() } finally {
          active--
          const count = users.get(userId)! - 1
          if (count) users.set(userId, count); else users.delete(userId)
        }
      }
    }
  }
  function disconnected() { stream?.destroy(); cleanup() }
  // Per-chunk checkpoint as an Effect.gen composition: cooperative yield,
  // disconnect, deadline and live re-authorization fail as typed values mapped
  // to the same HttpError codes the stream has always raised.
  const checkpointEffect = (): Effect.Effect<void, BulkReadFailure | HttpError> => Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => setImmediate(),
      catch: () => new BulkReadClosed() as BulkReadFailure | HttpError,
    })
    if (closed || request.aborted || response.destroyed) return yield* Effect.fail(new BulkReadClosed() as BulkReadFailure | HttpError)
    if (Date.now() >= deadline) return yield* Effect.fail(new BulkReadDeadline() as BulkReadFailure | HttpError)
    // Deliberately use the live writer connection, never snapshot credentials.
    // Auth/permission errors pass through untouched; only the local checks
    // above fail as typed values.
    const current = yield* Effect.try({
      try: () => authenticate(ctx),
      catch: (error) => error as BulkReadFailure | HttpError,
    })
    if (current.id !== userId) return yield* Effect.fail(new BulkReadAuth() as BulkReadFailure | HttpError)
    yield* Effect.try({
      try: () => requirePermission(current.id, wid, 'items:read'),
      catch: (error) => error as BulkReadFailure | HttpError,
    })
  })
  async function checkpoint() {
    const result = await Effect.runPromise(Effect.either(checkpointEffect()))
    if (result._tag === 'Left') throw bulkReadHttpError(result.left)
  }
  function* records(sql: string, values: string[], decode: (row: any) => unknown = (row) => row) {
    rows = snapshot!.prepare(sql).iterate(...values)
    let first = true
    try {
      for (const row of rows) {
        const json = encodeRecord(decode(row))
        yield `${first ? '' : ','}${json}`
        first = false
      }
    } finally { rows.return?.(); rows = undefined }
  }
  function* parts(workspace: unknown) {
    if (exporting) {
      yield `{"version":3,"exportedAt":${JSON.stringify(new Date().toISOString())},"workspace":${encodeRecord(workspace)},"nodes":[`
      yield* records('SELECT id,workspaceId,name,kind,parentId,createdAt,description,icon,color FROM nodes WHERE workspaceId=? ORDER BY createdAt,id', [wid])
      yield '],"items":['
    } else yield '['
    yield* records(`SELECT ${itemColumns} FROM items INDEXED BY ${query.index} WHERE ${query.where} ORDER BY createdAt,id`, query.values, (row: ItemRow) => decodeItem(row))
    if (exporting) {
      yield '],"fields":['
      yield* records('SELECT id,workspaceId,name,type,options,settings FROM fields WHERE workspaceId=? ORDER BY name,id', [wid], decodeField)
      yield '],"projectFields":['
      yield* records(`SELECT c.projectId,c.builtInFields,c.statuses,c.dateFormat,c.updatedAt,n.kind FROM project_field_configs c JOIN nodes n
        ON n.workspaceId=c.workspaceId AND n.id=c.projectId WHERE c.workspaceId=? AND n.parentId IS NULL AND n.kind IN ('project','list') ORDER BY n.createdAt,n.id`, [wid], (row) => ({
        projectId: row.projectId,
        fieldIds: (snapshot!.prepare('SELECT fieldId FROM project_field_assignments WHERE workspaceId=? AND projectId=? ORDER BY position,fieldId').all(wid, row.projectId) as { fieldId: string }[]).map((field) => field.fieldId),
        builtInFields: JSON.parse(row.builtInFields), updatedAt: row.updatedAt,
        statuses: JSON.parse(row.kind === 'list'
          ? (snapshot!.prepare('SELECT statuses FROM list_status_configs WHERE workspaceId=? AND listId=?').get(wid, row.projectId) as { statuses: string }).statuses
          : row.statuses), ...(row.dateFormat === null ? {} : { dateFormat: row.dateFormat }),
      }))
      yield '],"listStatusConfigs":['
      yield* records(`SELECT c.listId,c.statuses,c.updatedAt FROM list_status_configs c JOIN nodes n
        ON n.workspaceId=c.workspaceId AND n.id=c.listId WHERE c.workspaceId=? AND n.kind='list' ORDER BY n.createdAt,n.id`, [wid], (row) => {
        const project = snapshot!.prepare(`WITH RECURSIVE ancestors(id,parentId,kind,depth) AS (
          SELECT id,parentId,kind,0 FROM nodes WHERE workspaceId=? AND id=?
          UNION ALL SELECT n.id,n.parentId,n.kind,a.depth+1 FROM nodes n JOIN ancestors a ON n.id=a.parentId
          WHERE n.workspaceId=? AND a.depth<32
        ) SELECT c.updatedAt FROM ancestors a JOIN project_field_configs c ON c.workspaceId=? AND c.projectId=a.id
          WHERE a.kind='project' AND a.parentId IS NULL`).get(wid, row.listId, wid, wid) as { updatedAt: string } | undefined
        return { listId: row.listId, ...(row.statuses === null ? {} : { statuses: JSON.parse(row.statuses) }), updatedAt: row.updatedAt,
          ...(project ? { inheritedProjectUpdatedAt: project.updatedAt } : {}) }
      })
      yield '],"listTagColorConfigs":['
      yield* records(`SELECT c.listId,c.colors,c.updatedAt FROM list_tag_color_configs c JOIN nodes n
        ON n.workspaceId=c.workspaceId AND n.id=c.listId WHERE c.workspaceId=? AND n.kind='list' ORDER BY n.createdAt,n.id`, [wid], (row) => ({
        listId: row.listId, colors: JSON.parse(row.colors), updatedAt: row.updatedAt,
      }))
      yield '],"comments":['
      yield* records('SELECT id,itemId,authorId,body,parentId,createdAt,deletedAt FROM comments WHERE workspaceId=? ORDER BY createdAt,id', [wid])
      yield '],"commentReactions":['
      yield* records('SELECT itemId,commentId,userId,emoji,createdAt FROM comment_reactions WHERE workspaceId=? ORDER BY createdAt,commentId,userId,emoji', [wid])
      yield '],"attachments":['
      yield* records('SELECT id,itemId,name,size,contentType,createdAt FROM attachments WHERE workspaceId=? ORDER BY createdAt,id', [wid])
      yield ']}'
    } else yield ']'
  }
  async function* body(workspace: unknown) {
    try {
      let buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
      let used = 0
      // Pack small records, but never reuse a yielded buffer or emit unfilled bytes.
      for (const json of parts(workspace)) {
        const bytes = Buffer.from(json)
        for (let offset = 0; offset < bytes.length;) {
          const length = Math.min(bytes.length - offset, buffer.length - used)
          bytes.copy(buffer, used, offset, offset + length)
          offset += length; used += length
          if (used === buffer.length) {
            await checkpoint()
            yield buffer
            buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
            used = 0
          }
        }
      }
      if (used) { await checkpoint(); yield buffer.subarray(0, used) }
    } finally { cleanup() }
  }
  try {
    snapshot = new Database(db.name, { readonly: true, fileMustExist: true })
    snapshot.pragma('query_only = ON')
    snapshot.pragma('cache_size = -2048')
    snapshot.pragma('temp_store = FILE')
    snapshot.exec('BEGIN')
    // Establish the snapshot synchronously before any response bytes or yield.
    const workspace = snapshot.prepare('SELECT id,name,createdAt FROM workspaces WHERE id=?').get(wid)
    if (!workspace) throw new HttpError(403, 'Workspace access denied')
    stream = Readable.from(body(workspace), { objectMode: false, highWaterMark: STREAM_CHUNK_BYTES })
    stream.once('close', cleanup)
    stream.once('error', cleanup)
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    response.once('finish', disconnected)
    timer = setTimeout(() => {
      stream!.destroy(new HttpError(504, 'Bulk read deadline exceeded'))
      cleanup()
    }, STREAM_DEADLINE_MS)
    timer.unref()
    if (request.aborted || response.destroyed) { disconnected(); return }
    ctx.response.stream(stream, (error) => {
      cleanup()
      // Adonis invokes this only before headers; after headers it destroys the
      // connection rather than ending a misleading, truncated JSON document.
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      const status = error instanceof HttpError && [401, 403, 504].includes(error.status) ? error.status : 500
      return [JSON.stringify({ error: status === 401 ? 'Authentication required' : status === 403 ? 'Workspace access denied' : status === 504 ? 'Bulk read deadline exceeded' : 'Bulk read failed' }), status]
    })
  } catch (error) { stream?.destroy(); cleanup(); throw error }
}
