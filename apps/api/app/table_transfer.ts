import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import type { HttpContext } from '@adonisjs/core/http'
import { z } from 'zod'
import { audit, db } from './database.js'
import { authenticate } from './security.js'
import { requirePermission } from './service.js'
import { csvCell, parseCsv } from './import_export.js'
import { decodeTableColumn, decodeTableRecord, lockTable, tableService, validTableValue } from './tables.js'
import { sqlTables } from './table_sql.js'
import { HttpError, type TableColumn, type TableRecord, type TableValue } from './types.js'

const MAX_IMPORT_ROWS = 500
const MAX_IMPORT_BYTES = 1_000_000
const columnSchema = z.object({ key: z.string().min(1).max(120), name: z.string().trim().min(1).max(120),
  type: z.enum(['text', 'number', 'date', 'datetime', 'checkbox', 'select']), options: z.array(z.string().min(1).max(120)).max(100).default([]) }).strict()
const scalar = z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()])
const rowSchema = z.record(z.string().max(120), scalar)
const transferSchema = z.object({ format: z.literal('hopya-table'), version: z.literal(1), name: z.string().max(120),
  columns: z.array(columnSchema).max(100), records: z.array(rowSchema).max(MAX_IMPORT_ROWS) }).strict()
type ImportColumn = z.infer<typeof columnSchema>

export function parseTableFile(format: 'json' | 'csv', data: string): { columns: ImportColumn[]; records: Record<string, TableValue>[]; name?: string } {
  if (Buffer.byteLength(data) > MAX_IMPORT_BYTES) throw new HttpError(400, 'Table imports are limited to 1 MB')
  if (format === 'json') {
    let parsed: unknown
    try { parsed = JSON.parse(data) } catch { throw new HttpError(400, 'Invalid JSON') }
    if (!Array.isArray(parsed)) return transferSchema.parse(parsed)
    const records = z.array(rowSchema).min(1).max(MAX_IMPORT_ROWS).parse(parsed)
    const keys = [...new Set(records.flatMap(row => Object.keys(row)))]
    const columns = keys.map(key => {
      const present = records.map(row => row[key]).filter(value => value != null)
      const type = present.length && present.every(value => typeof value === 'number') ? 'number'
        : present.length && present.every(value => typeof value === 'boolean') ? 'checkbox' : 'text'
      return columnSchema.parse({ key, name: key, type })
    })
    if (!columns.length || columns.length > 100) throw new HttpError(400, 'Imports need 1 to 100 columns')
    return { columns, records }
  }
  const [header, ...rows] = parseCsv(data)
  if (!header?.length || header.length > 100 || header.some(value => !value.trim() || value.length > 120) || new Set(header).size !== header.length)
    throw new HttpError(400, 'CSV needs 1 to 100 unique, non-empty column headings')
  if (rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, 'Table imports are limited to 500 records')
  if (rows.some(row => row.length !== header.length)) throw new HttpError(400, 'Every CSV row must match the header width')
  return { columns: header.map(key => ({ key, name: key, type: 'text', options: [] })),
    records: rows.map(row => Object.fromEntries(header.map((key, index) => [key, row[index]!]))) }
}

function converted(value: TableValue | undefined, column: TableColumn, csv: boolean): TableValue {
  if (value == null) return null
  if (!csv || column.type === 'text') return value
  if (value === '') return null
  if (column.type === 'number' && typeof value === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return Number(value)
  if (column.type === 'checkbox') {
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
  }
  return value
}

export async function importTable(userId: string, wid: string, input: unknown, tableId?: string) {
  await requirePermission(userId, wid, 'tables:write')
  await requirePermission(userId, wid, 'tables:read')
  const data = z.object({ format: z.enum(['csv', 'json']), data: z.string().max(MAX_IMPORT_BYTES),
    name: z.string().trim().min(1).max(120).optional(), parentId: z.string().uuid().nullable().optional(),
    columns: z.array(columnSchema).min(1).max(100).optional() }).strict().parse(input)
  const parsed = parseTableFile(data.format, data.data)
  const definitions = data.columns ?? parsed.columns
  if (new Set(definitions.map(column => column.key)).size !== definitions.length)
    throw new HttpError(400, 'Import columns need unique keys')
  return db.transaction(async () => {
    await requirePermission(userId, wid, 'tables:read')
    await requirePermission(userId, wid, 'tables:write')
    const table = tableId ? await tableService.getTable(userId, wid, tableId)
      : await tableService.createTable(userId, wid, { name: data.name ?? parsed.name ?? 'Imported table', parentId: data.parentId ?? null })
    await lockTable(wid, table.id)
    if (await sqlTables.link(wid, table.id)) throw new HttpError(400, 'Import into a local Hopya Table; live connections edit existing source rows')
    let columns = await tableService.listColumns(userId, wid, table.id)
    const createdColumns = !columns.length
    if (createdColumns) {
      for (const column of definitions) columns.push(await tableService.createColumn(userId, wid, table.id, { name: column.name, type: column.type, options: column.options }))
    }
    const mapping = new Map<string, TableColumn>()
    for (const [index, definition] of definitions.entries()) {
      const matches = createdColumns ? [columns[index]!] : columns.filter(column => column.name === definition.name)
      if (matches.length !== 1) throw new HttpError(400, `Import column ${definition.name} must match exactly one destination column`)
      if ([...mapping.values()].some(column => column.id === matches[0]!.id)) throw new HttpError(400, 'Each destination column may be mapped only once')
      mapping.set(definition.key, matches[0]!)
    }
    const now = new Date().toISOString()
    // Records seek by (createdAt,id); assign sorted random IDs within this batch
    // so a spreadsheet's source row order survives import without fake dates.
    const recordIds = parsed.records.map(() => randomUUID()).sort()
    for (const [index, row] of parsed.records.entries()) {
      const values: Record<string, TableValue> = {}
      for (const [key, value] of Object.entries(row)) {
        const column = mapping.get(key)
        if (!column) throw new HttpError(400, `Row ${index + 1} contains an unmapped column`)
        const next = converted(value, column, data.format === 'csv')
        if (!validTableValue(column, next)) throw new HttpError(400, `Row ${index + 1}: invalid ${column.name} value`)
        values[column.id] = next
      }
      const encoded = JSON.stringify(values)
      if (Buffer.byteLength(encoded) > 256 * 1024) throw new HttpError(400, `Row ${index + 1} exceeds 256 KiB`)
      await db.run('INSERT INTO table_records(id,workspaceId,tableId,data,createdAt,updatedAt) VALUES (?,?,?,?,?,?)', recordIds[index], wid, table.id, encoded, now, now)
    }
    await audit(userId, wid, 'table.import', table.id, { records: parsed.records.length, columns: mapping.size })
    return { table, imported: parsed.records.length }
  })
}

const exportsByUser = new Map<string, number>()
let activeExports = 0

export async function exportTable(ctx: HttpContext) {
  const userId = (await authenticate(ctx)).id, wid: string = ctx.params.wid, tableId: string = ctx.params.id
  const { format } = z.object({ format: z.enum(['csv', 'json']).default('json') }).strict().parse(ctx.request.qs())
  const table = await tableService.getTable(userId, wid, tableId)
  const link = await sqlTables.link(wid, tableId)
  ctx.response.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json')
  ctx.response.header('Content-Disposition', `attachment; filename="table-${table.id}.${format}"`)
  if (ctx.request.method() === 'HEAD') { ctx.response.status(200).send(''); return }
  if (activeExports >= 8 || (exportsByUser.get(userId) ?? 0) >= 2) { ctx.response.header('Retry-After', '1'); throw new HttpError(429, 'Too many Table exports') }
  activeExports++; exportsByUser.set(userId, (exportsByUser.get(userId) ?? 0) + 1)
  const controller = new AbortController(), stream = new PassThrough({ highWaterMark: 64 * 1024 })
  let started = false
  let begin!: () => void, rejectBegin!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { begin = resolve; rejectBegin = reject })
  const deadline = Date.now() + 30_000
  const stop = () => { controller.abort(); stream.destroy() }
  const timer = setTimeout(() => { controller.abort(); stream.destroy(new HttpError(504, 'Table export deadline exceeded')) }, 30_000)
  timer.unref()
  const response = ctx.response.response, request = ctx.request.request
  response.once('close', stop); request.once('aborted', stop)
  stream.on('error', () => controller.abort())
  const checkpoint = async () => {
    await setImmediate()
    if (controller.signal.aborted || request.aborted || response.destroyed || Date.now() >= deadline) throw new HttpError(504, 'Table export interrupted')
    const user = await authenticate(ctx)
    if (user.id !== userId) throw new HttpError(401, 'Authentication required')
    await requirePermission(userId, wid, 'tables:read')
  }
  const write = async (text: string) => {
    const buffer = Buffer.from(text)
    for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
      await checkpoint()
      if (!stream.write(buffer.subarray(offset, offset + 64 * 1024))) await once(stream, 'drain', { signal: controller.signal })
    }
  }
  const produce = async (columns: TableColumn[], read: (cursor?: string) => Promise<{ records: TableRecord[]; nextCursor: string | null }>) => {
    // Pin the local/remote snapshot before Adonis emits response headers. A
    // client receiving 200 must already have a consistent export established.
    let page = await read()
    await checkpoint()
    if (format === 'csv' && (!columns.length || new Set(columns.map(column => column.name)).size !== columns.length))
      throw new HttpError(400, 'Use JSON to export Tables with no columns or duplicate column names')
    ctx.response.stream(stream)
    started = true; begin()
    if (format === 'csv') {
      await write(columns.map(column => csvCell(column.name)).join(',') + '\r\n')
    } else await write(JSON.stringify({ format: 'hopya-table', version: 1, name: table.name, columns: columns.map(column => ({ key: column.id, name: column.name, type: column.type, options: column.options })) }).slice(0, -1) + ',"records":[')
    let cursor: string | undefined, first = true
    do {
      await checkpoint()
      for (const record of page.records) {
        await write(format === 'csv' ? columns.map(column => csvCell(record.values[column.id] == null ? '' : String(record.values[column.id]))).join(',') + '\r\n'
          : `${first ? '' : ','}${JSON.stringify(record.values)}`)
        first = false
      }
      cursor = page.nextCursor ?? undefined
      if (cursor) page = await read(cursor)
    } while (cursor)
    if (format === 'json') await write(']}')
  }
  // Errors after headers destroy the stream. A partial export is never terminated
  // with a success-shaped JSON object or a fake final CSV row.
  void (async () => {
    try {
      if (link) await sqlTables.readSnapshot(userId, link, (columns, read) => produce(columns, cursor => read(50, cursor)), checkpoint)
      else await db.snapshot(async snapshot => {
        const columns = (await snapshot.all<Parameters<typeof decodeTableColumn>[0]>('SELECT id,workspaceId,tableId,name,type,options,position,createdAt,updatedAt FROM table_columns WHERE workspaceId=? AND tableId=? ORDER BY position,id', wid, tableId)).map(decodeTableColumn)
        await produce(columns, async cursor => {
          const key: string[] | undefined = cursor ? JSON.parse(cursor) : undefined
          const rows = await snapshot.all<Parameters<typeof decodeTableRecord>[0]>(`SELECT id,workspaceId,tableId,data,createdAt,updatedAt FROM table_records WHERE workspaceId=? AND tableId=? ${key ? 'AND (createdAt>? OR (createdAt=? AND id>?))' : ''} ORDER BY createdAt,id LIMIT 50`, wid, tableId, ...(key ? [key[0], key[0], key[1]] : []))
          return { records: rows.map(decodeTableRecord), nextCursor: rows.length === 50 ? JSON.stringify([rows.at(-1)!.createdAt, rows.at(-1)!.id]) : null }
        })
      })
      await checkpoint(); stream.end()
    } catch (error) {
      const failure = error instanceof HttpError ? error : new HttpError(500, 'Table export failed')
      if (!started) rejectBegin(failure)
      stream.destroy(failure)
    }
    finally {
      clearTimeout(timer); response.off('close', stop); request.off('aborted', stop)
      activeExports--; const count = exportsByUser.get(userId)! - 1
      if (count) exportsByUser.set(userId, count); else exportsByUser.delete(userId)
    }
  })()
  await ready
}
