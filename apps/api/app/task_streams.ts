import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import type { HttpContext } from '@adonisjs/core/http'
import { Effect } from 'effect'
import { db, type SnapshotTransaction } from './database.js'
import { authenticate } from './security.js'
import { requirePermission, decodeField } from './service.js'
import { HttpError } from './types.js'
import { decodeItem, encodeRecord, itemColumns, itemQuery, type ItemRow } from './task_reads.js'

export const STREAM_DEADLINE_MS = 30_000
export const STREAM_CHUNK_BYTES = 64 * 1024
const STREAM_BATCH_ROWS = 100
const users = new Map<string, number>()
let active = 0

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

const acquireSlotEffect = (userId: string): Effect.Effect<void, BulkReadDenied> =>
  active >= 8 || (users.get(userId) ?? 0) >= 2
    ? Effect.fail(new BulkReadDenied())
    : Effect.sync(() => { active++; users.set(userId, (users.get(userId) ?? 0) + 1) })

type Row = Record<string, any>
type Key = string | { sql: string; value: string }

function keyset(keys: Key[], cursor: unknown[]): { clause: string; values: unknown[] } {
  const clauses: string[] = []
  const values: unknown[] = []
  const columns = keys.map((key) => typeof key === 'string' ? key : key.sql)
  for (let index = 0; index < keys.length; index++) {
    clauses.push(`(${columns.slice(0, index).map((key) => `${key}=?`).concat(`${columns[index]}>?`).join(' AND ')})`)
    values.push(...cursor.slice(0, index + 1))
  }
  return { clause: `(${clauses.join(' OR ')})`, values }
}

export async function streamTasks(ctx: HttpContext, exporting: boolean): Promise<void> {
  const userId = (await authenticate(ctx)).id
  const wid: string = ctx.params.wid
  const membership = await requirePermission(userId, wid, 'items:read')
  const canReadDocuments = membership.permissions.includes('documents:read')
  const query = await itemQuery(db, wid, exporting ? { archived: 'include' } : ctx.request.qs())
  ctx.response.type('application/json')
  if (ctx.request.method() === 'HEAD') { ctx.response.status(200).send(''); return }

  const admission = Effect.runSync(Effect.either(acquireSlotEffect(userId)))
  if (admission._tag === 'Left') {
    ctx.response.header('Retry-After', '1')
    throw bulkReadHttpError(admission.left)
  }

  let snapshot: SnapshotTransaction | undefined
  let stream: Readable | undefined
  let timer: NodeJS.Timeout | undefined
  let closed = false
  let cleanupPromise: Promise<void> | undefined
  const response = ctx.response.response
  const request = ctx.request.request
  const deadline = Date.now() + STREAM_DEADLINE_MS

  function cleanup(): Promise<void> {
    if (cleanupPromise) return cleanupPromise
    closed = true
    clearTimeout(timer)
    request.off('aborted', disconnected)
    response.off('close', disconnected)
    response.off('finish', disconnected)
    cleanupPromise = (async () => {
      try {
        await snapshot?.rollback()
      } finally {
        active--
        const count = users.get(userId)! - 1
        if (count) users.set(userId, count); else users.delete(userId)
      }
    })()
    return cleanupPromise
  }
  function settleCleanup() { void cleanup().catch(() => {}) }
  function disconnected() { stream?.destroy(); settleCleanup() }

  async function checkpoint(): Promise<void> {
    try {
      await setImmediate()
    } catch {
      throw bulkReadHttpError(new BulkReadClosed())
    }
    if (closed || request.aborted || response.destroyed) throw bulkReadHttpError(new BulkReadClosed())
    if (Date.now() >= deadline) throw bulkReadHttpError(new BulkReadDeadline())
    const current = await authenticate(ctx)
    if (current.id !== userId) throw bulkReadHttpError(new BulkReadAuth())
    await requirePermission(current.id, wid, 'items:read')
    if (exporting && canReadDocuments) await requirePermission(current.id, wid, 'documents:read')
    if (closed || request.aborted || response.destroyed) throw bulkReadHttpError(new BulkReadClosed())
    if (Date.now() >= deadline) throw bulkReadHttpError(new BulkReadDeadline())
  }

  async function* records(
    select: string,
    fromWhere: string,
    values: unknown[],
    keys: Key[],
    decode: (row: Row) => unknown | Promise<unknown> = (row) => row,
  ): AsyncGenerator<string> {
    let cursor: unknown[] | undefined
    let first = true
    while (true) {
      const seek = cursor ? keyset(keys, cursor) : undefined
      const batch = await snapshot!.all<Row>(`${select} ${fromWhere}${seek ? ` AND ${seek.clause}` : ''}
        ORDER BY ${keys.map((key) => typeof key === 'string' ? key : key.sql).join(',')} LIMIT ?`,
      ...values, ...(seek?.values ?? []), STREAM_BATCH_ROWS)
      for (const row of batch) {
        const json = encodeRecord(await decode(row))
        yield `${first ? '' : ','}${json}`
        first = false
      }
      if (batch.length < STREAM_BATCH_ROWS) return
      cursor = keys.map((key) => batch.at(-1)![typeof key === 'string' ? key : key.value])
    }
  }

  async function fieldIds(projectId: string): Promise<string[]> {
    const result: string[] = []
    let position: unknown = -1
    let fieldId: unknown = ''
    while (true) {
      const batch = await snapshot!.all<{ fieldId: string; position: number }>(`SELECT fieldId,position FROM project_field_assignments
        WHERE workspaceId=? AND projectId=? AND (position>? OR (position=? AND fieldId>?)) ORDER BY position,fieldId LIMIT ?`,
      wid, projectId, position, position, fieldId, STREAM_BATCH_ROWS)
      for (const field of batch) result.push(field.fieldId)
      if (batch.length < STREAM_BATCH_ROWS) return result
      position = batch.at(-1)!.position
      fieldId = batch.at(-1)!.fieldId
    }
  }

  async function* parts(workspace: unknown): AsyncGenerator<string> {
    if (exporting) {
      yield `{"version":5,"exportedAt":${JSON.stringify(new Date().toISOString())},"workspace":${encodeRecord(workspace)},"nodes":[`
      yield* records('SELECT id,workspaceId,name,kind,parentId,createdAt,description,icon,color',
        'FROM nodes WHERE workspaceId=?', [wid], ['createdAt', 'id'])
      yield '],"documents":['
      if (canReadDocuments) yield* records('SELECT id,workspaceId,parentId,title,body,bodyRevision,createdAt,updatedAt,createdById,updatedById', 'FROM documents WHERE workspaceId=?', [wid], ['createdAt', 'id'])
      yield '],"documentPages":['
      if (canReadDocuments) yield* records('SELECT documentId,itemId,position,createdAt', 'FROM document_pages WHERE workspaceId=?', [wid], ['documentId', 'position', 'createdAt', 'itemId'])
      yield '],"documentSubpages":['
      if (canReadDocuments) yield* records('SELECT documentId,pageDocumentId,position,placement,createdAt', 'FROM document_subpages WHERE workspaceId=?', [wid], ['documentId', 'position', 'createdAt', 'pageDocumentId'])
      yield '],"items":['
    } else yield '['

    const index = snapshot!.dialect === 'sqlite' ? ` INDEXED BY ${query.index}` : ''
    yield* records(`SELECT ${itemColumns}`, `FROM items${index} WHERE ${query.where}`, query.values, ['createdAt', 'id'],
      (row) => decodeItem(row as ItemRow))

    if (!exporting) { yield ']'; return }

    yield '],"fields":['
    yield* records('SELECT id,workspaceId,name,type,options,settings', 'FROM fields WHERE workspaceId=?', [wid], ['name', 'id'],
      (row) => decodeField(row as Parameters<typeof decodeField>[0]))
    yield '],"projectFields":['
    yield* records('SELECT c.projectId,c.builtInFields,c.statuses,c.dateFormat,c.updatedAt,n.kind,n.createdAt AS sortCreatedAt,n.id AS sortId',
      `FROM project_field_configs c JOIN nodes n ON n.workspaceId=c.workspaceId AND n.id=c.projectId
        WHERE c.workspaceId=? AND n.parentId IS NULL AND n.kind IN ('project','list')`, [wid],
      [{ sql: 'n.createdAt', value: 'sortCreatedAt' }, { sql: 'n.id', value: 'sortId' }], async (row) => {
        let statuses = row.statuses
        if (row.kind === 'list') {
          const config = await snapshot!.get<{ statuses: string }>('SELECT statuses FROM list_status_configs WHERE workspaceId=? AND listId=?', wid, row.projectId)
          if (!config) throw new HttpError(500, 'Bulk read failed')
          statuses = config.statuses
        }
        return {
          projectId: row.projectId,
          fieldIds: await fieldIds(row.projectId),
          builtInFields: JSON.parse(row.builtInFields),
          updatedAt: row.updatedAt,
          statuses: JSON.parse(statuses),
          ...(row.dateFormat === null ? {} : { dateFormat: row.dateFormat }),
        }
      })
    yield '],"listStatusConfigs":['
    yield* records('SELECT c.listId,c.statuses,c.updatedAt,n.createdAt AS sortCreatedAt,n.id AS sortId',
      `FROM list_status_configs c JOIN nodes n ON n.workspaceId=c.workspaceId AND n.id=c.listId
        WHERE c.workspaceId=? AND n.kind='list'`, [wid],
      [{ sql: 'n.createdAt', value: 'sortCreatedAt' }, { sql: 'n.id', value: 'sortId' }], async (row) => {
        const project = await snapshot!.get<{ updatedAt: string }>(`WITH RECURSIVE ancestors(id,parentId,kind,depth) AS (
          SELECT id,parentId,kind,0 FROM nodes WHERE workspaceId=? AND id=?
          UNION ALL SELECT n.id,n.parentId,n.kind,a.depth+1 FROM nodes n JOIN ancestors a ON n.id=a.parentId
          WHERE n.workspaceId=? AND a.depth<32
        ) SELECT c.updatedAt FROM ancestors a JOIN project_field_configs c ON c.workspaceId=? AND c.projectId=a.id
          WHERE a.kind='project' AND a.parentId IS NULL`, wid, row.listId, wid, wid)
        return {
          listId: row.listId,
          ...(row.statuses === null ? {} : { statuses: JSON.parse(row.statuses) }),
          updatedAt: row.updatedAt,
          ...(project ? { inheritedProjectUpdatedAt: project.updatedAt } : {}),
        }
      })
    yield '],"listTagColorConfigs":['
    yield* records('SELECT c.listId,c.colors,c.updatedAt,n.createdAt AS sortCreatedAt,n.id AS sortId',
      `FROM list_tag_color_configs c JOIN nodes n ON n.workspaceId=c.workspaceId AND n.id=c.listId
        WHERE c.workspaceId=? AND n.kind='list'`, [wid],
      [{ sql: 'n.createdAt', value: 'sortCreatedAt' }, { sql: 'n.id', value: 'sortId' }], (row) => ({
        listId: row.listId, colors: JSON.parse(row.colors), updatedAt: row.updatedAt,
      }))
    yield '],"comments":['
    yield* records('SELECT id,itemId,authorId,body,parentId,createdAt,deletedAt,anchorRevision,anchorStart,anchorEnd,anchorExact,anchorPrefix,anchorSuffix,anchorState', 'FROM comments WHERE workspaceId=?', [wid], ['createdAt', 'id'])
    yield '],"commentReactions":['
    yield* records('SELECT itemId,commentId,userId,emoji,createdAt', 'FROM comment_reactions WHERE workspaceId=?', [wid], ['createdAt', 'commentId', 'userId', 'emoji'])
    yield '],"documentComments":['
    if (canReadDocuments) yield* records('SELECT id,documentId,authorId,body,parentId,createdAt,deletedAt,anchorRevision,anchorStart,anchorEnd,anchorExact,anchorPrefix,anchorSuffix,anchorState', 'FROM document_comments WHERE workspaceId=?', [wid], ['createdAt', 'id'])
    yield '],"documentCommentReactions":['
    if (canReadDocuments) yield* records('SELECT documentId,commentId,userId,emoji,createdAt', 'FROM document_comment_reactions WHERE workspaceId=?', [wid], ['createdAt', 'commentId', 'userId', 'emoji'])
    yield '],"attachments":['
    yield* records('SELECT id,itemId,name,size,contentType,createdAt', 'FROM attachments WHERE workspaceId=?', [wid], ['createdAt', 'id'])
    yield ']}'
  }

  async function* body(workspace: unknown): AsyncGenerator<Buffer> {
    try {
      let buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
      let used = 0
      for await (const json of parts(workspace)) {
        const bytes = Buffer.from(json)
        for (let offset = 0; offset < bytes.length;) {
          const length = Math.min(bytes.length - offset, buffer.length - used)
          bytes.copy(buffer, used, offset, offset + length)
          offset += length
          used += length
          if (used === buffer.length) {
            await checkpoint()
            yield buffer
            buffer = Buffer.allocUnsafe(STREAM_CHUNK_BYTES)
            used = 0
          }
        }
      }
      if (used) { await checkpoint(); yield buffer.subarray(0, used) }
    } finally {
      await cleanup()
    }
  }

  try {
    snapshot = await db.beginSnapshot()
    // The first read pins the transaction snapshot before the response can emit bytes.
    const workspace = await snapshot.get('SELECT id,name,createdAt FROM workspaces WHERE id=?', wid)
    if (!workspace) throw new HttpError(403, 'Workspace access denied')
    stream = Readable.from(body(workspace), { objectMode: false, highWaterMark: STREAM_CHUNK_BYTES })
    stream.once('close', settleCleanup)
    stream.once('error', settleCleanup)
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    response.once('finish', disconnected)
    timer = setTimeout(() => {
      stream!.destroy(new HttpError(504, 'Bulk read deadline exceeded'))
      settleCleanup()
    }, Math.max(0, deadline - Date.now()))
    timer.unref()
    if (request.aborted || response.destroyed) { disconnected(); return }
    ctx.response.stream(stream, (error) => {
      settleCleanup()
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      const status = error instanceof HttpError && [401, 403, 504].includes(error.status) ? error.status : 500
      return [JSON.stringify({ error: status === 401 ? 'Authentication required' : status === 403 ? 'Workspace access denied' : status === 504 ? 'Bulk read deadline exceeded' : 'Bulk read failed' }), status]
    })
  } catch (error) {
    stream?.destroy()
    try { await cleanup() } catch {}
    throw error
  }
}
