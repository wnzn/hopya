import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit, db } from './database.js'
import { dateSchema, lockWorkspaceHierarchy, nextItemUpdatedAt, requireMembership, requirePermission } from './service.js'
import { PAGE_BYTES } from './task_reads.js'
import { HttpError, type TableColumn, type TableColumnType, type TableMetadata, type TableRecord, type TableValue } from './types.js'
import { sqlTables } from './table_sql.js'
import { nodeIcon, nodeColor } from './appearance.js'

const id = z.string().uuid()
const name = z.string().trim().min(1).max(120)
const timestamp = z.string().max(64).datetime({ offset: true })
const columnType = z.enum(['text', 'number', 'date', 'datetime', 'checkbox', 'select'])
const option = z.string().trim().min(1).max(120)
const options = z.array(option).max(100).default([])
  .refine((values) => new Set(values).size === values.length, 'Column options must be unique')
const datetime = z.string().max(64).datetime({ offset: true })
  .refine((value) => /(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value)), 'Invalid datetime')
const inputValue = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const values = z.record(id, inputValue).refine((data) => Object.keys(data).length <= 100, 'A record cannot contain more than 100 values')
const pageInput = z.object({
  limit: z.union([z.number(), z.string().regex(/^[1-9]\d{0,2}$/).transform(Number)]).pipe(z.number().int().min(1).max(500)).default(200),
  cursor: z.string().min(1).max(1024).optional(),
}).strict()
const cursorSchema = z.object({
  v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime().refine((value) => new Date(value).toISOString() === value), id,
}).strict()
const now = () => new Date().toISOString()

type ColumnRow = Omit<TableColumn, 'options'> & { options: string }
type RecordRow = Omit<TableRecord, 'values'> & { data: string }

export const decodeTableColumn = (row: ColumnRow): TableColumn => ({ ...row, options: JSON.parse(row.options) })
export const decodeTableRecord = ({ data, ...row }: RecordRow): TableRecord => ({ ...row, values: JSON.parse(data) })

async function tableInWorkspace(wid: string, tableId: string): Promise<TableMetadata> {
  const table = await db.get<TableMetadata & Record<string, unknown>>('SELECT id,workspaceId,parentId,name,icon,color,createdAt,updatedAt FROM tables WHERE workspaceId=? AND id=?', wid, id.parse(tableId))
  if (!table) throw new HttpError(404, 'Table not found')
  return table
}

async function columnInTable(wid: string, tableId: string, columnId: string): Promise<TableColumn> {
  const column = await db.get<ColumnRow>('SELECT id,workspaceId,tableId,name,type,options,position,createdAt,updatedAt FROM table_columns WHERE workspaceId=? AND tableId=? AND id=?', wid, tableId, id.parse(columnId))
  if (!column) throw new HttpError(404, 'Table column not found')
  return decodeTableColumn(column)
}

async function recordInTable(wid: string, tableId: string, recordId: string): Promise<TableRecord> {
  const record = await db.get<RecordRow>('SELECT id,workspaceId,tableId,data,createdAt,updatedAt FROM table_records WHERE workspaceId=? AND tableId=? AND id=?', wid, tableId, id.parse(recordId))
  if (!record) throw new HttpError(404, 'Table record not found')
  return decodeTableRecord(record)
}

async function requireTableMetadata(userId: string, wid: string) {
  const member = await requireMembership(userId, wid)
  if (!member.permissions.some((permission) => permission === 'tables:read' || permission === 'tables:write' || permission === 'tables:delete' || permission === 'structure:write')) {
    throw new HttpError(403, 'Table access denied')
  }
}

async function validateParent(wid: string, parentId: string | null) {
  if (parentId === null) return
  const parent = await db.get<{ kind: string; parentId: string | null }>('SELECT kind,parentId FROM nodes WHERE workspaceId=? AND id=?', wid, id.parse(parentId))
  if (!parent) throw new HttpError(404, 'Parent node not found')
  if (parent.kind !== 'project' && parent.kind !== 'folder') throw new HttpError(400, 'Tables may only be placed in projects or folders')
  let current = parent.parentId
  let depth = 1
  while (current !== null) {
    if (++depth >= 32) throw new HttpError(400, 'Maximum hierarchy depth exceeded')
    const ancestor = await db.get<{ parentId: string | null }>('SELECT parentId FROM nodes WHERE workspaceId=? AND id=?', wid, current)
    if (!ancestor) throw new HttpError(400, 'Table parent hierarchy is incomplete')
    current = ancestor.parentId
  }
}

export async function lockTable(wid: string, tableId: string) {
  const parsedId = id.parse(tableId)
  const row = db.dialect === 'pg'
    ? await db.get('SELECT id FROM tables WHERE workspaceId=? AND id=? FOR UPDATE', wid, parsedId)
    : (await db.run('UPDATE tables SET updatedAt=updatedAt WHERE workspaceId=? AND id=?', wid, parsedId)).changes
  if (!row) throw new HttpError(404, 'Table not found')
}

function validateColumnOptions(type: TableColumnType, choices: string[]) {
  if ((type === 'select') !== (choices.length > 0)) throw new HttpError(400, 'Only select columns accept 1 to 100 unique options')
}

export function validTableValue(column: TableColumn, value: TableValue): boolean {
  if (value === null) return true
  return column.type === 'text' ? typeof value === 'string' && value.length <= 10000
    : column.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : column.type === 'checkbox' ? typeof value === 'boolean'
    : column.type === 'date' ? dateSchema.safeParse(value).success
    : column.type === 'datetime' ? datetime.safeParse(value).success
    : typeof value === 'string' && column.options.includes(value)
}

async function encodeValues(wid: string, tableId: string, data: Record<string, TableValue>): Promise<string> {
  const columns = await db.all<ColumnRow>('SELECT id,workspaceId,tableId,name,type,options,position,createdAt,updatedAt FROM table_columns WHERE workspaceId=? AND tableId=?', wid, tableId)
  const byId = new Map(columns.map((column) => [column.id, decodeTableColumn(column)]))
  for (const [columnId, value] of Object.entries(data)) {
    const column = byId.get(columnId)
    if (!column) throw new HttpError(400, 'Unknown table column')
    if (!validTableValue(column, value)) throw new HttpError(400, 'Invalid table record value')
  }
  const encoded = JSON.stringify(data)
  if (Buffer.byteLength(encoded) > 256 * 1024) throw new HttpError(400, 'Table record data exceeds 256 KiB')
  return encoded
}

function cursorScope(wid: string, tableId: string): string {
  return createHash('sha256').update(JSON.stringify([wid, tableId])).digest('hex')
}

function encodeCursor(wid: string, tableId: string, record: Pick<TableRecord, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ v: 1, scope: cursorScope(wid, tableId), createdAt: record.createdAt, id: record.id })).toString('base64url')
}

function decodeCursor(cursor: string, wid: string, tableId: string) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
    const decoded = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    if (decoded.scope !== cursorScope(wid, tableId) || encodeCursor(wid, tableId, decoded) !== cursor) throw new Error()
    return decoded
  } catch {
    throw new HttpError(400, 'Invalid table record cursor')
  }
}

export const tableService = {
  async listTables(userId: string, wid: string): Promise<TableMetadata[]> {
    await requireTableMetadata(userId, wid)
    return db.all<TableMetadata & Record<string, unknown>>('SELECT id,workspaceId,parentId,name,icon,color,createdAt,updatedAt FROM tables WHERE workspaceId=? ORDER BY createdAt,id', wid)
  },

  async getTable(userId: string, wid: string, tableId: string): Promise<TableMetadata> {
    await requirePermission(userId, wid, 'tables:read')
    return tableInWorkspace(wid, tableId)
  },

  async createTable(userId: string, wid: string, input: unknown): Promise<TableMetadata> {
    const data = z.object({ name, parentId: id.nullable().default(null), icon: nodeIcon.nullable().default(null), color: nodeColor.nullable().default(null) }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:write')
      await lockWorkspaceHierarchy(wid)
      await validateParent(wid, data.parentId)
      const createdAt = now()
      const table = { id: randomUUID(), workspaceId: wid, ...data, createdAt, updatedAt: createdAt }
      await db.run('INSERT INTO tables(id,workspaceId,parentId,name,icon,color,createdAt,updatedAt) VALUES (@id,@workspaceId,@parentId,@name,@icon,@color,@createdAt,@updatedAt)', table)
      await audit(userId, wid, 'table.create', table.id, { parentId: table.parentId })
      return table
    })
  },

  async updateTable(userId: string, wid: string, tableId: string, input: unknown): Promise<TableMetadata> {
    const data = z.object({ name: name.optional(), parentId: id.nullable().optional(), icon: nodeIcon.nullable().optional(), color: nodeColor.nullable().optional(), expectedUpdatedAt: timestamp }).strict()
      .refine((value) => value.name !== undefined || value.parentId !== undefined || value.icon !== undefined || value.color !== undefined, 'Provide a field to update').parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:read')
      await requirePermission(userId, wid, 'tables:write')
      await lockWorkspaceHierarchy(wid)
      await lockTable(wid, tableId)
      const previous = await tableInWorkspace(wid, tableId)
      if (previous.updatedAt !== data.expectedUpdatedAt) throw new HttpError(409, 'Table changed; reload before saving')
      const parentId = data.parentId === undefined ? previous.parentId : data.parentId
      await validateParent(wid, parentId)
      const updatedAt = nextItemUpdatedAt(previous.updatedAt)
      const updated = await db.run('UPDATE tables SET name=?,parentId=?,icon=?,color=?,updatedAt=? WHERE workspaceId=? AND id=? AND updatedAt=?', data.name ?? previous.name, parentId,
        data.icon === undefined ? previous.icon : data.icon, data.color === undefined ? previous.color : data.color, updatedAt, wid, tableId, data.expectedUpdatedAt)
      if (!updated.changes) throw new HttpError(409, 'Table changed; reload before saving')
      await audit(userId, wid, 'table.update', tableId, { fields: Object.keys(data).filter((key) => key !== 'expectedUpdatedAt'), previousParentId: previous.parentId, parentId })
      return tableInWorkspace(wid, tableId)
    })
  },

  async deleteTable(userId: string, wid: string, tableId: string) {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:delete')
      await lockWorkspaceHierarchy(wid)
      await lockTable(wid, tableId)
      const counts = (await db.get<{ columns: number | string; records: number | string }>(`SELECT
        (SELECT count(*) FROM table_columns WHERE workspaceId=? AND tableId=?) AS columns,
        (SELECT count(*) FROM table_records WHERE workspaceId=? AND tableId=?) AS records`, wid, tableId, wid, tableId))!
      await db.run('DELETE FROM tables WHERE workspaceId=? AND id=?', wid, tableId)
      await audit(userId, wid, 'table.delete', tableId, { columns: Number(counts.columns), records: Number(counts.records) })
      return { success: true }
    })
  },

  async listColumns(userId: string, wid: string, tableId: string): Promise<TableColumn[]> {
    await requirePermission(userId, wid, 'tables:read')
    await tableInWorkspace(wid, tableId)
    const link = await sqlTables.link(wid, tableId)
    if (link) return sqlTables.columns(userId, link)
    return (await db.all<ColumnRow>('SELECT id,workspaceId,tableId,name,type,options,position,createdAt,updatedAt FROM table_columns WHERE workspaceId=? AND tableId=? ORDER BY position,id', wid, tableId)).map(decodeTableColumn)
  },

  async createColumn(userId: string, wid: string, tableId: string, input: unknown): Promise<TableColumn> {
    await requirePermission(userId, wid, 'tables:write')
    if (await sqlTables.link(wid, tableId)) throw new HttpError(400, 'Manage live Table columns in the source database')
    const data = z.object({ name, type: columnType, options }).strict().parse(input)
    validateColumnOptions(data.type, data.options)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:write')
      await lockTable(wid, tableId)
      const count = Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM table_columns WHERE workspaceId=? AND tableId=?', wid, tableId))!.count)
      if (count >= 100) throw new HttpError(409, 'A table cannot contain more than 100 columns')
      const position = Number((await db.get<{ position: number | string }>('SELECT COALESCE(max(position),-1)+1 AS position FROM table_columns WHERE workspaceId=? AND tableId=?', wid, tableId))!.position)
      const createdAt = now()
      const column = { id: randomUUID(), workspaceId: wid, tableId, ...data, position, createdAt, updatedAt: createdAt }
      await db.run('INSERT INTO table_columns(id,workspaceId,tableId,name,type,options,position,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)', column.id, wid, tableId, column.name, column.type, JSON.stringify(column.options), position, createdAt, createdAt)
      await audit(userId, wid, 'table.column.create', column.id, { tableId, type: column.type, position })
      return column
    })
  },

  async renameColumn(userId: string, wid: string, tableId: string, columnId: string, input: unknown): Promise<TableColumn> {
    await requirePermission(userId, wid, 'tables:write')
    if (await sqlTables.link(wid, tableId)) throw new HttpError(400, 'Manage live Table columns in the source database')
    const data = z.object({ name, expectedUpdatedAt: timestamp }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:read')
      await requirePermission(userId, wid, 'tables:write')
      await lockTable(wid, tableId)
      const previous = await columnInTable(wid, tableId, columnId)
      if (previous.updatedAt !== data.expectedUpdatedAt) throw new HttpError(409, 'Table column changed; reload before saving')
      const updatedAt = nextItemUpdatedAt(previous.updatedAt)
      const updated = await db.run('UPDATE table_columns SET name=?,updatedAt=? WHERE workspaceId=? AND tableId=? AND id=? AND updatedAt=?', data.name, updatedAt, wid, tableId, columnId, data.expectedUpdatedAt)
      if (!updated.changes) throw new HttpError(409, 'Table column changed; reload before saving')
      await audit(userId, wid, 'table.column.update', columnId, { tableId })
      return columnInTable(wid, tableId, columnId)
    })
  },

  async deleteColumn(userId: string, wid: string, tableId: string, columnId: string) {
    await requirePermission(userId, wid, 'tables:write')
    if (await sqlTables.link(wid, tableId)) throw new HttpError(400, 'Manage live Table columns in the source database')
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:write')
      await requirePermission(userId, wid, 'tables:delete')
      await lockTable(wid, tableId)
      await columnInTable(wid, tableId, columnId)
      const keyPath = `$."${columnId}"`
      const latest = await db.get<{ updatedAt: string | null }>(db.sql({
        sqlite: 'SELECT max(updatedAt) AS updatedAt FROM table_records WHERE workspaceId=? AND tableId=? AND json_type(data,?) IS NOT NULL',
        pg: 'SELECT max(updatedAt) AS updatedAt FROM table_records WHERE workspaceId=? AND tableId=? AND jsonb_extract_path(data::jsonb,CAST(? AS text)) IS NOT NULL',
      }), wid, tableId, db.dialect === 'pg' ? columnId : keyPath)
      const updatedAt = nextItemUpdatedAt(latest?.updatedAt ?? now())
      const cleaned = await db.run(db.sql({
        sqlite: 'UPDATE table_records SET data=json_remove(data,?),updatedAt=? WHERE workspaceId=? AND tableId=? AND json_type(data,?) IS NOT NULL',
        pg: 'UPDATE table_records SET data=jsonb_delete(data::jsonb,CAST(? AS text))::text,updatedAt=? WHERE workspaceId=? AND tableId=? AND jsonb_extract_path(data::jsonb,CAST(? AS text)) IS NOT NULL',
      }), db.dialect === 'pg' ? columnId : keyPath, updatedAt, wid, tableId, db.dialect === 'pg' ? columnId : keyPath)
      await db.run('DELETE FROM table_columns WHERE workspaceId=? AND tableId=? AND id=?', wid, tableId, columnId)
      await audit(userId, wid, 'table.column.delete', columnId, { tableId, touched: cleaned.changes })
      return { success: true, touchedRecords: cleaned.changes }
    })
  },

  async pageRecords(userId: string, wid: string, tableId: string, input: unknown = {}): Promise<{ records: TableRecord[]; nextCursor: string | null }> {
    await requirePermission(userId, wid, 'tables:read')
    const link = await sqlTables.link(wid, tableId)
    if (link) return sqlTables.page(userId, link, input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:read')
      await tableInWorkspace(wid, tableId)
      const query = pageInput.parse(input)
      const key = query.cursor ? decodeCursor(query.cursor, wid, tableId) : undefined
      const records: TableRecord[] = []
      let bytes = Buffer.byteLength(JSON.stringify({ records: [], nextCursor: 'x'.repeat(1024) }))
      let seek: Pick<TableRecord, 'createdAt' | 'id'> | undefined = key
      while (true) {
        const chunkLimit = Math.min(20, query.limit + 1 - records.length)
        const rows = await db.all<RecordRow>(`SELECT id,workspaceId,tableId,data,createdAt,updatedAt FROM table_records WHERE workspaceId=? AND tableId=?
          ${seek ? 'AND (createdAt > ? OR (createdAt = ? AND id > ?))' : ''} ORDER BY createdAt,id LIMIT ?`,
        wid, tableId, ...(seek ? [seek.createdAt, seek.createdAt, seek.id] : []), chunkLimit)
        if (!rows.length) return { records, nextCursor: null }
        for (const row of rows) {
          const record = decodeTableRecord(row)
          if (records.length === query.limit) return { records, nextCursor: encodeCursor(wid, tableId, records.at(-1)!) }
          const size = Buffer.byteLength(JSON.stringify(record)) + (records.length ? 1 : 0)
          if (records.length && bytes + size > PAGE_BYTES) return { records, nextCursor: encodeCursor(wid, tableId, records.at(-1)!) }
          records.push(record)
          bytes += size
          seek = record
        }
        if (rows.length < chunkLimit) return { records, nextCursor: null }
      }
    })
  },

  async getRecord(userId: string, wid: string, tableId: string, recordId: string): Promise<TableRecord> {
    await requirePermission(userId, wid, 'tables:read')
    const link = await sqlTables.link(wid, tableId)
    if (link) return sqlTables.get(userId, link, recordId)
    await tableInWorkspace(wid, tableId)
    return recordInTable(wid, tableId, recordId)
  },

  async createRecord(userId: string, wid: string, tableId: string, input: unknown): Promise<TableRecord> {
    await requirePermission(userId, wid, 'tables:write')
    if (await sqlTables.link(wid, tableId)) throw new HttpError(400, 'Create source rows in the connected database; live cells support updating existing records')
    const data = z.object({ values: values.default({}) }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:write')
      await lockTable(wid, tableId)
      const encoded = await encodeValues(wid, tableId, data.values)
      const createdAt = now()
      const record = { id: randomUUID(), workspaceId: wid, tableId, data: encoded, createdAt, updatedAt: createdAt }
      await db.run('INSERT INTO table_records(id,workspaceId,tableId,data,createdAt,updatedAt) VALUES (@id,@workspaceId,@tableId,@data,@createdAt,@updatedAt)', record)
      await audit(userId, wid, 'table.record.create', record.id, { tableId, keys: Object.keys(data.values).length })
      return decodeTableRecord(record)
    })
  },

  async updateRecord(userId: string, wid: string, tableId: string, recordId: string, input: unknown): Promise<TableRecord> {
    await requirePermission(userId, wid, 'tables:write')
    const link = await sqlTables.link(wid, tableId)
    if (link) return sqlTables.update(userId, link, recordId, input)
    const data = z.object({ values, expectedUpdatedAt: timestamp }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:read')
      await requirePermission(userId, wid, 'tables:write')
      await lockTable(wid, tableId)
      const previous = await recordInTable(wid, tableId, recordId)
      if (previous.updatedAt !== data.expectedUpdatedAt) throw new HttpError(409, 'Table record changed; reload before saving')
      const encoded = await encodeValues(wid, tableId, data.values)
      const updatedAt = nextItemUpdatedAt(previous.updatedAt)
      const updated = await db.run('UPDATE table_records SET data=?,updatedAt=? WHERE workspaceId=? AND tableId=? AND id=? AND updatedAt=?', encoded, updatedAt, wid, tableId, recordId, data.expectedUpdatedAt)
      if (!updated.changes) throw new HttpError(409, 'Table record changed; reload before saving')
      await audit(userId, wid, 'table.record.update', recordId, { tableId, keys: Object.keys(data.values).length })
      return recordInTable(wid, tableId, recordId)
    })
  },

  async deleteRecord(userId: string, wid: string, tableId: string, recordId: string) {
    await requirePermission(userId, wid, 'tables:delete')
    if (await sqlTables.link(wid, tableId)) throw new HttpError(400, 'Delete source rows in the connected database')
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'tables:delete')
      await lockTable(wid, tableId)
      const deleted = await db.run('DELETE FROM table_records WHERE workspaceId=? AND tableId=? AND id=?', wid, tableId, id.parse(recordId))
      if (!deleted.changes) throw new HttpError(404, 'Table record not found')
      await audit(userId, wid, 'table.record.delete', recordId, { tableId })
      return { success: true }
    })
  },
}
