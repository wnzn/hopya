import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { HttpError, type Item } from './types.js'

export const PAGE_BYTES = 2 * 1024 * 1024
export const RECORD_BYTES = 8 * 1024 * 1024
export const itemColumns = 'id,workspaceId,nodeId,title,description,status,priority,startDate,dueDate,tags,customFields,assigneeId,checklist,parentId,archivedAt,createdAt,updatedAt'
// A single per-task checklist entry: ids are UUIDs, text is trimmed 1..200
// chars, done defaults to false. Validation lives in service.ts; decoding only
// parses the stored JSON so pages, streams, exports and bulk readers carry the
// fields through the existing serialization without new budget code.
export interface ChecklistEntry { id: string; text: string; done: boolean }
// Subtask link: null for top-level tasks, otherwise the id of another item in
// the same workspace. Cross-list parenting is allowed.
export type ItemWithSubtasks = Item & { checklist: ChecklistEntry[]; parentId: string | null }
export type ItemRow = Omit<ItemWithSubtasks, 'tags' | 'customFields' | 'checklist'> & { tags: string; customFields: string; checklist: string }
export const decodeItem = (row: ItemRow): ItemWithSubtasks => ({ ...row, tags: JSON.parse(row.tags), customFields: JSON.parse(row.customFields), checklist: JSON.parse(row.checklist ?? '[]') })
export const statusId = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
export const itemFilters = z.object({
  nodeId: z.string().uuid().optional(), search: z.string().max(300).optional(),
  status: statusId.optional(), archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
}).strict()
export const pageFilters = itemFilters.extend({
  limit: z.union([z.number(), z.string().regex(/^[1-9]\d{0,2}$/).transform(Number)]).pipe(z.number().int().min(1).max(500)).default(200),
  cursor: z.string().min(1).max(1024).optional(),
})

export function itemQuery(database: Database.Database, wid: string, filters: unknown): { where: string; values: string[]; scope: string; index: string } {
  const query = itemFilters.parse(filters)
  const clauses = ['workspaceId=?']
  const values: string[] = [wid]
  if (query.nodeId) {
    if (!database.prepare('SELECT id FROM nodes WHERE workspaceId=? AND id=?').get(wid, query.nodeId)) throw new HttpError(404, 'Node not found')
    clauses.push('nodeId=?'); values.push(query.nodeId)
  }
  if (query.status) { clauses.push('status=?'); values.push(query.status) }
  if (query.archived === 'exclude') clauses.push('archivedAt IS NULL')
  if (query.archived === 'only') clauses.push('archivedAt IS NOT NULL')
  if (query.search) {
    clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')")
    const pattern = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`
    values.push(pattern, pattern)
  }
  const scope = createHash('sha256').update(JSON.stringify([wid, query.nodeId ?? null, query.search ?? null, query.status ?? null, query.archived])).digest('hex')
  return { where: clauses.join(' AND '), values, scope, index: query.archived === 'include' ? 'items_workspace_read' : 'items_workspace_archive_read' }
}

const cursorSchema = z.object({ v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime().refine((value) => new Date(value).toISOString() === value), id: z.string().uuid(),
}).strict()
export function encodeCursor(scope: string, key: Pick<Item, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, createdAt: key.createdAt, id: key.id })).toString('base64url')
}
export function decodeCursor(cursor: string, scope: string): { v: 1; scope: string; createdAt: string; id: string } {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
    const payload = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    if (payload.scope !== scope || encodeCursor(scope, payload) !== cursor) throw new Error()
    return payload
  } catch { throw new HttpError(400, 'Invalid item cursor') }
}

export function encodeRecord(value: unknown): string {
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json) > RECORD_BYTES) throw new HttpError(500, 'Stored record exceeds read limit')
  return json
}
