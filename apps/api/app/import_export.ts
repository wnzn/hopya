import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { HttpContext } from '@adonisjs/core/http'
import { audit, db } from './database.js'
import { authenticate } from './security.js'
import { HttpError, type Item } from './types.js'
import {
  dateSchema, decodeField, effectiveListStatuses, requirePermission,
  validFieldValue, validateFormulaReferences,
  type FieldDefinition, type ProjectFieldConfiguration,
} from './service.js'
import { decodeItem, itemColumns, statusId, type ItemRow } from './task_reads.js'

export const MAX_IMPORT_ROWS = 500
export const MAX_IMPORT_CHARS = 1_000_000
export const MAX_EXPORT_CUSTOM_COLUMNS = 50
const DEFAULT_EXPORT_LIMIT = 1000
const MAX_EXPORT_LIMIT = 5000
const priorities = ['none', 'low', 'medium', 'high', 'urgent'] as const
type Priority = typeof priorities[number]
type StatusEntry = ProjectFieldConfiguration['statuses'][number]

const importBody = z.object({
  nodeId: z.string().uuid(),
  format: z.enum(['json', 'csv']),
  data: z.string().max(MAX_IMPORT_CHARS),
}).strict()

const exportQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
  nodeId: z.string().uuid().optional(),
  status: statusId.optional(),
  search: z.string().max(300).optional(),
  limit: z.union([z.number().int(), z.string().regex(/^[1-9]\d{0,3}$/).transform(Number)])
    .pipe(z.number().int().min(1).max(MAX_EXPORT_LIMIT)).default(DEFAULT_EXPORT_LIMIT),
}).strict()

// Same normalization as items: CRLF/CR become LF and C0 controls are stripped.
function normalizeDescription(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
}

// --- RFC-4180 subset CSV parser (quoted fields, "" escapes, commas, CRLF/LF) ---
export function parseCsv(data: string): string[][] {
  if (data.startsWith('\uFEFF')) data = data.slice(1)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let fieldQuoted = false
  let pos = 0
  while (pos < data.length) {
    const ch = data[pos]!
    if (inQuotes) {
      if (ch === '"') {
        if (data[pos + 1] === '"') { field += '"'; pos += 2 }
        else { inQuotes = false; pos++ }
      } else { field += ch; pos++ }
    } else if (ch === '"' && field === '' && !fieldQuoted) {
      inQuotes = true; fieldQuoted = true; pos++
    } else if (ch === ',') {
      row.push(field); field = ''; fieldQuoted = false; pos++
    } else if (ch === '\r' || ch === '\n') {
      row.push(field); field = ''; fieldQuoted = false
      rows.push(row); row = []
      pos += ch === '\r' && data[pos + 1] === '\n' ? 2 : 1
    } else if (ch === '"') {
      // Lenient mid-field quote; strictness is enforced by validation downstream.
      field += ch; pos++
    } else { field += ch; pos++ }
  }
  if (inQuotes) throw new HttpError(400, 'Invalid CSV: unterminated quoted field')
  if (row.length > 0 || field !== '' || fieldQuoted) { row.push(field); rows.push(row) }
  return rows
}

export function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// --- Import ---

type RawRow = Record<string, unknown>

interface NormalizedRow {
  title: string
  description: string
  status: string
  priority: Priority
  startDate: string | null
  dueDate: string | null
  tags: string[]
  assigneeId: string | null
  customFields: Item['customFields']
}

const rowError = (n: number, reason: string): HttpError => new HttpError(400, `Row ${n}: ${reason}`)

function rowsFromJson(data: string): RawRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new HttpError(400, 'Invalid JSON: request data must be an array of row objects')
  }
  if (!Array.isArray(parsed)) throw new HttpError(400, 'Invalid JSON: request data must be an array of row objects')
  for (let index = 0; index < parsed.length; index++) {
    const row = parsed[index]
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw rowError(index + 1, 'row must be an object')
  }
  return parsed as RawRow[]
}

const IGNORED_COLUMNS = new Set(['id', 'nodeId', 'nodePath', 'createdAt', 'updatedAt'])
const KNOWN_COLUMNS = new Set(['title', 'description', 'status', 'priority', 'startDate', 'dueDate', 'tags', 'assignee', 'assigneeEmail', 'customFields'])

function rowsFromCsv(data: string): RawRow[] {
  const table = parseCsv(data)
  if (table.length === 0) throw new HttpError(400, 'Invalid CSV: missing header row')
  const header = table[0]!.map((name) => name.trim())
  if (!header.includes('title')) throw new HttpError(400, 'Invalid CSV: header must contain a title column')
  const seen = new Set<string>()
  for (const name of header) {
    if (seen.has(name)) throw new HttpError(400, `Invalid CSV: duplicate column '${name}'`)
    seen.add(name)
  }
  // Drop trailing blank lines; a blank line in the middle fails title validation.
  let end = table.length
  while (end > 1 && table[end - 1]!.every((cell) => cell.trim() === '')) end--
  return table.slice(1, end).map((cells, index) => {
    const n = index + 1
    if (cells.length > header.length) throw rowError(n, `too many columns (expected ${header.length})`)
    const row: RawRow = {}
    header.forEach((name, position) => { row[name] = cells[position] ?? '' })
    return row
  })
}

function checkColumns(row: RawRow, n: number, allowCustomFieldsObject: boolean): void {
  for (const key of Object.keys(row)) {
    if (IGNORED_COLUMNS.has(key) || KNOWN_COLUMNS.has(key) || key.startsWith('custom:')) continue
    throw rowError(n, `unknown column '${key}'`)
  }
  if (!allowCustomFieldsObject && row.customFields !== undefined) {
    throw rowError(n, 'customFields object is only supported for JSON imports')
  }
}

function parseTags(value: unknown, n: number): string[] {
  const parts = typeof value === 'string' ? value.split(';') : value
  if (!Array.isArray(parts)) throw rowError(n, 'tags must be a semicolon-separated string or an array')
  const tags: string[] = []
  for (const part of parts) {
    if (typeof part !== 'string') throw rowError(n, 'tags must be a semicolon-separated string or an array')
    const tag = part.trim()
    if (tag === '') continue
    if (tag.length > 60) throw rowError(n, `tag '${tag.slice(0, 20)}' exceeds 60 characters`)
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > 30) throw rowError(n, 'too many tags (maximum 30)')
  return tags
}

function coerceCustomValue(field: FieldDefinition, value: unknown, n: number, fromCsv: boolean): string | number | boolean | string[] | null {
  let coerced: unknown = value
  if (coerced === undefined) return null
  if (fromCsv) {
    if (typeof coerced !== 'string') throw rowError(n, `invalid value for custom field '${field.name}'`)
    if (coerced.trim() === '') return null
    switch (field.type) {
      case 'number': {
        const numeric = Number(coerced)
        if (!Number.isFinite(numeric)) throw rowError(n, `invalid number for custom field '${field.name}'`)
        coerced = numeric
        break
      }
      case 'checkbox': {
        const literal = coerced.trim().toLowerCase()
        if (['true', 'yes', '1'].includes(literal)) coerced = true
        else if (['false', 'no', '0'].includes(literal)) coerced = false
        else throw rowError(n, `invalid checkbox value for custom field '${field.name}'`)
        break
      }
      case 'rating': {
        const numeric = Number(coerced)
        const max = field.settings?.maxRating ?? 5
        if (!Number.isInteger(numeric) || numeric < 1 || numeric > max) {
          throw rowError(n, `rating for custom field '${field.name}' must be an integer from 1 to ${max}`)
        }
        coerced = numeric
        break
      }
      case 'checklist': {
        coerced = [...new Set(coerced.split(';').map((option: string) => option.trim()).filter((option: string) => option !== ''))]
        break
      }
      default:
        break // text, date, datetime, select and formula pass through as literal strings.
    }
  }
  if (coerced === null) return null
  if (typeof coerced === 'string' && coerced.length > 10000) {
    throw rowError(n, `value for custom field '${field.name}' exceeds 10000 characters`)
  }
  if (Array.isArray(coerced)) {
    if (coerced.length > 100) throw rowError(n, `too many values for custom field '${field.name}'`)
    for (const option of coerced) {
      if (typeof option !== 'string' || option.length < 1 || option.length > 120) {
        throw rowError(n, `invalid value for custom field '${field.name}'`)
      }
    }
  }
  if (!validFieldValue(field, coerced)) throw rowError(n, `invalid value for custom field '${field.name}'`)
  // Formula cross-references resolve against the workspace field list in normalizeRow.
  return coerced as string | number | boolean | string[] | null
}

function normalizeRow(wid: string, row: RawRow, n: number, statuses: StatusEntry[], fields: FieldDefinition[], fromCsv: boolean): NormalizedRow {
  checkColumns(row, n, !fromCsv)

  const rawTitle = row.title
  if (rawTitle === undefined || rawTitle === null || (typeof rawTitle === 'string' && rawTitle.trim() === '')) {
    throw rowError(n, 'title is required')
  }
  if (typeof rawTitle !== 'string') throw rowError(n, 'title must be a string')
  const title = rawTitle.trim()
  if (title.length > 300) throw rowError(n, 'title exceeds 300 characters')

  const rawDescription = row.description ?? ''
  if (typeof rawDescription !== 'string') throw rowError(n, 'description must be a string')
  const description = normalizeDescription(rawDescription)
  if (description.length > 50000) throw rowError(n, 'description exceeds 50000 characters')

  const rawStatus = row.status ?? ''
  if (typeof rawStatus !== 'string') throw rowError(n, 'status must be a string')
  const statusText = rawStatus.trim()
  const status = statusText === ''
    ? statuses[0]!.id
    : (statuses.find((entry) => entry.id === statusText || entry.name === statusText)?.id
      ?? (() => { throw rowError(n, `unknown status '${statusText}'`) })())

  const rawPriority = row.priority ?? 'none'
  const priorityText = typeof rawPriority === 'string' ? rawPriority.trim() : ''
  if (!(priorities as readonly string[]).includes(priorityText)) throw rowError(n, `unknown priority '${String(rawPriority)}'`)
  const priority = priorityText as Priority

  const parseDate = (key: 'startDate' | 'dueDate'): string | null => {
    const raw = row[key] ?? null
    if (raw === null || raw === undefined || raw === '') return null
    if (typeof raw !== 'string' || !dateSchema.safeParse(raw.trim()).success) {
      throw rowError(n, `invalid ${key} '${String(raw)}'`)
    }
    return raw.trim()
  }
  const startDate = parseDate('startDate')
  const dueDate = parseDate('dueDate')
  if (startDate && dueDate && startDate > dueDate) throw rowError(n, 'startDate must not be after dueDate')

  const tags = row.tags === undefined ? [] : parseTags(row.tags, n)

  const rawAssignee = row.assignee ?? row.assigneeEmail ?? null
  let assigneeId: string | null = null
  if (rawAssignee !== null && rawAssignee !== undefined && String(rawAssignee).trim() !== '') {
    if (typeof rawAssignee !== 'string') throw rowError(n, 'assignee must be an email address')
    const email = rawAssignee.trim()
    const member = db.prepare(`SELECT u.id FROM users u JOIN memberships m ON m.userId=u.id
      WHERE m.workspaceId=? AND lower(u.email)=lower(?) AND u.disabled=0`).get(wid, email) as { id: string } | undefined
    if (!member) throw rowError(n, `assignee '${email}' is not an active workspace member`)
    assigneeId = member.id
  }

  const customFields: Item['customFields'] = {}
  const assignCustom = (field: FieldDefinition, value: unknown): void => {
    if (Object.hasOwn(customFields, field.id)) throw rowError(n, `duplicate value for custom field '${field.name}'`)
    customFields[field.id] = coerceCustomValue(field, value, n, fromCsv)
  }
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith('custom:')) continue
    const name = key.slice('custom:'.length)
    const field = fields.find((entry) => entry.name === name)
    if (!field) throw rowError(n, `unknown custom field '${name}'`)
    assignCustom(field, value)
  }
  if (row.customFields !== undefined) {
    const customObject = row.customFields
    if (!customObject || typeof customObject !== 'object' || Array.isArray(customObject)) {
      throw rowError(n, 'customFields must be an object')
    }
    for (const [key, value] of Object.entries(customObject)) {
      const field = fields.find((entry) => entry.id === key) ?? fields.find((entry) => entry.name === key)
      if (!field) throw rowError(n, `unknown custom field '${key}'`)
      assignCustom(field, value)
    }
  }
  // Formula references must resolve against workspace fields; surface with the row number.
  for (const field of fields) {
    const value = customFields[field.id]
    if (field.type === 'formula' && typeof value === 'string') {
      try {
        validateFormulaReferences(wid, value, field.id)
      } catch (error) {
        if (error instanceof HttpError) throw rowError(n, error.message)
        throw error
      }
    }
  }

  return { title, description, status, priority, startDate, dueDate, tags, assigneeId, customFields }
}

export function importItems(userId: string, wid: string, input: unknown): { imported: number; ids: string[] } {
  const body = importBody.parse(input)
  return db.transaction(() => {
    requirePermission(userId, wid, 'items:write')
    const node = db.prepare('SELECT id,kind FROM nodes WHERE workspaceId=? AND id=?').get(wid, body.nodeId) as { id: string; kind: string } | undefined
    if (!node) throw new HttpError(404, 'Node not found')
    if (node.kind !== 'list') throw new HttpError(400, 'Import target must be a list')
    const statuses = effectiveListStatuses(wid, body.nodeId)
    const fields = (db.prepare('SELECT * FROM fields WHERE workspaceId=?').all(wid) as Parameters<typeof decodeField>[0][]).map(decodeField)
    const rows = body.format === 'json' ? rowsFromJson(body.data) : rowsFromCsv(body.data)
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new HttpError(400, `Import row limit exceeded: maximum ${MAX_IMPORT_ROWS} rows per import`)
    }
    const fromCsv = body.format === 'csv'
    // Validate every row before inserting any, so a single bad row aborts the import.
    const normalized = rows.map((row, index) => normalizeRow(wid, row, index + 1, statuses, fields, fromCsv))
    const timestamp = new Date().toISOString()
    const insert = db.prepare(`INSERT INTO items
      (id,workspaceId,nodeId,title,description,status,priority,startDate,dueDate,tags,customFields,assigneeId,createdAt,updatedAt)
      VALUES (@id,@workspaceId,@nodeId,@title,@description,@status,@priority,@startDate,@dueDate,@tags,@customFields,@assigneeId,@createdAt,@updatedAt)`)
    const ids: string[] = []
    for (const item of normalized) {
      const id = randomUUID()
      insert.run({
        id, workspaceId: wid, nodeId: body.nodeId, title: item.title, description: item.description,
        status: item.status, priority: item.priority, startDate: item.startDate, dueDate: item.dueDate,
        tags: JSON.stringify(item.tags), customFields: JSON.stringify(item.customFields),
        assigneeId: item.assigneeId, createdAt: timestamp, updatedAt: timestamp,
      })
      ids.push(id)
    }
    audit(userId, wid, 'item.import', body.nodeId, { imported: normalized.length, format: body.format })
    return { imported: normalized.length, ids }
  })()
}

// --- Export ---

const EXPORT_COLUMNS = ['id', 'title', 'description', 'status', 'priority', 'startDate', 'dueDate', 'tags', 'assigneeEmail', 'nodeId', 'nodePath', 'createdAt', 'updatedAt'] as const

function customCell(value: Item['customFields'][string]): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(';')
  return String(value)
}

export function exportItems(userId: string, wid: string, query: unknown): { body: unknown; contentType: string; filename: string } {
  const filters = exportQuery.parse(query)
  requirePermission(userId, wid, 'items:read')
  const clauses = ['workspaceId=?', 'archivedAt IS NULL']
  const values: string[] = [wid]
  if (filters.nodeId) {
    const node = db.prepare('SELECT id,kind FROM nodes WHERE workspaceId=? AND id=?').get(wid, filters.nodeId) as { id: string; kind: string } | undefined
    if (!node) throw new HttpError(404, 'Node not found')
    const ids = node.kind === 'list' ? [node.id]
      : (db.prepare(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM nodes WHERE workspaceId=? AND id=?
          UNION SELECT n.id FROM nodes n JOIN descendants d ON n.parentId=d.id WHERE n.workspaceId=?
        ) SELECT n.id AS id FROM nodes n JOIN descendants d ON n.id=d.id WHERE n.workspaceId=? AND n.kind='list'`)
        .all(wid, node.id, wid, wid) as { id: string }[]).map((entry) => entry.id)
    if (ids.length === 0) {
      return filters.format === 'csv'
        ? { body: `${EXPORT_COLUMNS.join(',')}\n`, contentType: 'text/csv', filename: `hopya-export-${wid.slice(0, 8)}.csv` }
        : { body: [], contentType: 'application/json', filename: `hopya-export-${wid.slice(0, 8)}.json` }
    }
    clauses.push(`nodeId IN (${ids.map(() => '?').join(',')})`)
    values.push(...ids)
  }
  if (filters.status) { clauses.push('status=?'); values.push(filters.status) }
  if (filters.search) {
    clauses.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')")
    const pattern = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`
    values.push(pattern, pattern)
  }
  const rows = db.prepare(`SELECT ${itemColumns} FROM items WHERE ${clauses.join(' AND ')} ORDER BY createdAt,id LIMIT ?`)
    .all(...values, filters.limit) as ItemRow[]
  const items = rows.map(decodeItem)
  const filename = `hopya-export-${wid.slice(0, 8)}.${filters.format}`
  if (filters.format === 'json') {
    return { body: items, contentType: 'application/json', filename }
  }
  const assigneeIds = [...new Set(items.map((item) => item.assigneeId).filter((value): value is string => value !== null))]
  const emailById = new Map<string, string>()
  if (assigneeIds.length) {
    for (const user of db.prepare(`SELECT id,email FROM users WHERE id IN (${assigneeIds.map(() => '?').join(',')})`).all(...assigneeIds) as { id: string; email: string }[]) {
      emailById.set(user.id, user.email)
    }
  }
  const nodes = db.prepare('SELECT id,name,parentId FROM nodes WHERE workspaceId=?').all(wid) as { id: string; name: string; parentId: string | null }[]
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const nodePath = (nodeId: string): string => {
    const parts: string[] = []
    let current = nodeById.get(nodeId)
    let depth = 0
    while (current && depth++ < 40) {
      parts.unshift(current.name)
      current = current.parentId ? nodeById.get(current.parentId) : undefined
    }
    return parts.join('/')
  }
  const fields = (db.prepare('SELECT * FROM fields WHERE workspaceId=?').all(wid) as Parameters<typeof decodeField>[0][]).map(decodeField)
  const fieldById = new Map(fields.map((field) => [field.id, field]))
  const union = new Set<string>()
  for (const item of items) {
    for (const fieldId of Object.keys(item.customFields)) {
      if (fieldById.has(fieldId)) union.add(fieldId)
    }
  }
  if (union.size > MAX_EXPORT_CUSTOM_COLUMNS) {
    throw new HttpError(400, `Export custom column limit exceeded: maximum ${MAX_EXPORT_CUSTOM_COLUMNS} custom columns`)
  }
  const customColumns = [...union].map((fieldId) => fieldById.get(fieldId)!).sort((a, b) => a.name.localeCompare(b.name))
  const header = [...EXPORT_COLUMNS, ...customColumns.map((field) => `custom:${field.name}`)]
  const lines = [header.map(csvCell).join(',')]
  for (const item of items) {
    const cells = [
      item.id, item.title, item.description, item.status, item.priority,
      item.startDate ?? '', item.dueDate ?? '', item.tags.join(';'),
      item.assigneeId ? (emailById.get(item.assigneeId) ?? '') : '',
      item.nodeId, nodePath(item.nodeId), item.createdAt, item.updatedAt,
      ...customColumns.map((field) => customCell(item.customFields[field.id])),
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return { body: lines.join('\r\n'), contentType: 'text/csv', filename }
}

export function handleExport(ctx: HttpContext): unknown {
  const result = exportItems(authenticate(ctx).id, ctx.params.wid, ctx.request.qs())
  ctx.response.header('Content-Disposition', `attachment; filename="${result.filename}"`)
  ctx.response.header('Content-Type', result.contentType)
  return result.body
}
