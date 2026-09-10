import { randomUUID } from 'node:crypto'
import { Effect } from 'effect'
import { z } from 'zod'
import { db, audit } from './database.js'
import { HttpError, permissions, type Permission, type Membership, type Item, type Comment, type Notification } from './types.js'
import { decodeItem, type ItemRow, itemQuery, itemColumns, pageFilters, decodeCursor, encodeCursor, encodeRecord, PAGE_BYTES, statusId, type ChecklistEntry, type ItemWithSubtasks } from './task_reads.js'
import { emitEvent } from './automations.js'
import { anchorColumns, commentAnchorSchema, decodeAnchor, relocateAnchors, validateAnchor } from './comment_anchors.js'

// --- Effect-based validation -------------------------------------------------
// Fallible internal checks compose as Effects with a single typed failure.
// Pure validation wrappers run their Effect via Effect.either + Effect.runSync and map the
// typed failure back to the pre-existing HttpError status/message at the
// boundary, so routes and tests observe identical throws. Expected defects
// (SQLite errors) stay defects: only ServiceFailure values are mapped.
class ServiceFailure {
  readonly _tag = 'ServiceFailure'
  constructor(readonly status: number, readonly message: string) {}
}
const fail = (status: number, message: string): Effect.Effect<never, ServiceFailure> =>
  Effect.fail(new ServiceFailure(status, message))
function runChecked<A>(effect: Effect.Effect<A, ServiceFailure>): A {
  const result = Effect.runSync(Effect.either(effect))
  if (result._tag === 'Left') throw new HttpError(result.left.status, result.left.message)
  return result.right
}
const findNodeRow = async (wid: string, nodeId: string): Promise<NodeRow> => {
  const row = await db.get<NodeRow>('SELECT * FROM nodes WHERE workspaceId=? AND id=?', wid, nodeId)
  if (!row) throw new HttpError(404, 'Node not found')
  return row
}
// Hierarchy metadata is visible to task/document readers and structure managers.
async function requireStructureRead(userId: string, wid: string): Promise<Membership> {
  const member = await requireMembership(userId, wid)
  if (!member.permissions.some((permission) => permission === 'items:read' || permission === 'documents:read' || permission === 'documents:write' || permission === 'structure:write')) throw new HttpError(403, 'Structure access denied')
  return member
}
async function requireTaskStructureRead(userId: string, wid: string): Promise<Membership> {
  const member = await requireMembership(userId, wid)
  if (!member.permissions.some((permission) => permission === 'items:read' || permission === 'structure:write')) throw new HttpError(403, 'Task structure access denied')
  return member
}
export async function lockWorkspaceHierarchy(wid: string) {
  if (db.dialect === 'pg') await db.get('SELECT pg_advisory_xact_lock(hashtext(?))', wid)
}
const id = z.string().uuid()
const name = z.string().trim().min(1).max(120)
const nodeIcon = z.enum(['diamond', 'briefcase', 'target', 'folder', 'archive', 'bookmark', 'list', 'checklist', 'calendar', 'flag'])
const nodeColor = z.enum(['slate', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'rose'])
export const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase())
export const passwordSchema = z.string().min(12).max(256)
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}, 'Invalid calendar date')
function normalizeItemDescription(value: string): string { return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') }
const itemDescription = z.string().transform(normalizeItemDescription).pipe(z.string().max(50000))
const commentBody = z.string().transform(normalizeItemDescription).pipe(z.string().trim().min(1).max(10000))
// Raw checklist input: entries carry an optional id, 1..400 chars of text and
// an optional done flag. Structural caps (100 entries, 400 raw chars) reject
// here as 400 via the route ZodError mapping; trimming, the 1..200 text rule,
// id normalization and done defaults run in normalizeChecklistEffect so they
// map to HttpError 400 at the same boundary as every other item rule.
const checklistInput = z.array(z.object({
  id: z.string().max(100).optional(), text: z.string().max(400), done: z.boolean().optional(),
})).max(100).default([])
const itemSchema = z.object({
  nodeId: id, title: z.string().trim().min(1).max(300), description: itemDescription.default(''),
  status: statusId.optional(),
  priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).default('none'),
  startDate: dateSchema.nullable().default(null), dueDate: dateSchema.nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).transform((tags) => [...new Set(tags)]).default([]),
  customFields: z.record(id, z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.array(z.string().min(1).max(120)).max(100), z.null()]))
    .refine((value) => Object.keys(value).length <= 100, 'Too many custom fields').default({}),
  assigneeId: id.nullable().default(null),
  checklist: checklistInput, parentId: id.nullable().default(null),
}).strict()
const roleSchema = z.object({ name, permissions: z.array(z.enum(permissions)).max(permissions.length).transform((values) => [...new Set(values)]) }).strict()
interface RoleRow extends Record<string, unknown> { id: string; workspaceId: string; name: string; permissions: string; isOwner: number }
interface NodeRow extends Record<string, unknown> { id: string; workspaceId: string; name: string; description: string; kind: 'project' | 'folder' | 'list'; parentId: string | null; icon: z.infer<typeof nodeIcon> | null; color: z.infer<typeof nodeColor> | null; createdAt: string }
const dateFormat = z.enum(['yyyy-MM-dd', 'MMM d, yyyy', 'MMMM d, yyyy', 'dd/MM/yyyy'])
export const formulaExpression = z.string().max(200)
const fieldSchema = z.object({ name, type: z.enum(['text', 'number', 'date', 'datetime', 'checkbox', 'select', 'checklist', 'rating', 'formula']),
  options: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  settings: z.object({ dateFormat: dateFormat.optional(), maxRating: z.number().int().min(1).max(10).optional(), formula: formulaExpression.min(1).optional() }).strict().optional(),
}).strict()
export type FieldDefinition = z.output<typeof fieldSchema> & { id: string; workspaceId: string }
type FieldRow = Omit<FieldDefinition, 'options' | 'settings'> & { options: string; settings: string }
export const decodeField = ({ settings, ...row }: FieldRow): FieldDefinition => ({ ...row, options: JSON.parse(row.options), ...(settings === '{}' ? {} : { settings: JSON.parse(settings) }) })
const validateFieldEffect = (field: z.output<typeof fieldSchema>): Effect.Effect<void, ServiceFailure> =>
  Effect.gen(function* () {
    const choices = field.type === 'select' || field.type === 'checklist'
    if (choices ? !field.options.length || new Set(field.options).size !== field.options.length : field.options.length > 0) {
      yield* fail(400, 'Only select and checklist fields accept unique, nonempty options')
    }
    if (field.settings?.dateFormat !== undefined && field.type !== 'date' && field.type !== 'datetime') {
      yield* fail(400, 'Date format requires a date or datetime field')
    }
    if (field.settings?.maxRating !== undefined && field.type !== 'rating') {
      yield* fail(400, 'Maximum rating requires a rating field')
    }
    if (field.settings?.formula !== undefined && field.type !== 'formula') {
      yield* fail(400, 'Formula settings require a formula field')
    }
  })
function validateField(field: z.output<typeof fieldSchema>) {
  runChecked(validateFieldEffect(field))
}
export function validFieldValue(field: FieldDefinition, value: unknown): boolean {
  if (value === null) return true
  return field.type === 'text' ? typeof value === 'string'
    : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : field.type === 'checkbox' ? typeof value === 'boolean'
    : field.type === 'date' ? dateSchema.safeParse(value).success
    : field.type === 'datetime' ? z.string().max(64).datetime({ offset: true })
      .refine((value) => /(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value))).safeParse(value).success
    : field.type === 'rating' ? typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= (field.settings?.maxRating ?? 5)
    : field.type === 'checklist' ? Array.isArray(value) && new Set(value).size === value.length && value.every((option) => typeof option === 'string' && field.options.includes(option))
    : field.type === 'formula' ? formulaExpression.safeParse(value).success
    : typeof value === 'string' && field.options.includes(value)
}
// Formula fields may define one shared expression or retain legacy per-task expressions.
export const formulaReferences = (expression: string): string[] => [...expression.matchAll(/"(?:[^"]|"")*"|\{\{([^{}]*)\}\}/g)].flatMap(match => match[1] === undefined ? [] : [match[1].trim()])
const now = () => new Date().toISOString()
export const nextItemUpdatedAt = (previous: string): string => new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString()
const decodeRole = (row: RoleRow) => ({ ...row, isOwner: Boolean(row.isOwner), permissions: JSON.parse(row.permissions) as Permission[] })
const builtInField = z.enum(['priority', 'startDate', 'tags', 'description', 'nodeId', 'createdAt', 'updatedAt'])
const coreListColumn = z.enum(['title', 'status', 'assigneeId', 'dueDate'])
const customListColumn = z.string().max(43)
  .refine((value) => value.startsWith('custom:') && id.safeParse(value.slice('custom:'.length)).success, 'Invalid custom column key')
const listColumn = z.union([coreListColumn, builtInField, customListColumn])
const uniqueListColumns = (maximum: number) => z.array(listColumn).max(maximum)
  .refine((values) => new Set(values).size === values.length, 'Duplicate column keys')
const listSort = z.object({ column: listColumn, direction: z.enum(['asc', 'desc']) }).strict().nullable()
const timestamp = z.string().max(64).datetime({ offset: true })
const mentionPattern = /\[[^\]\n]{1,300}\]\((\/app\?[^)\s]{1,2000})\)/g
export const commentReactionEmojis = ['👍', '❤️', '😂', '🎉', '😕', '👀'] as const
const commentReactionEmoji = z.enum(commentReactionEmojis)
function mentionedUsers(markdown: string, wid: string): string[] {
  const result = new Set<string>()
  for (const match of markdown.matchAll(mentionPattern)) {
    try {
      const url = new URL(match[1], 'http://hopya.local')
      if (url.pathname !== '/app' || url.searchParams.get('workspace') !== wid) continue
      const userId = url.searchParams.get('mentionUser')
      if (userId && id.safeParse(userId).success) result.add(userId)
    } catch { /* Ignore malformed links; ordinary Markdown remains valid content. */ }
  }
  if (result.size > 20) throw new HttpError(400, 'Content may mention at most 20 users')
  return [...result]
}
async function activeReadableMentionTargets(wid: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return []
  const placeholders = userIds.map(() => '?').join(',')
  const rows = await db.all<{ userId: string; permissions: string }>(`SELECT m.userId,r.permissions FROM memberships m
    JOIN users u ON u.id=m.userId JOIN roles r ON r.workspaceId=m.workspaceId AND r.id=m.roleId
    WHERE m.workspaceId=? AND u.disabled=0 AND m.userId IN (${placeholders})`, wid, ...userIds)
  const allowed = rows.filter(row => (JSON.parse(row.permissions) as Permission[]).includes('items:read')).map(row => row.userId)
  if (allowed.length !== userIds.length) throw new HttpError(400, 'Mentioned users must be active workspace readers')
  return allowed
}
async function notify(userId: string, actorId: string, wid: string, type: Notification['type'], itemId: string, commentId: string | null, createdAt: string) {
  if (userId === actorId) return
  await db.run('INSERT INTO notifications(id,workspaceId,userId,actorId,type,itemId,commentId,createdAt) VALUES (?,?,?,?,?,?,?,?)',
    randomUUID(), wid, userId, actorId, type, itemId, commentId, createdAt)
}
async function syncItemMentions(actorId: string, wid: string, itemId: string, markdown: string, createdAt: string) {
  const targets = await activeReadableMentionTargets(wid, mentionedUsers(markdown, wid))
  const previous = new Set((await db.all<{ userId: string }>('SELECT userId FROM item_mentions WHERE workspaceId=? AND itemId=?', wid, itemId)).map(row => row.userId))
  await db.run('DELETE FROM item_mentions WHERE workspaceId=? AND itemId=?', wid, itemId)
  for (const userId of targets) {
    await db.run('INSERT INTO item_mentions(workspaceId,itemId,userId) VALUES (?,?,?)', wid, itemId, userId)
    if (!previous.has(userId)) await notify(userId, actorId, wid, 'mention', itemId, null, createdAt)
  }
}
const bulkItemsSchema = z.object({
  action: z.enum(['archive', 'delete']),
  items: z.array(z.object({ id, expectedUpdatedAt: timestamp }).strict()).min(1).max(100)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length, 'Duplicate task IDs'),
}).strict()
const listViewScopeSchema = z.object({ projectId: id.optional() }).strict()
const listViewSettingsSchema = z.object({
  projectId: id.nullable().optional(),
  columnOrder: uniqueListColumns(111),
  hiddenColumns: uniqueListColumns(110),
  sort: listSort,
  expectedUpdatedAt: timestamp.nullable(),
}).strict()
const statusesSchema = z.array(z.object({ id: statusId, name, color: z.string().regex(/^#[0-9a-fA-F]{6}$/), completed: z.boolean() }).strict()).min(1).max(50)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length, 'Duplicate status IDs')
const defaultStatuses: z.infer<typeof statusesSchema> = [
  { id: 'todo', name: 'To do', color: '#64748b', completed: false },
  { id: 'backlog', name: 'Backlog', color: '#94a3b8', completed: false },
  { id: 'in_progress', name: 'In progress', color: '#3b82f6', completed: false },
  { id: 'review', name: 'Review', color: '#a855f7', completed: false },
  { id: 'done', name: 'Done', color: '#22c55e', completed: true },
]
const tagColorsSchema = z.record(z.string().trim().min(1).max(60), z.string().regex(/^#[0-9a-fA-F]{6}$/))
  .refine((value) => Object.keys(value).length <= 30, 'A list can configure at most 30 tag colors')
export interface ProjectFieldConfiguration { projectId: string; fieldIds: string[]; builtInFields: z.infer<typeof builtInField>[]; statuses: z.infer<typeof statusesSchema>; dateFormat?: z.infer<typeof dateFormat>; updatedAt: string }
export interface ListStatusConfiguration { listId: string; statuses?: z.infer<typeof statusesSchema>; updatedAt: string; inheritedProjectUpdatedAt?: string }
export interface ListTagColorConfiguration { listId: string; colors: Record<string, string>; updatedAt: string }
export interface ListViewSettings { view: 'list'; projectId: string | null; columnOrder: string[]; hiddenColumns: string[]; sort: z.infer<typeof listSort>; updatedAt: string | null }
interface ListViewSettingsRow extends Record<string, unknown> { id: string; projectId: string | null; columnOrder: string; hiddenColumns: string; sort: string | null; updatedAt: string }
async function projectConfiguration(wid: string, projectId: string): Promise<ProjectFieldConfiguration> {
  const node = await nodeInWorkspace(wid, projectId)
  if (node.parentId !== null || (node.kind !== 'project' && node.kind !== 'list')) throw new HttpError(400, 'Target must be a root project or standalone list')
  const row = await db.get<{ builtInFields: string; statuses: string; dateFormat: ProjectFieldConfiguration['dateFormat'] | null; updatedAt: string }>('SELECT builtInFields,statuses,dateFormat,updatedAt FROM project_field_configs WHERE workspaceId=? AND projectId=?', wid, projectId)
  if (!row) throw new HttpError(500, 'Field configuration is unavailable')
  const statuses = node.kind === 'list'
    ? JSON.parse((await db.get<{ statuses: string }>('SELECT statuses FROM list_status_configs WHERE workspaceId=? AND listId=?', wid, projectId))!.statuses)
    : JSON.parse(row.statuses)
  return { projectId, fieldIds: (await db.all<{ fieldId: string }>('SELECT fieldId FROM project_field_assignments WHERE workspaceId=? AND projectId=? ORDER BY position,fieldId', wid, projectId)).map((row) => row.fieldId), builtInFields: JSON.parse(row.builtInFields), statuses, ...(row.dateFormat === null ? {} : { dateFormat: row.dateFormat }), updatedAt: row.updatedAt }
}

async function validateListViewProject(wid: string, projectId: string | null): Promise<void> {
  if (projectId !== null) await projectConfiguration(wid, projectId)
}

async function listViewSettingsRow(wid: string, userId: string, projectId: string | null): Promise<ListViewSettingsRow | undefined> {
  return db.get<ListViewSettingsRow>(`SELECT id,projectId,columnOrder,hiddenColumns,sort,updatedAt FROM list_view_settings
    WHERE workspaceId=? AND userId=? AND view='list' AND ${db.sql({ sqlite: 'projectId IS ?', pg: 'projectId IS NOT DISTINCT FROM ?' })}`, wid, userId, projectId)
}

async function defaultListColumnOrder(wid: string, projectId: string | null): Promise<string[]> {
  const columns = ['title', 'status', 'assigneeId', 'dueDate']
  const projects = projectId === null
    ? (await db.all<{ id: string }>("SELECT id FROM nodes WHERE workspaceId=? AND parentId IS NULL AND kind IN ('project','list') ORDER BY createdAt,id", wid)).map((row) => row.id)
    : [projectId]
  const optional = new Set<string>()
  const custom = new Set<string>()
  for (const target of projects) {
    const config = await projectConfiguration(wid, target)
    config.builtInFields.forEach((column) => optional.add(column))
    config.fieldIds.forEach((fieldId) => custom.add(`custom:${fieldId}`))
  }
  builtInField.options.forEach((column) => { if (optional.has(column)) columns.push(column) })
  for (const row of await db.all<{ id: string }>('SELECT id FROM fields WHERE workspaceId=? ORDER BY name,id', wid)) {
    const key = `custom:${row.id}`
    if (custom.has(key)) columns.push(key)
  }
  return columns
}

function decodeListViewSettings(row: ListViewSettingsRow): ListViewSettings {
  return {
    view: 'list', projectId: row.projectId,
    columnOrder: JSON.parse(row.columnOrder), hiddenColumns: JSON.parse(row.hiddenColumns),
    sort: row.sort === null ? null : JSON.parse(row.sort), updatedAt: row.updatedAt,
  }
}

async function normalizeStoredListViewSettings(wid: string, row: ListViewSettingsRow): Promise<ListViewSettings> {
  const stored = decodeListViewSettings(row)
  const defaults = await defaultListColumnOrder(wid, row.projectId)
  const available = new Set(defaults)
  const columnOrder = [...new Set(stored.columnOrder.filter((column) => available.has(column)))]
  const hiddenColumns = stored.hiddenColumns.filter((column) => column !== 'title' && columnOrder.includes(column))
  const sort = stored.sort && columnOrder.includes(stored.sort.column) && !hiddenColumns.includes(stored.sort.column) ? stored.sort : null
  return { ...stored, columnOrder, hiddenColumns, sort }
}

async function reconcileListViewSettings(wid: string, projectId?: string): Promise<void> {
  const rows = (projectId === undefined
    ? await db.all<ListViewSettingsRow>("SELECT id,projectId,columnOrder,hiddenColumns,sort,updatedAt FROM list_view_settings WHERE workspaceId=? AND view='list'", wid)
    : await db.all<ListViewSettingsRow>("SELECT id,projectId,columnOrder,hiddenColumns,sort,updatedAt FROM list_view_settings WHERE workspaceId=? AND view='list' AND projectId=?", wid, projectId))
  for (const row of rows) {
    const normalized = await normalizeStoredListViewSettings(wid, row)
    const columnOrder = JSON.stringify(normalized.columnOrder)
    const hiddenColumns = JSON.stringify(normalized.hiddenColumns)
    const sort = normalized.sort === null ? null : JSON.stringify(normalized.sort)
    if (columnOrder === row.columnOrder && hiddenColumns === row.hiddenColumns && sort === row.sort) continue
    await db.run('UPDATE list_view_settings SET columnOrder=?,hiddenColumns=?,sort=?,updatedAt=? WHERE id=?', columnOrder, hiddenColumns, sort, nextItemUpdatedAt(row.updatedAt), row.id)
  }
}

async function validateListViewColumns(wid: string, projectId: string | null, data: z.output<typeof listViewSettingsSchema>): Promise<void> {
  if (!data.columnOrder.includes('title') || data.hiddenColumns.includes('title')) throw new HttpError(400, 'Title column must remain visible')
  const ordered = new Set(data.columnOrder)
  if (data.hiddenColumns.some((column) => !ordered.has(column))) throw new HttpError(400, 'Hidden columns must be present in columnOrder')
  if (data.sort && (!ordered.has(data.sort.column) || data.hiddenColumns.includes(data.sort.column))) throw new HttpError(400, 'Sort column must be known and visible')
  const customIds = new Set([...data.columnOrder, ...data.hiddenColumns, ...(data.sort ? [data.sort.column] : [])]
    .filter((column) => column.startsWith('custom:')).map((column) => column.slice('custom:'.length)))
  for (const fieldId of customIds) {
    const field = projectId === null
      ? await db.get('SELECT id FROM fields WHERE workspaceId=? AND id=?', wid, fieldId)
      : await db.get(`SELECT f.id FROM fields f JOIN project_field_assignments a
          ON a.workspaceId=f.workspaceId AND a.fieldId=f.id WHERE f.workspaceId=? AND f.id=? AND a.projectId=?`, wid, fieldId, projectId)
    if (!field) throw new HttpError(400, 'Unknown custom column for view scope')
  }
}

async function nodeProject(wid: string, nodeId: string): Promise<string | null> {
  let node = await nodeInWorkspace(wid, nodeId)
  let depth = 0
  while (node.parentId) {
    if (++depth > 32) throw new HttpError(400, 'Maximum hierarchy depth exceeded')
    node = await nodeInWorkspace(wid, node.parentId)
  }
  return node.kind === 'project' ? node.id : null
}

async function listStatusConfiguration(wid: string, listId: string): Promise<ListStatusConfiguration> {
  const node = await nodeInWorkspace(wid, listId)
  if (node.kind !== 'list') throw new HttpError(400, 'Target must be a list')
  const row = (await db.get<{ statuses: string | null; updatedAt: string }>('SELECT statuses,updatedAt FROM list_status_configs WHERE workspaceId=? AND listId=?', wid, listId))!
  const projectId = await nodeProject(wid, listId)
  if (projectId === null && row.statuses === null) throw new HttpError(500, 'Standalone list status configuration is unavailable')
  return {
    listId, ...(row.statuses === null ? {} : { statuses: JSON.parse(row.statuses) }), updatedAt: row.updatedAt,
    ...(projectId === null ? {} : { inheritedProjectUpdatedAt: (await projectConfiguration(wid, projectId)).updatedAt }),
  }
}

async function listTagColorConfiguration(wid: string, listId: string): Promise<ListTagColorConfiguration> {
  const node = await nodeInWorkspace(wid, listId)
  if (node.kind !== 'list') throw new HttpError(400, 'Target must be a list')
  const row = (await db.get<{ colors: string; updatedAt: string }>('SELECT colors,updatedAt FROM list_tag_color_configs WHERE workspaceId=? AND listId=?', wid, listId))!
  return { listId, colors: JSON.parse(row.colors), updatedAt: row.updatedAt }
}

export async function effectiveListStatuses(wid: string, listId: string): Promise<ProjectFieldConfiguration['statuses']> {
  const config = await listStatusConfiguration(wid, listId)
  if (config.statuses) return config.statuses
  const projectId = await nodeProject(wid, listId)
  if (projectId === null) throw new HttpError(500, 'Standalone list status configuration is unavailable')
  return (await projectConfiguration(wid, projectId)).statuses
}

async function assertListTasksStatuses(wid: string, listId: string, statuses: ProjectFieldConfiguration['statuses']) {
  const ids = statuses.map((status) => status.id)
  const invalid = await db.get(`SELECT id FROM items WHERE workspaceId=? AND nodeId=?
    AND status NOT IN (${ids.map(() => '?').join(',')}) LIMIT 1`, wid, listId, ...ids)
  if (invalid) throw new HttpError(409, 'Tasks use statuses absent from the list status configuration')
}

async function assertInheritedSubtreeStatuses(wid: string, nodeId: string, statuses: ProjectFieldConfiguration['statuses']) {
  const ids = statuses.map((status) => status.id)
  const invalid = await db.get(`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM nodes WHERE workspaceId=? AND id=?
    UNION SELECT n.id FROM nodes n JOIN descendants d ON n.parentId=d.id WHERE n.workspaceId=?
  ) SELECT i.id FROM items i JOIN descendants d ON i.nodeId=d.id
    JOIN list_status_configs c ON c.workspaceId=i.workspaceId AND c.listId=i.nodeId AND c.statuses IS NULL
    WHERE i.workspaceId=? AND i.status NOT IN (${ids.map(() => '?').join(',')}) LIMIT 1`, wid, nodeId, wid, wid, ...ids)
  if (invalid) throw new HttpError(409, 'Tasks use statuses absent from the destination project configuration')
}

export async function requireMembership(userId: string, wid: string): Promise<Membership> {
  id.parse(wid)
  const row = await db.get<Omit<Membership, 'permissions' | 'isOwner'> & { permissions: string; isOwner: number }>(`SELECT m.*,r.name AS roleName,r.permissions,r.isOwner FROM memberships m
    JOIN roles r ON r.id=m.roleId AND r.workspaceId=m.workspaceId JOIN users u ON u.id=m.userId
    WHERE m.userId=? AND m.workspaceId=? AND u.disabled=0`, userId, wid)
  if (!row) throw new HttpError(403, 'Workspace access denied')
  return { ...row, isOwner: Boolean(row.isOwner), permissions: JSON.parse(row.permissions) }
}
export async function requirePermission(userId: string, wid: string, permission: Permission): Promise<Membership> {
  const member = await requireMembership(userId, wid)
  if (!member.permissions.includes(permission)) throw new HttpError(403, `Permission required: ${permission}`)
  return member
}
async function roleInWorkspace(wid: string, roleId: string): Promise<RoleRow> {
  const role = await db.get<RoleRow>('SELECT * FROM roles WHERE workspaceId=? AND id=?', wid, roleId)
  if (!role) throw new HttpError(404, 'Role not found')
  return role
}
function assertCanGrant(actor: Membership, role: { permissions: Permission[]; isOwner?: boolean }): void {
  if ((role.isOwner && !actor.isOwner) || role.permissions.some((permission) => !actor.permissions.includes(permission))) {
    throw new HttpError(403, 'Cannot manage privileges above your own')
  }
}
async function nodeInWorkspace(wid: string, nodeId: string): Promise<NodeRow> {
  const node = await db.get<NodeRow>('SELECT * FROM nodes WHERE workspaceId=? AND id=?', wid, nodeId)
  if (!node) throw new HttpError(404, 'Node not found')
  return node
}
async function itemInWorkspace(wid: string, itemId: string): Promise<ItemWithSubtasks> {
  const row = await db.get<ItemRow>('SELECT * FROM items WHERE workspaceId=? AND id=?', wid, itemId)
  if (!row) throw new HttpError(404, 'Item not found')
  return decodeItem(row)
}
async function validateFormulaReferencesInternal(wid: string, expression: string, selfId: string): Promise<true> {
    const references = formulaReferences(expression)
    if (references.length > 20) throw new HttpError(400, 'A formula may reference at most 20 other fields')
    const fields = await db.all<{ id: string; name: string }>('SELECT id,name FROM fields WHERE workspaceId=?', wid)
    for (const reference of references) {
      const field = fields.find((field) => field.name === reference)
      if (field === undefined) throw new HttpError(400, `Formula references unknown field ${reference}`)
      if (field.id === selfId) throw new HttpError(400, 'A formula cannot reference itself')
    }
    return true as const
}

export async function validateFormulaReferences(wid: string, expression: string, selfId: string): Promise<boolean> {
  return validateFormulaReferencesInternal(wid, expression, selfId)
}

const normalizeChecklistEffect = (entries: z.output<typeof checklistInput>): Effect.Effect<ChecklistEntry[], ServiceFailure> =>
  Effect.gen(function* () {
    if (entries.length > 100) return yield* fail(400, 'A task may have at most 100 checklist entries')
    const normalized: ChecklistEntry[] = []
    for (const entry of entries) {
      const text = entry.text.trim()
      if (text.length < 1 || text.length > 200) return yield* fail(400, 'Checklist entries must be 1 to 200 characters')
      normalized.push({ id: entry.id !== undefined && id.safeParse(entry.id).success ? entry.id : randomUUID(), text, done: entry.done ?? false })
    }
    return normalized
  })

// Subtask parents must be existing items in the same workspace (cross-workspace
// ids read as 404, like nodes), never self, and cycle-free via an ancestor
// walk capped at depth 32 like node moves. Cross-list parenting is allowed.
async function validateParent(wid: string, itemId: string | undefined, parentId: string | null): Promise<void> {
    if (parentId === null) return
    if (itemId !== undefined && parentId === itemId) throw new HttpError(400, 'A task cannot be its own parent')
    let current: string | null = parentId
    let depth = 0
    while (current !== null) {
      if (++depth > 32) throw new HttpError(400, 'Maximum subtask depth exceeded')
      if (itemId !== undefined && current === itemId) throw new HttpError(400, 'A task cannot become its own descendant')
      const row: { parentId: string | null } | undefined = await db.get<{ parentId: string | null }>('SELECT parentId FROM items WHERE workspaceId=? AND id=?', wid, current)
      if (!row) throw new HttpError(404, 'Parent task not found')
      current = row.parentId
    }
}

async function assertNoSubtasks(wid: string, itemId: string): Promise<void> {
  if (await db.get('SELECT id FROM items WHERE workspaceId=? AND parentId=? LIMIT 1', wid, itemId)) {
    throw new HttpError(409, 'Task has subtasks and cannot be deleted')
  }
}

async function validateItem(wid: string, itemId: string | undefined, input: z.output<typeof itemSchema>, previous?: Item): Promise<ChecklistEntry[]> {
    const node = await findNodeRow(wid, input.nodeId)
    if (node.kind !== 'list') throw new HttpError(400, 'Tasks must belong to a list')
    const statuses = await effectiveListStatuses(wid, input.nodeId)
    if (!statuses.some((status) => status.id === input.status)) throw new HttpError(400, 'Unknown status for destination list')
    if (input.startDate && input.dueDate && input.startDate > input.dueDate) throw new HttpError(400, 'Start date must not be after due date')
    if (input.assigneeId) {
      const member = await db.get('SELECT m.userId FROM memberships m JOIN users u ON u.id=m.userId WHERE m.workspaceId=? AND m.userId=? AND u.disabled=0', wid, input.assigneeId)
      if (!member) throw new HttpError(400, 'Assignee must be an active workspace member')
    }
    const fields = await db.all<FieldRow>('SELECT * FROM fields WHERE workspaceId=?', wid)
    for (const [fieldId, value] of Object.entries(input.customFields)) {
        const field = fields.find((field) => field.id === fieldId)
        if (field === undefined) throw new HttpError(400, 'Unknown custom field')
        if (value === null) continue
        const decoded = decodeField(field)
        if (!validFieldValue(decoded, value)) throw new HttpError(400, `Invalid value for custom field ${field.name}`)
        if (field.type === 'formula' && previous?.customFields[fieldId] !== value) {
          await validateFormulaReferencesInternal(wid, value as string, field.id)
        }
    }
    const checklist = runChecked(normalizeChecklistEffect(input.checklist))
    await validateParent(wid, itemId, input.parentId)
    return checklist
}

export const service = {
  async listWorkspaces(userId: string) {
    return db.all(`SELECT w.*,r.name AS role FROM workspaces w JOIN memberships m ON m.workspaceId=w.id
      JOIN roles r ON r.id=m.roleId JOIN users u ON u.id=m.userId WHERE m.userId=? AND u.disabled=0 ORDER BY w.createdAt,w.id`, userId)
  },
  async createWorkspace(userId: string, input: unknown) {
    const data = z.object({ name }).strict().parse(input)
    return db.transaction(async () => {
      if (!await db.get('SELECT id FROM users WHERE id=? AND disabled=0', userId)) throw new HttpError(403, 'Account unavailable')
      const workspace = { id: randomUUID(), name: data.name, createdAt: now() }
      await db.run('INSERT INTO workspaces (id,name,createdAt) VALUES (@id,@name,@createdAt)', workspace)
      const ownerId = randomUUID()
      await db.run('INSERT INTO roles (id,workspaceId,name,permissions,isOwner) VALUES (?,?,?,?,?)', ownerId, workspace.id, 'Owner', JSON.stringify(permissions), 1)
      await db.run('INSERT INTO roles (id,workspaceId,name,permissions,isOwner) VALUES (?,?,?,?,?)', randomUUID(), workspace.id, 'Member', JSON.stringify(['items:read', 'items:write', 'items:delete', 'documents:read', 'documents:write', 'documents:delete', 'comments:create', 'structure:write', 'agent:use']), 0)
      await db.run('INSERT INTO roles (id,workspaceId,name,permissions,isOwner) VALUES (?,?,?,?,?)', randomUUID(), workspace.id, 'Viewer', JSON.stringify(['items:read', 'documents:read']), 0)
      await db.run('INSERT INTO memberships (workspaceId,userId,roleId) VALUES (?,?,?)', workspace.id, userId, ownerId)
      await audit(userId, workspace.id, 'workspace.create', workspace.id)
      return workspace
    })
  },
  async getWorkspace(userId: string, wid: string) {
    const membership = await requireMembership(userId, wid)
    const canRead = membership.permissions.includes('items:read')
    const canTaskStructure = canRead || membership.permissions.includes('structure:write')
    const canDocuments = membership.permissions.some((permission) => permission === 'documents:read' || permission === 'documents:write' || permission === 'structure:write')
    const canStructure = canTaskStructure || canDocuments
    const role = decodeRole(await roleInWorkspace(wid, membership.roleId))
    return {
      workspace: await db.get('SELECT * FROM workspaces WHERE id=?', wid),
      role, permissions: membership.permissions,
      members: canRead || membership.permissions.includes('members:manage') ? await service.listMembers(userId, wid) : [],
      roles: canRead || membership.permissions.some((permission) => permission === 'roles:manage' || permission === 'members:manage') ? await service.listRoles(userId, wid) : [role],
      nodes: canStructure ? await service.listNodes(userId, wid) : [], fields: canTaskStructure ? await service.listFields(userId, wid) : [],
      documents: canDocuments ? await (await import('./documents.js')).documentService.listDocuments(userId, wid) : [],
      documentPages: canRead && membership.permissions.includes('documents:read')
        ? await db.all('SELECT documentId,itemId,position FROM document_pages WHERE workspaceId=? ORDER BY position,createdAt,itemId', wid) : [],
      projectFields: canTaskStructure ? await service.listProjectFields(userId, wid) : [],
      listStatusConfigs: canTaskStructure ? await service.listListStatusConfigs(userId, wid) : [],
      listTagColorConfigs: canTaskStructure ? await service.listListTagColorConfigs(userId, wid) : [],
    }
  },
  async updateWorkspace(userId: string, wid: string, input: unknown) {
    const data = z.object({ name }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'workspace:manage')
      await db.run('UPDATE workspaces SET name=? WHERE id=?', data.name, wid)
      await audit(userId, wid, 'workspace.update', wid)
      return db.get('SELECT * FROM workspaces WHERE id=?', wid)
    })
  },
  async deleteWorkspace(userId: string, wid: string) {
    return db.transaction(async () => {
      const member = await requireMembership(userId, wid)
      if (!member.isOwner) throw new HttpError(403, 'Workspace owner required')
      const counts = await db.get<{ members: number; nodes: number; documents: number; items: number; attachments: number }>(`SELECT
        (SELECT count(*) FROM memberships WHERE workspaceId=?) AS members,
        (SELECT count(*) FROM nodes WHERE workspaceId=?) AS nodes,
        (SELECT count(*) FROM documents WHERE workspaceId=?) AS documents,
        (SELECT count(*) FROM items WHERE workspaceId=?) AS items,
        (SELECT count(*) FROM attachments WHERE workspaceId=?) AS attachments`, wid, wid, wid, wid, wid)
      await audit(userId, wid, 'workspace.delete', wid, counts!)
      await db.run('DELETE FROM workspaces WHERE id=?', wid)
      return { success: true }
    })
  },
  async listNodes(userId: string, wid: string): Promise<NodeRow[]> {
    await requireStructureRead(userId, wid)
    return db.all<NodeRow>('SELECT * FROM nodes WHERE workspaceId=? ORDER BY createdAt,id', wid)
  },
  async createNode(userId: string, wid: string, input: unknown): Promise<NodeRow> {
    const data = z.object({ name, description: z.string().max(50000).optional(), kind: z.enum(['project', 'folder', 'list']), parentId: id.nullable().default(null), icon: nodeIcon.nullable().default(null), color: nodeColor.nullable().default(null) }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      await lockWorkspaceHierarchy(wid)
      if (data.description !== undefined && data.kind !== 'project') throw new HttpError(400, 'Only projects accept descriptions')
      if (data.kind === 'project' && data.parentId !== null) throw new HttpError(400, 'Projects cannot have a parent')
      if (data.kind === 'folder' && !data.parentId) throw new HttpError(400, 'Folders require a parent')
      if (data.parentId) {
        const parent = await nodeInWorkspace(wid, data.parentId)
        if (parent.kind === 'list') throw new HttpError(400, 'Lists cannot contain other nodes')
        let depth = 0
        let ancestor: NodeRow = parent
        while (ancestor.parentId) {
          if (++depth >= 32) throw new HttpError(400, 'Maximum hierarchy depth exceeded')
          ancestor = await nodeInWorkspace(wid, ancestor.parentId)
        }
      }
      const node = { id: randomUUID(), workspaceId: wid, ...data, description: data.description ?? '', createdAt: now() }
      await db.run('INSERT INTO nodes (id,workspaceId,name,kind,parentId,createdAt,description,icon,color) VALUES (@id,@workspaceId,@name,@kind,@parentId,@createdAt,@description,@icon,@color)', node)
      if (node.kind === 'project') await db.run('INSERT INTO project_field_configs(workspaceId,projectId,updatedAt) VALUES (?,?,?)', wid, node.id, node.createdAt)
      if (node.kind === 'list' && node.parentId === null) await db.run('INSERT INTO project_field_configs(workspaceId,projectId,updatedAt) VALUES (?,?,?)', wid, node.id, node.createdAt)
      if (node.kind === 'list') await db.run('INSERT INTO list_status_configs(workspaceId,listId,statuses,updatedAt) VALUES (?,?,?,?)', wid, node.id, node.parentId === null ? JSON.stringify(defaultStatuses) : null, node.createdAt)
      if (node.kind === 'list') await db.run("INSERT INTO list_tag_color_configs(workspaceId,listId,colors,updatedAt) VALUES (?,?,'{}',?)", wid, node.id, node.createdAt)
      await audit(userId, wid, 'node.create', node.id)
      await emitEvent({ event: 'node.created', workspaceId: wid, nodeId: node.id, actorId: userId })
      return node
    })
  },
  async updateNode(userId: string, wid: string, nodeId: string, input: unknown) {
    const { expectedParentId, ...data } = z.object({ name: name.optional(), description: z.string().max(50000).optional(), parentId: id.nullable().optional(), expectedParentId: id.nullable().optional(), icon: nodeIcon.nullable().optional(), color: nodeColor.nullable().optional() }).strict()
      .refine((value) => value.name !== undefined || value.parentId !== undefined || value.description !== undefined || value.icon !== undefined || value.color !== undefined, 'Provide a field to update')
      .refine((value) => value.expectedParentId === undefined || value.parentId !== undefined, 'Parent condition requires a parent mutation').parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      await lockWorkspaceHierarchy(wid)
      const previous = await nodeInWorkspace(wid, nodeId)
      if (data.description !== undefined && previous.kind !== 'project') throw new HttpError(400, 'Only projects accept descriptions')
      if (expectedParentId !== undefined && expectedParentId !== previous.parentId) throw new HttpError(409, 'Location changed; reload before moving')
      const parentId = data.parentId === undefined ? previous.parentId : data.parentId
      if (parentId !== previous.parentId) {
        if (previous.kind === 'project') throw new HttpError(400, 'Projects must remain at root')
        if (parentId === null) {
          if (previous.kind !== 'list') throw new HttpError(400, 'Folders require a parent')
          const config = await listStatusConfiguration(wid, nodeId)
          if (config.statuses === undefined) await db.run('UPDATE list_status_configs SET statuses=?,updatedAt=? WHERE workspaceId=? AND listId=?', JSON.stringify(await effectiveListStatuses(wid, nodeId)), nextItemUpdatedAt(config.updatedAt), wid, nodeId)
          await db.run('INSERT INTO project_field_configs(workspaceId,projectId,updatedAt) VALUES (?,?,?) ON CONFLICT(workspaceId,projectId) DO NOTHING', wid, nodeId, now())
        } else {
          let ancestor = await nodeInWorkspace(wid, parentId)
          if (ancestor.kind === 'list') throw new HttpError(400, 'Lists cannot contain other nodes')
          let depth = 1
          while (true) {
            if (ancestor.id === nodeId) throw new HttpError(400, 'A node cannot move into itself or its descendants')
            if (depth > 32) throw new HttpError(400, 'Maximum hierarchy depth exceeded')
            if (!ancestor.parentId) break
            ancestor = await nodeInWorkspace(wid, ancestor.parentId)
            depth++
          }
          if (ancestor.kind !== 'project') throw new HttpError(400, 'Folders and nested lists must belong to a project')
          // A valid new root depth can still push an existing subtree past the limit.
          const subtree = (await db.get<{ height: number }>(`WITH RECURSIVE descendants(id,depth) AS (
            SELECT id,0 FROM nodes WHERE workspaceId=? AND id=?
            UNION ALL SELECT n.id,d.depth+1 FROM nodes n JOIN descendants d ON n.parentId=d.id
            WHERE n.workspaceId=? AND d.depth<32
          ) SELECT max(depth) AS height FROM (
            SELECT depth FROM descendants
            UNION ALL SELECT d.depth+1 FROM documents doc JOIN descendants d ON doc.parentId=d.id WHERE doc.workspaceId=?
          ) heights`, wid, nodeId, wid, wid))!
          if (depth + subtree.height > 32) throw new HttpError(400, 'Moving this subtree would exceed the hierarchy depth limit')
          if (await nodeProject(wid, nodeId) !== ancestor.id) await assertInheritedSubtreeStatuses(wid, nodeId, (await projectConfiguration(wid, ancestor.id)).statuses)
        }
      }
      const updated = await db.run(`UPDATE nodes SET name=?,parentId=?,description=?,icon=?,color=? WHERE workspaceId=? AND id=?
        ${expectedParentId === undefined ? '' : `AND ${db.sql({ sqlite: 'parentId IS ?', pg: 'parentId IS NOT DISTINCT FROM ?' })}`}`,
        data.name ?? previous.name, parentId, data.description ?? previous.description, data.icon === undefined ? previous.icon : data.icon,
        data.color === undefined ? previous.color : data.color, wid, nodeId, ...(expectedParentId === undefined ? [] : [expectedParentId]))
      if (!updated.changes) throw new HttpError(409, 'Location changed; reload before moving')
      await audit(userId, wid, 'node.update', nodeId, { fields: Object.keys(data), previousParentId: previous.parentId, parentId })
      await emitEvent({ event: 'node.updated', workspaceId: wid, nodeId, actorId: userId, changes: {
        ...(data.name !== undefined ? { name: { before: previous.name, after: data.name } } : {}),
        ...(parentId !== previous.parentId ? { parentId: { before: previous.parentId, after: parentId } } : {}),
        ...(data.description !== undefined ? { description: { before: previous.description, after: data.description } } : {}),
        ...(data.icon !== undefined ? { icon: { before: previous.icon, after: data.icon } } : {}),
        ...(data.color !== undefined ? { color: { before: previous.color, after: data.color } } : {}),
      } })
      return nodeInWorkspace(wid, nodeId)
    })
  },
  async deleteNode(userId: string, wid: string, nodeId: string) {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      await lockWorkspaceHierarchy(wid)
      await nodeInWorkspace(wid, nodeId)
      if (await db.get('SELECT id FROM nodes WHERE workspaceId=? AND parentId=? LIMIT 1', wid, nodeId)
        || await db.get('SELECT id FROM documents WHERE workspaceId=? AND parentId=? LIMIT 1', wid, nodeId)
        || await db.get('SELECT id FROM items WHERE workspaceId=? AND nodeId=? LIMIT 1', wid, nodeId)) throw new HttpError(409, 'Node must be empty before deletion')
      await db.run('DELETE FROM nodes WHERE workspaceId=? AND id=?', wid, nodeId)
      await audit(userId, wid, 'node.delete', nodeId)
      await emitEvent({ event: 'node.deleted', workspaceId: wid, nodeId, actorId: userId })
      return { success: true }
    })
  },
  async listItems(userId: string, wid: string, filters: unknown = {}): Promise<ItemWithSubtasks[]> {
    await requirePermission(userId, wid, 'items:read')
    const query = await itemQuery(db, wid, filters)
    return (await db.all<ItemRow>(`SELECT ${itemColumns} FROM items WHERE ${query.where} ORDER BY createdAt,id`, ...query.values)).map(decodeItem)
  },
  async pageItems(userId: string, wid: string, input: unknown = {}): Promise<{ items: ItemWithSubtasks[]; nextCursor: string | null }> {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:read')
      const { limit, cursor, ...filters } = pageFilters.parse(input)
      const query = await itemQuery(db, wid, filters)
      const key = cursor === undefined ? undefined : decodeCursor(cursor, query.scope)
      const rows = await db.all<ItemRow>(`SELECT ${itemColumns} FROM items WHERE ${query.where}
        ${key ? 'AND (createdAt > ? OR (createdAt = ? AND id > ?))' : ''} ORDER BY createdAt,id LIMIT ?`,
        ...(key ? [...query.values, key.createdAt, key.createdAt, key.id] : query.values), limit + 1)
      const items: ItemWithSubtasks[] = []
      // Reserve the envelope and largest cursor, including the lookahead case.
      let bytes = Buffer.byteLength(JSON.stringify({ items: [], nextCursor: 'x'.repeat(1024) }))
      for (const row of rows) {
        if (items.length === limit || bytes >= PAGE_BYTES) return { items, nextCursor: encodeCursor(query.scope, items.at(-1)!) }
        const item = decodeItem(row)
        const size = Buffer.byteLength(encodeRecord(item)) + (items.length ? 1 : 0)
        if (items.length && bytes + size > PAGE_BYTES) return { items, nextCursor: encodeCursor(query.scope, items.at(-1)!) }
        if (bytes + size > PAGE_BYTES) {
          const { id: _id, workspaceId: _wid, bodyRevision: _bodyRevision, archivedAt: _archived, createdAt: _created, updatedAt: _updated, ...mutable } = item
          itemSchema.parse(mutable)
        }
        items.push(item); bytes += size
      }
      return { items, nextCursor: null }
    })
  },
  async agentContext(userId: string, wid: string) {
    await requirePermission(userId, wid, 'agent:use')
    await requirePermission(userId, wid, 'items:read')
    const items = (await db.all<Pick<Item, 'id' | 'nodeId' | 'title' | 'status' | 'priority' | 'startDate' | 'dueDate'>>(`SELECT id,nodeId,title,status,priority,startDate,dueDate FROM items
      WHERE workspaceId=? AND archivedAt IS NULL ORDER BY createdAt DESC,id DESC LIMIT 100`, wid)).reverse()
    const lists = await db.all<{ id: string; name: string }>("SELECT id,name FROM nodes WHERE workspaceId=? AND kind='list' ORDER BY createdAt,id LIMIT 100", wid)
    return { items, lists }
  },
  async getItem(userId: string, wid: string, itemId: string): Promise<ItemWithSubtasks> {
    await requirePermission(userId, wid, 'items:read')
    return itemInWorkspace(wid, itemId)
  },
  async createItem(userId: string, wid: string, input: unknown): Promise<ItemWithSubtasks> {
    const data = itemSchema.parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:write')
      const status = data.status ?? (await effectiveListStatuses(wid, data.nodeId))[0]!.id
      const id = randomUUID()
      const checklist = await validateItem(wid, id, { ...data, status })
      const timestamp = now()
      const item: ItemWithSubtasks = { id, workspaceId: wid, ...data, status, checklist, bodyRevision: 1, archivedAt: null, createdAt: timestamp, updatedAt: timestamp }
      await db.run(`INSERT INTO items (id,workspaceId,nodeId,title,description,status,priority,startDate,dueDate,tags,customFields,assigneeId,checklist,parentId,bodyRevision,createdAt,updatedAt)
        VALUES (@id,@workspaceId,@nodeId,@title,@description,@status,@priority,@startDate,@dueDate,@tags,@customFields,@assigneeId,@checklist,@parentId,@bodyRevision,@createdAt,@updatedAt)`,
        { ...item, tags: JSON.stringify(item.tags), customFields: JSON.stringify(item.customFields), checklist: JSON.stringify(item.checklist) })
      await syncItemMentions(userId, wid, item.id, item.description, timestamp)
      if (item.assigneeId) await notify(item.assigneeId, userId, wid, 'assignment', item.id, null, timestamp)
      await audit(userId, wid, 'item.create', item.id)
      await emitEvent({ event: 'item.created', workspaceId: wid, itemId: item.id, actorId: userId, item })
      return item
    })
  },
  async updateItem(userId: string, wid: string, itemId: string, input: unknown): Promise<ItemWithSubtasks> {
    const { expectedUpdatedAt, ...data } = itemSchema.partial().extend({ expectedUpdatedAt: z.string().max(64).datetime({ offset: true }).optional() }).parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:read')
      await requirePermission(userId, wid, 'items:write')
      await db.get(`SELECT id FROM items WHERE workspaceId=? AND id=? ${db.sql({ pg: 'FOR UPDATE', sqlite: '' })}`, wid, itemId)
      const previous = await itemInWorkspace(wid, itemId)
      // Existing clients may omit the condition and retain last-write-wins behavior.
      if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== previous.updatedAt) throw new HttpError(409, 'Item changed; reload before saving')
      const bodyChanged = data.description !== undefined && data.description !== previous.description
      if (data.parentId && previous.parentId === null && await db.get('SELECT documentId FROM document_pages WHERE workspaceId=? AND itemId=?', wid, itemId)) {
        throw new HttpError(409, 'Unlink this document page before making it a subtask')
      }
      const merged = { ...previous, ...data, bodyRevision: previous.bodyRevision + Number(bodyChanged), updatedAt: nextItemUpdatedAt(previous.updatedAt) }
      const checklist = await validateItem(wid, itemId, merged, previous)
      const item: ItemWithSubtasks = { ...merged, checklist }
      const itemBindings = { ...item, tags: JSON.stringify(item.tags), customFields: JSON.stringify(item.customFields), checklist: JSON.stringify(item.checklist) }
      const updated = await db.run(`UPDATE items SET nodeId=@nodeId,title=@title,description=@description,status=@status,priority=@priority,
        startDate=@startDate,dueDate=@dueDate,tags=@tags,customFields=@customFields,assigneeId=@assigneeId,checklist=@checklist,parentId=@parentId,bodyRevision=@bodyRevision,updatedAt=@updatedAt
        WHERE workspaceId=@workspaceId AND id=@id ${expectedUpdatedAt === undefined ? '' : 'AND updatedAt=@expectedUpdatedAt'}`,
        expectedUpdatedAt === undefined ? itemBindings : { ...itemBindings, expectedUpdatedAt })
      if (!updated.changes) throw new HttpError(409, 'Item changed; reload before saving')
      if (data.description !== undefined) await syncItemMentions(userId, wid, item.id, item.description, item.updatedAt)
      if (bodyChanged) await relocateAnchors('comments', 'itemId', wid, item.id, item.description, item.bodyRevision)
      if (data.assigneeId !== undefined && item.assigneeId && item.assigneeId !== previous.assigneeId) {
        await notify(item.assigneeId, userId, wid, 'assignment', item.id, null, item.updatedAt)
      }
      await audit(userId, wid, 'item.update', itemId, { fields: Object.keys(data) })
      const changes: Record<string, { before?: unknown; after?: unknown }> = {}
      for (const key of Object.keys(data) as (keyof typeof data)[]) {
        const before = previous[key], after = item[key]
        if (JSON.stringify(before) !== JSON.stringify(after)) changes[key] = { before, after }
      }
      if (Object.keys(changes).length) await emitEvent({ event: 'item.updated', workspaceId: wid, itemId, actorId: userId, changes, item })
      return item
    })
  },
  async deleteItem(userId: string, wid: string, itemId: string) {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:delete')
      const item = await itemInWorkspace(wid, itemId)
      await assertNoSubtasks(wid, itemId)
      await db.run('DELETE FROM items WHERE workspaceId=? AND id=?', wid, itemId)
      await audit(userId, wid, 'item.delete', itemId)
      await emitEvent({ event: 'item.deleted', workspaceId: wid, itemId, actorId: userId, item })
      return { success: true }
    })
  },
  async listComments(userId: string, wid: string, itemId: string): Promise<Comment[]> {
    await requirePermission(userId, wid, 'items:read')
    await itemInWorkspace(wid, itemId)
    const comments = await db.all<Comment & Record<string, unknown>>(`SELECT c.id,c.workspaceId,c.itemId,c.authorId,
      CASE WHEN c.authorId IS NULL THEN 'Former member' ELSE COALESCE(u.name,'Former member') END AS authorName,
      CASE WHEN c.deletedAt IS NULL THEN c.body ELSE '' END AS body,c.parentId,c.createdAt,c.deletedAt,
      c.anchorRevision,c.anchorStart,c.anchorEnd,c.anchorExact,c.anchorPrefix,c.anchorSuffix,c.anchorState
      FROM comments c LEFT JOIN users u ON u.id=c.authorId
      WHERE c.workspaceId=? AND c.itemId=? ORDER BY c.createdAt,c.id`, wid, itemId)
    const reactions = await db.all<{ commentId: string; emoji: string; count: number; reactedByMe: number }>(`SELECT commentId,emoji,count(*) AS count,max(CASE WHEN userId=? THEN 1 ELSE 0 END) AS reactedByMe
      FROM comment_reactions WHERE workspaceId=? AND itemId=? GROUP BY commentId,emoji ORDER BY emoji`, userId, wid, itemId)
    const byComment = new Map<string, Comment['reactions']>()
    for (const reaction of reactions) {
      const values = byComment.get(reaction.commentId) ?? []
      values.push({ emoji: reaction.emoji, count: reaction.count, reactedByMe: Boolean(reaction.reactedByMe) })
      byComment.set(reaction.commentId, values)
    }
    return comments.map(comment => ({
      id: comment.id, workspaceId: comment.workspaceId, itemId: comment.itemId, authorId: comment.authorId, authorName: comment.authorName,
      body: comment.body, parentId: comment.parentId, anchor: decodeAnchor(comment), reactions: byComment.get(comment.id) ?? [],
      createdAt: comment.createdAt, deletedAt: comment.deletedAt,
    }))
  },
  async createComment(userId: string, wid: string, itemId: string, input: unknown): Promise<Comment> {
    const data = z.object({ body: commentBody, parentId: id.nullable().optional(), anchor: commentAnchorSchema.optional() }).strict()
      .refine((value) => !value.parentId || value.anchor === undefined, 'Replies inherit the root comment anchor').parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:read')
      await requirePermission(userId, wid, 'comments:create')
      await db.get(`SELECT id FROM items WHERE workspaceId=? AND id=? ${db.sql({ pg: 'FOR UPDATE', sqlite: '' })}`, wid, itemId)
      const item = await itemInWorkspace(wid, itemId)
      const parentId = data.parentId ?? null
      if (parentId) {
        const parent = (await db.get<{ depth: number | null }>(`WITH RECURSIVE lineage(id,parentId,depth) AS (
          SELECT id,parentId,1 FROM comments WHERE workspaceId=? AND itemId=? AND id=?
          UNION ALL SELECT c.id,c.parentId,l.depth+1 FROM comments c JOIN lineage l ON c.id=l.parentId
          WHERE c.workspaceId=? AND c.itemId=? AND l.depth<33
        ) SELECT max(depth) AS depth FROM lineage`, wid, itemId, parentId, wid, itemId))!
        if (parent.depth === null) throw new HttpError(404, 'Parent comment not found')
        if (parent.depth >= 32) throw new HttpError(400, 'Comment reply depth cannot exceed 32')
      }
      const mentioned = await activeReadableMentionTargets(wid, mentionedUsers(data.body, wid))
      const anchor = data.anchor ? validateAnchor(item.description, item.bodyRevision, data.anchor) : null
      const comment = { id: randomUUID(), workspaceId: wid, itemId, authorId: userId, body: data.body, parentId, anchor, reactions: [], createdAt: now(), deletedAt: null, ...anchorColumns(anchor) }
      await db.run(`INSERT INTO comments(id,workspaceId,itemId,authorId,body,parentId,createdAt,anchorRevision,anchorStart,anchorEnd,anchorExact,anchorPrefix,anchorSuffix,anchorState)
        VALUES (@id,@workspaceId,@itemId,@authorId,@body,@parentId,@createdAt,@anchorRevision,@anchorStart,@anchorEnd,@anchorExact,@anchorPrefix,@anchorSuffix,@anchorState)`, comment)
      for (const target of mentioned) {
        await db.run('INSERT INTO comment_mentions(workspaceId,itemId,commentId,userId) VALUES (?,?,?,?)', wid, itemId, comment.id, target)
        await notify(target, userId, wid, 'mention', itemId, comment.id, comment.createdAt)
      }
      await audit(userId, wid, 'comment.create', comment.id, { itemId, parentId, anchored: anchor !== null, mentions: mentioned.length })
      const author = (await db.get<{ name: string }>('SELECT name FROM users WHERE id=?', userId))!
      return {
        id: comment.id, workspaceId: comment.workspaceId, itemId: comment.itemId, authorId: comment.authorId, authorName: author.name,
        body: comment.body, parentId: comment.parentId, anchor, reactions: [], createdAt: comment.createdAt, deletedAt: comment.deletedAt,
      }
    })
  },
  async deleteComment(userId: string, wid: string, itemId: string, commentId: string) {
    id.parse(commentId)
    return db.transaction(async () => {
      const member = await requirePermission(userId, wid, 'items:read')
      await itemInWorkspace(wid, itemId)
      const comment = await db.get<{ authorId: string | null; parentId: string | null; deletedAt: string | null }>('SELECT authorId,parentId,deletedAt FROM comments WHERE workspaceId=? AND itemId=? AND id=?', wid, itemId, commentId)
      if (!comment) throw new HttpError(404, 'Comment not found')
      if (comment.deletedAt) {
        if (!member.permissions.includes('comments:manage')) throw new HttpError(403, 'Comments manager required to remove a deleted entry')
        await db.run('UPDATE comments SET parentId=? WHERE workspaceId=? AND itemId=? AND parentId=?', comment.parentId, wid, itemId, commentId)
        await db.run('DELETE FROM comments WHERE workspaceId=? AND itemId=? AND id=?', wid, itemId, commentId)
        await audit(userId, wid, 'comment.purge', commentId, { itemId })
        return { success: true }
      }
      if (comment.authorId !== userId && !member.permissions.includes('comments:manage')) throw new HttpError(403, 'Comment author or comments manager required')
      await db.run('UPDATE comments SET body=?,deletedAt=? WHERE workspaceId=? AND itemId=? AND id=?', '[deleted]', now(), wid, itemId, commentId)
      await audit(userId, wid, 'comment.delete', commentId, { itemId, own: comment.authorId === userId })
      return { success: true }
    })
  },
  async updateCommentReaction(userId: string, wid: string, itemId: string, commentId: string, input: unknown) {
    id.parse(commentId)
    const data = z.object({ emoji: commentReactionEmoji, active: z.boolean() }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:read')
      await requirePermission(userId, wid, 'comments:create')
      await itemInWorkspace(wid, itemId)
      const comment = await db.get<{ deletedAt: string | null }>('SELECT deletedAt FROM comments WHERE workspaceId=? AND itemId=? AND id=?', wid, itemId, commentId)
      if (!comment) throw new HttpError(404, 'Comment not found')
      if (comment.deletedAt) throw new HttpError(409, 'Deleted comments cannot receive reactions')
      const result = data.active
        ? await db.run('INSERT INTO comment_reactions(workspaceId,itemId,commentId,userId,emoji,createdAt) VALUES (?,?,?,?,?,?) ON CONFLICT(workspaceId,itemId,commentId,userId,emoji) DO NOTHING', wid, itemId, commentId, userId, data.emoji, now())
        : await db.run('DELETE FROM comment_reactions WHERE workspaceId=? AND itemId=? AND commentId=? AND userId=? AND emoji=?', wid, itemId, commentId, userId, data.emoji)
      if (result.changes) await audit(userId, wid, data.active ? 'comment.reaction.add' : 'comment.reaction.remove', commentId, { itemId, emoji: data.emoji })
      const count = (await db.get<{ count: number }>('SELECT count(*) AS count FROM comment_reactions WHERE workspaceId=? AND itemId=? AND commentId=? AND emoji=?', wid, itemId, commentId, data.emoji))!.count
      return { emoji: data.emoji, active: data.active, count }
    })
  },
  async listNotifications(userId: string, wid: string): Promise<Notification[]> {
    await requirePermission(userId, wid, 'items:read')
    return db.all<Notification & Record<string, unknown>>(`SELECT n.id,n.workspaceId,n.type,n.itemId,i.title AS itemTitle,n.commentId,n.actorId,
      CASE WHEN n.actorId IS NULL THEN 'Former member' ELSE COALESCE(u.name,'Former member') END AS actorName,
      n.createdAt,n.readAt FROM notifications n JOIN items i ON i.workspaceId=n.workspaceId AND i.id=n.itemId
      LEFT JOIN users u ON u.id=n.actorId WHERE n.workspaceId=? AND n.userId=?
      ORDER BY n.createdAt DESC,n.id DESC LIMIT 200`, wid, userId)
  },
  async unreadNotificationCount(userId: string, wid: string): Promise<{ unread: number }> {
    await requirePermission(userId, wid, 'items:read')
    const row = (await db.get<{ unread: number }>('SELECT count(*) AS unread FROM notifications WHERE workspaceId=? AND userId=? AND readAt IS NULL', wid, userId))!
    return row
  },
  async updateNotification(userId: string, wid: string, notificationId: string, input: unknown) {
    id.parse(notificationId)
    const data = z.object({ read: z.boolean() }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:read')
      const row = await db.get<{ readAt: string | null }>('SELECT readAt FROM notifications WHERE workspaceId=? AND userId=? AND id=?', wid, userId, notificationId)
      if (!row) throw new HttpError(404, 'Notification not found')
      const readAt = data.read ? row.readAt ?? now() : null
      await db.run('UPDATE notifications SET readAt=? WHERE workspaceId=? AND userId=? AND id=?', readAt, wid, userId, notificationId)
      await audit(userId, wid, data.read ? 'notification.read' : 'notification.unread', notificationId)
      return { id: notificationId, readAt }
    })
  },
  async deleteNotification(userId: string, wid: string, notificationId: string) {
    id.parse(notificationId)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:read')
      const result = await db.run('DELETE FROM notifications WHERE workspaceId=? AND userId=? AND id=?', wid, userId, notificationId)
      if (!result.changes) throw new HttpError(404, 'Notification not found')
      await audit(userId, wid, 'notification.delete', notificationId)
      return { success: true }
    })
  },
  async bulkItems(userId: string, wid: string, input: unknown) {
    const data = bulkItemsSchema.parse(input)
    return db.transaction(async () => {
      if (data.action === 'archive') {
        await requirePermission(userId, wid, 'items:read')
        await requirePermission(userId, wid, 'items:write')
      } else await requirePermission(userId, wid, 'items:delete')
      const selected = new Set(data.items.map((item) => item.id))
      const tasks: ItemWithSubtasks[] = []
      for (const target of data.items) {
        const item = await itemInWorkspace(wid, target.id)
        if (item.updatedAt !== target.expectedUpdatedAt) throw new HttpError(409, 'A selected task changed; reload before continuing')
        if (data.action === 'archive' && item.archivedAt !== null) throw new HttpError(409, 'A selected task is already archived')
        tasks.push(item)
      }
      for (const item of tasks) {
        if ((await db.all<{ id: string }>(`SELECT id FROM items WHERE workspaceId=? AND parentId=?
          ${data.action === 'archive' ? 'AND archivedAt IS NULL' : ''}`, wid, item.id)).some((child) => !selected.has(child.id))) {
          throw new HttpError(409, `Select all subtasks before ${data.action === 'archive' ? 'archiving' : 'deleting'} their parent`)
        }
      }
      if (data.action === 'archive') {
        const archivedAt = now()
        for (const item of tasks) {
          const updatedAt = nextItemUpdatedAt(item.updatedAt)
          await db.run('UPDATE items SET archivedAt=?,updatedAt=? WHERE workspaceId=? AND id=?', archivedAt, updatedAt, wid, item.id)
          await emitEvent({ event: 'item.updated', workspaceId: wid, itemId: item.id, actorId: userId,
            changes: { archivedAt: { before: null, after: archivedAt } }, item: { ...item, archivedAt, updatedAt } })
        }
      } else {
        const depth = (item: ItemWithSubtasks) => {
          let value = 0
          let parentId = item.parentId
          while (parentId && selected.has(parentId) && value <= 32) {
            value++
            parentId = tasks.find((candidate) => candidate.id === parentId)?.parentId ?? null
          }
          return value
        }
        for (const item of [...tasks].sort((left, right) => depth(right) - depth(left))) {
          await db.run('DELETE FROM items WHERE workspaceId=? AND id=?', wid, item.id)
          await emitEvent({ event: 'item.deleted', workspaceId: wid, itemId: item.id, actorId: userId, item })
        }
      }
      await audit(userId, wid, `item.bulk.${data.action}`, null, { count: tasks.length })
      return { action: data.action, affected: tasks.length }
    })
  },
  async listFields(userId: string, wid: string) {
    await requireTaskStructureRead(userId, wid)
    return (await db.all<FieldRow>('SELECT * FROM fields WHERE workspaceId=? ORDER BY name,id', wid)).map(decodeField)
  },
  async listProjectFields(userId: string, wid: string): Promise<ProjectFieldConfiguration[]> {
    await requireTaskStructureRead(userId, wid)
    const nodes = (await service.listNodes(userId, wid)).filter((node) => node.parentId === null && (node.kind === 'project' || node.kind === 'list'))
    const configurations: ProjectFieldConfiguration[] = []
    for (const node of nodes) configurations.push(await projectConfiguration(wid, node.id))
    return configurations
  },
  async listListStatusConfigs(userId: string, wid: string): Promise<ListStatusConfiguration[]> {
    await requireTaskStructureRead(userId, wid)
    const nodes = (await service.listNodes(userId, wid)).filter((node) => node.kind === 'list')
    const configurations: ListStatusConfiguration[] = []
    for (const node of nodes) configurations.push(await listStatusConfiguration(wid, node.id))
    return configurations
  },
  async listListTagColorConfigs(userId: string, wid: string): Promise<ListTagColorConfiguration[]> {
    await requireTaskStructureRead(userId, wid)
    const nodes = (await service.listNodes(userId, wid)).filter((node) => node.kind === 'list')
    const configurations: ListTagColorConfiguration[] = []
    for (const node of nodes) configurations.push(await listTagColorConfiguration(wid, node.id))
    return configurations
  },
  async getListViewSettings(userId: string, wid: string, input: unknown = {}): Promise<ListViewSettings> {
    await requirePermission(userId, wid, 'items:read')
    const projectId = listViewScopeSchema.parse(input).projectId ?? null
    await validateListViewProject(wid, projectId)
    const row = await listViewSettingsRow(wid, userId, projectId)
    return row ? normalizeStoredListViewSettings(wid, row) : {
      view: 'list', projectId, columnOrder: await defaultListColumnOrder(wid, projectId), hiddenColumns: [], sort: null, updatedAt: null,
    }
  },
  async updateListViewSettings(userId: string, wid: string, input: unknown): Promise<ListViewSettings> {
    const data = listViewSettingsSchema.parse(input)
    const projectId = data.projectId ?? null
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'items:read')
      await validateListViewProject(wid, projectId)
      await validateListViewColumns(wid, projectId, data)
      const previous = await listViewSettingsRow(wid, userId, projectId)
      if (previous ? data.expectedUpdatedAt !== previous.updatedAt : data.expectedUpdatedAt !== null) {
        throw new HttpError(409, 'List view settings changed; reload before saving')
      }
      const updatedAt = previous ? nextItemUpdatedAt(previous.updatedAt) : now()
      const values = {
        columnOrder: JSON.stringify(data.columnOrder), hiddenColumns: JSON.stringify(data.hiddenColumns),
        sort: data.sort === null ? null : JSON.stringify(data.sort), updatedAt,
      }
      let resourceId: string
      if (previous) {
        resourceId = previous.id
        const updated = await db.run('UPDATE list_view_settings SET columnOrder=@columnOrder,hiddenColumns=@hiddenColumns,sort=@sort,updatedAt=@updatedAt WHERE id=@id AND updatedAt=@expectedUpdatedAt',
          { ...values, id: previous.id, expectedUpdatedAt: data.expectedUpdatedAt })
        if (!updated.changes) throw new HttpError(409, 'List view settings changed; reload before saving')
      } else {
        resourceId = randomUUID()
        await db.run(`INSERT INTO list_view_settings(id,workspaceId,userId,view,projectId,columnOrder,hiddenColumns,sort,updatedAt)
          VALUES (@id,@workspaceId,@userId,'list',@projectId,@columnOrder,@hiddenColumns,@sort,@updatedAt)`,
          { id: resourceId, workspaceId: wid, userId, projectId, ...values })
      }
      await audit(userId, wid, 'list.view.settings.update', resourceId, {
        projectScoped: projectId !== null, columns: data.columnOrder.length, hidden: data.hiddenColumns.length, sorted: data.sort !== null,
      })
      return decodeListViewSettings((await listViewSettingsRow(wid, userId, projectId))!)
    })
  },
  async getListStatuses(userId: string, wid: string, listId: string): Promise<ListStatusConfiguration> {
    await requireTaskStructureRead(userId, wid)
    return listStatusConfiguration(wid, id.parse(listId))
  },
  async updateListStatuses(userId: string, wid: string, listId: string, input: unknown): Promise<ListStatusConfiguration> {
    const data = z.object({
      statuses: statusesSchema.nullable(),
      expectedUpdatedAt: z.string().max(64).datetime({ offset: true }).optional(),
      expectedProjectUpdatedAt: z.string().max(64).datetime({ offset: true }).optional(),
    }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      const target = id.parse(listId)
      const previous = await listStatusConfiguration(wid, target)
      const projectId = await nodeProject(wid, target)
      if (data.expectedUpdatedAt !== undefined && data.expectedUpdatedAt !== previous.updatedAt) throw new HttpError(409, 'List statuses changed; reload before saving')
      if (projectId === null && data.statuses === null) throw new HttpError(400, 'Standalone lists must define their own statuses')
      if (previous.statuses === undefined && data.statuses !== null) {
        if (data.expectedProjectUpdatedAt === undefined) throw new HttpError(400, 'Project status revision is required when enabling a list override')
        if (data.expectedProjectUpdatedAt !== previous.inheritedProjectUpdatedAt) throw new HttpError(409, 'Project statuses changed; reload before enabling the list override')
      }
      const effective = data.statuses ?? (await projectConfiguration(wid, projectId!)).statuses
      await assertListTasksStatuses(wid, target, effective)
      const updated = await db.run(`UPDATE list_status_configs SET statuses=?,updatedAt=? WHERE workspaceId=? AND listId=?
        ${data.expectedUpdatedAt === undefined ? '' : 'AND updatedAt=?'}`, data.statuses === null ? null : JSON.stringify(data.statuses),
        nextItemUpdatedAt(previous.updatedAt), wid, target, ...(data.expectedUpdatedAt === undefined ? [] : [data.expectedUpdatedAt]))
      if (!updated.changes) throw new HttpError(409, 'List statuses changed; reload before saving')
      await audit(userId, wid, 'list.statuses.update', target, { override: data.statuses !== null })
      return listStatusConfiguration(wid, target)
    })
  },
  async getListTagColors(userId: string, wid: string, listId: string): Promise<ListTagColorConfiguration> {
    await requireTaskStructureRead(userId, wid)
    return listTagColorConfiguration(wid, id.parse(listId))
  },
  async updateListTagColors(userId: string, wid: string, listId: string, input: unknown): Promise<ListTagColorConfiguration> {
    const data = z.object({ colors: tagColorsSchema, expectedUpdatedAt: timestamp }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      const target = id.parse(listId)
      const previous = await listTagColorConfiguration(wid, target)
      if (data.expectedUpdatedAt !== previous.updatedAt) throw new HttpError(409, 'List tag colors changed; reload before saving')
      const colors = Object.fromEntries(Object.entries(data.colors).map(([tag, color]) => [tag.trim(), color.toLowerCase()]))
      if (Object.keys(colors).length !== Object.keys(data.colors).length) throw new HttpError(400, 'Duplicate tag names after trimming')
      const updated = await db.run('UPDATE list_tag_color_configs SET colors=?,updatedAt=? WHERE workspaceId=? AND listId=? AND updatedAt=?',
        JSON.stringify(colors), nextItemUpdatedAt(previous.updatedAt), wid, target, data.expectedUpdatedAt)
      if (!updated.changes) throw new HttpError(409, 'List tag colors changed; reload before saving')
      await audit(userId, wid, 'list.tag-colors.update', target, { colors: Object.keys(colors).length })
      return listTagColorConfiguration(wid, target)
    })
  },
  async getProjectFields(userId: string, wid: string, projectId: string): Promise<ProjectFieldConfiguration> {
    await requireTaskStructureRead(userId, wid)
    return projectConfiguration(wid, id.parse(projectId))
  },
  async updateProjectFields(userId: string, wid: string, projectId: string, input: unknown): Promise<ProjectFieldConfiguration> {
    const data = z.object({
      fieldIds: z.array(id).max(100).refine((values) => new Set(values).size === values.length, 'Duplicate field IDs').optional(),
      builtInFields: z.array(builtInField).max(7).refine((values) => new Set(values).size === values.length, 'Duplicate built-in fields').optional(),
      statuses: statusesSchema.optional(), dateFormat: dateFormat.nullable().optional(),
      expectedUpdatedAt: z.string().max(64).datetime({ offset: true }).optional(),
    }).strict().refine((value) => value.fieldIds !== undefined || value.builtInFields !== undefined || value.statuses !== undefined || value.dateFormat !== undefined, 'Provide fields to update').parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      const previous = await projectConfiguration(wid, id.parse(projectId))
      const target = await nodeInWorkspace(wid, projectId)
      if (data.expectedUpdatedAt !== undefined && data.expectedUpdatedAt !== previous.updatedAt) throw new HttpError(409, 'Field configuration changed; reload before saving')
      if (data.statuses !== undefined && target.kind !== 'project') throw new HttpError(400, 'Standalone list statuses use the list status configuration')
      if (data.statuses !== undefined) await assertInheritedSubtreeStatuses(wid, projectId, data.statuses)
      if (data.fieldIds !== undefined) {
        for (const fieldId of data.fieldIds) if (!await db.get('SELECT id FROM fields WHERE workspaceId=? AND id=?', wid, fieldId)) throw new HttpError(400, 'Unknown custom field')
        await db.run('DELETE FROM project_field_assignments WHERE workspaceId=? AND projectId=?', wid, projectId)
        for (const [position, fieldId] of data.fieldIds.entries()) {
          await db.run('INSERT INTO project_field_assignments(workspaceId,projectId,fieldId,position) VALUES (?,?,?,?)', wid, projectId, fieldId, position)
        }
      }
      const nextDateFormat = Object.hasOwn(data, 'dateFormat') ? data.dateFormat : previous.dateFormat ?? null
      const updated = await db.run(`UPDATE project_field_configs SET builtInFields=?,statuses=?,dateFormat=?,updatedAt=? WHERE workspaceId=? AND projectId=?
        ${data.expectedUpdatedAt === undefined ? '' : 'AND updatedAt=?'}`, JSON.stringify(data.builtInFields ?? previous.builtInFields),
        JSON.stringify(data.statuses ?? previous.statuses), nextDateFormat, nextItemUpdatedAt(previous.updatedAt), wid, projectId,
        ...(data.expectedUpdatedAt === undefined ? [] : [data.expectedUpdatedAt]))
      if (!updated.changes) throw new HttpError(409, 'Field configuration changed; reload before saving')
      await reconcileListViewSettings(wid, projectId)
      await audit(userId, wid, 'project.fields.update', projectId, { fields: Object.keys(data).filter((key) => key !== 'expectedUpdatedAt') })
      return projectConfiguration(wid, projectId)
    })
  },
  async createField(userId: string, wid: string, input: unknown) {
    const { projectId, ...data } = fieldSchema.extend({ projectId: id.optional() }).parse(input)
    validateField(data)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      if ((await db.get<{ count: number }>('SELECT count(*) AS count FROM fields WHERE workspaceId=?', wid))!.count >= 100) throw new HttpError(400, 'Maximum 100 fields per workspace')
      const field = { id: randomUUID(), workspaceId: wid, ...data }
      await db.run('INSERT INTO fields (id,workspaceId,name,type,options,settings) VALUES (@id,@workspaceId,@name,@type,@options,@settings)', { ...field, options: JSON.stringify(field.options), settings: JSON.stringify(field.settings ?? {}) })
      if (field.type === 'formula' && field.settings?.formula !== undefined) await validateFormulaReferences(wid, field.settings.formula, field.id)
      if (projectId !== undefined) {
        const config = await projectConfiguration(wid, projectId)
        await service.updateProjectFields(userId, wid, projectId, { fieldIds: [...config.fieldIds, field.id], expectedUpdatedAt: config.updatedAt })
      }
      await audit(userId, wid, 'field.create', field.id)
      await emitEvent({ event: 'field.changed', workspaceId: wid, fieldId: field.id, actorId: userId, changes: { action: { after: 'created' } } })
      return field
    })
  },
  async updateField(userId: string, wid: string, fieldId: string, input: unknown): Promise<FieldDefinition> {
    const data = fieldSchema.omit({ type: true }).partial().refine((value) => Object.keys(value).length > 0, 'Provide field settings to update').parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      const row = await db.get<FieldRow>('SELECT * FROM fields WHERE workspaceId=? AND id=?', wid, id.parse(fieldId))
      if (!row) throw new HttpError(404, 'Field not found')
      const field = { ...decodeField(row), ...data }
      validateField(field)
      if (field.type === 'formula' && field.settings?.formula !== undefined) await validateFormulaReferences(wid, field.settings.formula, field.id)
      const checkValues = data.options !== undefined || data.settings !== undefined
        const formulaRows = field.name === row.name ? [] : await db.all<{ id: string; settings: string }>("SELECT id,settings FROM fields WHERE workspaceId=? AND type='formula'", wid)
        const formulaIds = formulaRows.map((formula) => formula.id)
        if (formulaRows.some((formula) => {
          const configured = (JSON.parse(formula.settings) as { formula?: string }).formula
          return configured !== undefined && formulaReferences(configured).includes(row.name)
        })) throw new HttpError(409, 'Update configured formulas referencing this field before renaming it')
      if (checkValues || formulaIds.length) {
        // Check one stored map at a time, including values on unassigned projects.
        let cursor = { createdAt: '', id: '' }
        while (true) {
          const item = await db.get<Pick<ItemRow, 'id' | 'createdAt' | 'customFields'>>(`SELECT id,createdAt,customFields FROM items
            WHERE workspaceId=? AND (createdAt > ? OR (createdAt = ? AND id > ?)) ORDER BY createdAt,id LIMIT 1`, wid, cursor.createdAt, cursor.createdAt, cursor.id)
          if (!item) break
          cursor = item
          const values = JSON.parse(item.customFields) as Item['customFields']
          if (checkValues && Object.hasOwn(values, fieldId) && !validFieldValue(field, values[fieldId])) throw new HttpError(409, 'Field settings would invalidate existing task values')
          for (const formulaId of formulaIds) {
            const expression = values[formulaId]
            if (typeof expression === 'string' && formulaReferences(expression).includes(row.name)) throw new HttpError(409, 'Update stored formulas referencing this field before renaming it')
          }
        }
      }
      await db.run('UPDATE fields SET name=?,options=?,settings=? WHERE workspaceId=? AND id=?', field.name, JSON.stringify(field.options), JSON.stringify(field.settings ?? {}), wid, fieldId)
      await audit(userId, wid, 'field.update', fieldId, { fields: Object.keys(data) })
      await emitEvent({ event: 'field.changed', workspaceId: wid, fieldId, actorId: userId, changes: { action: { after: 'updated' } } })
      return decodeField((await db.get<FieldRow>('SELECT * FROM fields WHERE workspaceId=? AND id=?', wid, fieldId))!)
    })
  },
  async deleteField(userId: string, wid: string, fieldId: string) {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'structure:write')
      const target = await db.get<{ id: string; name: string }>('SELECT id,name FROM fields WHERE workspaceId=? AND id=?', wid, fieldId)
      if (!target) throw new HttpError(404, 'Field not found')
      const configuredFormulas = await db.all<{ id: string; settings: string }>("SELECT id,settings FROM fields WHERE workspaceId=? AND id<>? AND type='formula'", wid, fieldId)
      if (configuredFormulas.some((formula) => {
        const expression = (JSON.parse(formula.settings) as { formula?: string }).formula
        return expression !== undefined && formulaReferences(expression).includes(target.name)
      })) throw new HttpError(409, 'Update configured formulas referencing this field before deleting it')
      // Read one stored value at a time; advance even when a row is untouched.
      let cursor: { createdAt: string; id: string } | undefined
      let touched = 0
      while (true) {
        const createdAt = cursor?.createdAt ?? ''
        const row = await db.get<Pick<ItemRow, 'id' | 'createdAt' | 'updatedAt' | 'customFields'>>(`SELECT id,createdAt,updatedAt,customFields FROM items WHERE workspaceId=?
          AND (createdAt > ? OR (createdAt = ? AND id > ?)) ORDER BY createdAt,id LIMIT 1`, wid, createdAt, createdAt, cursor?.id ?? '')
        if (!row) break
        cursor = { createdAt: row.createdAt, id: row.id }
        const fields = JSON.parse(row.customFields) as Item['customFields']
        if (!Object.hasOwn(fields, fieldId)) continue
        delete fields[fieldId]
        const updatedAt = nextItemUpdatedAt(row.updatedAt)
        await db.run('UPDATE items SET customFields=?,updatedAt=? WHERE workspaceId=? AND id=?', JSON.stringify(fields), updatedAt, wid, row.id)
        touched++
      }
      let projectCursor = ''
      while (true) {
        const config = await db.get<{ projectId: string; updatedAt: string }>(`SELECT c.projectId,c.updatedAt FROM project_field_configs c JOIN project_field_assignments a
          ON a.workspaceId=c.workspaceId AND a.projectId=c.projectId WHERE a.workspaceId=? AND a.fieldId=? AND c.projectId>? ORDER BY c.projectId LIMIT 1`, wid, fieldId, projectCursor)
        if (!config) break
        await db.run('UPDATE project_field_configs SET updatedAt=? WHERE workspaceId=? AND projectId=?', nextItemUpdatedAt(config.updatedAt), wid, config.projectId)
        projectCursor = config.projectId
      }
      await db.run('DELETE FROM fields WHERE workspaceId=? AND id=?', wid, fieldId)
      await reconcileListViewSettings(wid)
      await audit(userId, wid, 'field.delete', fieldId, { touched })
      await emitEvent({ event: 'field.changed', workspaceId: wid, fieldId, actorId: userId, changes: { action: { after: 'deleted' } } })
      return { success: true }
    })
  },
  async listMembers(userId: string, wid: string) {
    const member = await requireMembership(userId, wid)
    if (!member.permissions.some((permission) => permission === 'items:read' || permission === 'members:manage')) throw new HttpError(403, 'Membership directory access denied')
    return (await db.all<Record<string, unknown>>(`SELECT u.id,u.id AS userId,u.name,u.email,u.disabled,m.roleId,r.name AS roleName,r.isOwner FROM memberships m
      JOIN users u ON u.id=m.userId JOIN roles r ON r.id=m.roleId WHERE m.workspaceId=? ORDER BY u.name,u.id`, wid))
      .map((row) => ({ ...row, disabled: Boolean(row.disabled), isOwner: Boolean(row.isOwner) }))
  },
  async addMember(userId: string, wid: string, input: unknown) {
    const data = z.object({ email: emailSchema, roleId: id }).strict().parse(input)
    return db.transaction(async () => {
      const actor = await requirePermission(userId, wid, 'members:manage')
      assertCanGrant(actor, decodeRole(await roleInWorkspace(wid, data.roleId)))
      const target = await db.get<{ id: string }>('SELECT id FROM users WHERE email=? AND disabled=0', data.email)
      if (!target) throw new HttpError(404, 'Active user not found')
      await db.run('INSERT INTO memberships (workspaceId,userId,roleId) VALUES (?,?,?)', wid, target.id, data.roleId)
      await audit(userId, wid, 'member.add', target.id, { roleId: data.roleId })
      return { userId: target.id, workspaceId: wid, roleId: data.roleId }
    })
  },
  async updateMember(userId: string, wid: string, targetId: string, input: unknown) {
    const data = z.object({ roleId: id }).strict().parse(input)
    return db.transaction(async () => {
      const actor = await requirePermission(userId, wid, 'members:manage')
      const target = await memberForChange(actor, wid, targetId)
      const role = decodeRole(await roleInWorkspace(wid, data.roleId))
      assertCanGrant(actor, role)
      if (target.isOwner && !target.userDisabled && !role.isOwner) await protectLastOwner(wid)
      await db.run('UPDATE memberships SET roleId=? WHERE workspaceId=? AND userId=?', data.roleId, wid, targetId)
      await audit(userId, wid, 'member.update', targetId, { roleId: data.roleId })
      return { userId: targetId, workspaceId: wid, roleId: data.roleId }
    })
  },
  async deleteMember(userId: string, wid: string, targetId: string) {
    return db.transaction(async () => {
      const actor = await requirePermission(userId, wid, 'members:manage')
      const target = await memberForChange(actor, wid, targetId)
      if (target.isOwner && !target.userDisabled) await protectLastOwner(wid)
      for (const item of await db.all<{ id: string; updatedAt: string }>('SELECT id,updatedAt FROM items WHERE workspaceId=? AND assigneeId=?', wid, targetId)) {
        await db.run('UPDATE items SET assigneeId=NULL,updatedAt=? WHERE workspaceId=? AND id=?', nextItemUpdatedAt(item.updatedAt), wid, item.id)
      }
      await db.run('DELETE FROM memberships WHERE workspaceId=? AND userId=?', wid, targetId)
      await audit(userId, wid, 'member.delete', targetId)
      return { success: true }
    })
  },
  async listRoles(userId: string, wid: string) {
    const member = await requireMembership(userId, wid)
    if (!member.permissions.some((permission) => permission === 'items:read' || permission === 'roles:manage' || permission === 'members:manage')) return [decodeRole(await roleInWorkspace(wid, member.roleId))]
    return (await db.all<RoleRow>('SELECT * FROM roles WHERE workspaceId=? ORDER BY isOwner DESC,name,id', wid)).map(decodeRole)
  },
  async createRole(userId: string, wid: string, input: unknown) {
    const data = roleSchema.parse(input)
    return db.transaction(async () => {
      const actor = await requirePermission(userId, wid, 'roles:manage')
      assertCanGrant(actor, data)
      const role = { id: randomUUID(), workspaceId: wid, ...data, isOwner: false }
      await db.run('INSERT INTO roles (id,workspaceId,name,permissions,isOwner) VALUES (?,?,?,?,0)', role.id, wid, role.name, JSON.stringify(role.permissions))
      await audit(userId, wid, 'role.create', role.id, { permissions: role.permissions })
      return role
    })
  },
  async updateRole(userId: string, wid: string, roleId: string, input: unknown) {
    const data = roleSchema.partial().parse(input)
    return db.transaction(async () => {
      const actor = await requirePermission(userId, wid, 'roles:manage')
      const previous = decodeRole(await roleInWorkspace(wid, roleId))
      if (previous.isOwner) throw new HttpError(403, 'Owner role is protected')
      assertCanGrant(actor, previous)
      const role = { ...previous, ...data }
      assertCanGrant(actor, role)
      await db.run('UPDATE roles SET name=?,permissions=? WHERE workspaceId=? AND id=?', role.name, JSON.stringify(role.permissions), wid, roleId)
      await audit(userId, wid, 'role.update', roleId, { permissions: role.permissions })
      return role
    })
  },
  async deleteRole(userId: string, wid: string, roleId: string) {
    return db.transaction(async () => {
      const actor = await requirePermission(userId, wid, 'roles:manage')
      const role = decodeRole(await roleInWorkspace(wid, roleId))
      if (role.isOwner) throw new HttpError(403, 'Owner role is protected')
      assertCanGrant(actor, role)
      if (await db.get('SELECT userId FROM memberships WHERE workspaceId=? AND roleId=? LIMIT 1', wid, roleId)) throw new HttpError(409, 'Role is assigned to members')
      await db.run('DELETE FROM roles WHERE workspaceId=? AND id=?', wid, roleId)
      await audit(userId, wid, 'role.delete', roleId)
      return { success: true }
    })
  },
  async exportWorkspace(userId: string, wid: string) {
    return db.transaction(async () => {
      const member = await requirePermission(userId, wid, 'items:read')
      const canReadDocuments = member.permissions.includes('documents:read')
      return { version: 5, exportedAt: now(), workspace: await db.get('SELECT * FROM workspaces WHERE id=?', wid), nodes: await service.listNodes(userId, wid),
        documents: canReadDocuments ? await db.all('SELECT * FROM documents WHERE workspaceId=? ORDER BY createdAt,id', wid) : [],
        documentPages: canReadDocuments ? await db.all('SELECT documentId,itemId,position,createdAt FROM document_pages WHERE workspaceId=? ORDER BY documentId,position,createdAt,itemId', wid) : [],
        documentSubpages: canReadDocuments ? await db.all('SELECT documentId,pageDocumentId,position,placement,createdAt FROM document_subpages WHERE workspaceId=? ORDER BY documentId,position,createdAt,pageDocumentId', wid) : [],
        items: await service.listItems(userId, wid, { archived: 'include' }), fields: await service.listFields(userId, wid),
        projectFields: await service.listProjectFields(userId, wid),
        listStatusConfigs: await service.listListStatusConfigs(userId, wid),
        listTagColorConfigs: await service.listListTagColorConfigs(userId, wid),
        comments: await db.all('SELECT id,itemId,authorId,body,parentId,createdAt,deletedAt,anchorRevision,anchorStart,anchorEnd,anchorExact,anchorPrefix,anchorSuffix,anchorState FROM comments WHERE workspaceId=? ORDER BY createdAt,id', wid),
        commentReactions: await db.all('SELECT itemId,commentId,userId,emoji,createdAt FROM comment_reactions WHERE workspaceId=? ORDER BY createdAt,commentId,userId,emoji', wid),
        documentComments: canReadDocuments ? await db.all('SELECT id,documentId,authorId,body,parentId,createdAt,deletedAt,anchorRevision,anchorStart,anchorEnd,anchorExact,anchorPrefix,anchorSuffix,anchorState FROM document_comments WHERE workspaceId=? ORDER BY createdAt,id', wid) : [],
        documentCommentReactions: canReadDocuments ? await db.all('SELECT documentId,commentId,userId,emoji,createdAt FROM document_comment_reactions WHERE workspaceId=? ORDER BY createdAt,commentId,userId,emoji', wid) : [],
        attachments: await db.all('SELECT id,itemId,name,size,contentType,createdAt FROM attachments WHERE workspaceId=? ORDER BY createdAt,id', wid) }
    })
  },
}

async function memberForChange(actor: Membership, wid: string, targetId: string) {
  const target = await db.get<RoleRow & { userDisabled: number }>('SELECT r.*,u.disabled AS userDisabled FROM memberships m JOIN roles r ON r.id=m.roleId JOIN users u ON u.id=m.userId WHERE m.workspaceId=? AND m.userId=?', wid, targetId)
  if (!target) throw new HttpError(404, 'Member not found')
  const role = decodeRole(target)
  assertCanGrant(actor, role)
  return { ...role, userDisabled: Boolean(target.userDisabled) }
}
export async function protectLastOwner(wid: string): Promise<void> {
  const { count } = (await db.get<{ count: number }>(`SELECT count(*) AS count FROM memberships m JOIN roles r ON r.id=m.roleId
    JOIN users u ON u.id=m.userId WHERE m.workspaceId=? AND r.isOwner=1 AND u.disabled=0`, wid))!
  if (count <= 1) throw new HttpError(409, 'Workspace must retain an active owner')
}
