import { createHash } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { z } from 'zod'
import { authenticate } from './security.js'
import { dateSchema } from './service.js'
import { readTableSnapshot, tableReadCredentials } from './table_reads.js'
import { tableAccumulator, tableDateOrder } from './table_summary.js'
import { PAGE_BYTES } from './task_reads.js'
import { HttpError, type TableColumn, type TableRecord, type TableValue } from './types.js'

const filterInput = z.object({
  columnId: z.string().uuid(),
  operator: z.enum(['contains', 'not_contains', 'is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty']),
  value: z.union([z.string().max(10000), z.number().finite(), z.boolean()]).optional(),
}).strict()
const queryInput = z.object({
  filters: z.array(filterInput).max(20).default([]),
  sort: z.object({ columnId: z.string().uuid(), direction: z.enum(['asc', 'desc']) }).strict().nullable().default(null),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(8192).optional(),
  summary: z.boolean().default(false),
}).strict()
const cursorInput = z.object({ v: z.literal(1), scope: z.string().length(64), id: z.string().min(1).max(4096), order: z.string().length(64) }).strict()
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const empty = (value: TableValue | undefined) => value == null || value === ''
const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
type PositionedRecord = { record: TableRecord; ordinal: number }

function checkValue(column: TableColumn, value: TableValue | undefined) {
  if (empty(value)) return
  if (column.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))
    || column.type === 'checkbox' && typeof value !== 'boolean'
    || column.type === 'date' && !dateSchema.safeParse(value).success
    || column.type === 'datetime' && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new HttpError(422, 'A queried column contains a value that does not match its type')
}

function valueOrder(column: TableColumn, a: TableValue, b: TableValue): number {
  if (column.type === 'number') return Number(a) - Number(b)
  if (column.type === 'checkbox') return Number(a) - Number(b)
  if (column.type === 'date' || column.type === 'datetime') return tableDateOrder(String(a), String(b))
  return textOrder(String(a).toLowerCase(), String(b).toLowerCase())
}

function checkedFilter(filter: z.infer<typeof filterInput>, columns: TableColumn[]) {
  const column = columns.find(column => column.id === filter.columnId)
  if (!column) throw new HttpError(400, 'Filter column does not belong to this Table')
  const { operator, value } = filter
  if (operator !== 'empty' && operator !== 'not_empty') {
    const ordered = ['number', 'date', 'datetime'].includes(column.type)
    if (['gt', 'gte', 'lt', 'lte'].includes(operator) && !ordered
      || ['contains', 'not_contains'].includes(operator) && !['text', 'select'].includes(column.type)) throw new HttpError(400, 'Filter operator is not supported for this column type')
    if (column.type === 'number' ? typeof value !== 'number' : column.type === 'checkbox' ? typeof value !== 'boolean' : typeof value !== 'string') throw new HttpError(400, 'Filter value must match the column type')
    if (column.type === 'date' && !dateSchema.safeParse(value).success
      || column.type === 'datetime' && (!z.string().max(64).datetime({ offset: true }).safeParse(value).success || !Number.isFinite(Date.parse(String(value))))) throw new HttpError(400, 'Invalid filter date')
  }
  return (record: TableRecord) => {
    const actual = record.values[column.id], missing = empty(actual)
    if (operator === 'empty') return missing
    if (operator === 'not_empty') return !missing
    if (missing) return false
    checkValue(column, actual)
    if (operator === 'contains' || operator === 'not_contains') {
      const contains = String(actual).toLowerCase().includes(String(value).toLowerCase())
      return operator === 'contains' ? contains : !contains
    }
    const order = valueOrder(column, actual!, value!)
    return operator === 'is' ? order === 0 : operator === 'is_not' ? order !== 0
      : operator === 'gt' ? order > 0 : operator === 'gte' ? order >= 0 : operator === 'lt' ? order < 0 : order <= 0
  }
}

export async function queryTable(userId: string, wid: string, tableId: string, input: unknown, checkCredentials?: () => Promise<void>) {
  const data = queryInput.parse(input)
  return readTableSnapshot(userId, wid, tableId, async (columns, read, checkpoint) => {
    const filters = data.filters.map(filter => checkedFilter(filter, columns))
    const sortColumn = data.sort ? columns.find(column => column.id === data.sort!.columnId) : undefined
    if (data.sort && !sortColumn) throw new HttpError(400, 'Sort column does not belong to this Table')
    const scope = hash([wid, tableId, columns.map(column => [column.id, column.type, column.options]), data.filters, data.sort])
    const orderHash = (record: TableRecord) => hash([record.createdAt, record.id, sortColumn ? record.values[sortColumn.id] ?? null : null])
    const compare = (a: PositionedRecord, b: PositionedRecord) => {
      if (sortColumn) {
        const av = a.record.values[sortColumn.id], bv = b.record.values[sortColumn.id]
        // Empty cells stay last in either direction. The snapshot's natural
        // order (local creation/ID or source primary key) breaks all value ties.
        if (empty(av) !== empty(bv)) return empty(av) ? 1 : -1
        const order = empty(av) ? 0 : valueOrder(sortColumn, av!, bv!)
        if (order) return data.sort!.direction === 'asc' ? order : -order
      }
      return a.ordinal - b.ordinal
    }
    let anchor: PositionedRecord | undefined
    if (data.cursor) {
      let cursor: z.infer<typeof cursorInput>
      try {
        cursor = cursorInput.parse(JSON.parse(Buffer.from(data.cursor, 'base64url').toString()))
        if (cursor.scope !== scope || Buffer.from(JSON.stringify(cursor)).toString('base64url') !== data.cursor) throw new Error()
      } catch { throw new HttpError(400, 'Invalid Table query cursor or changed filters/order') }
      // Resolve the anchor inside the same snapshot rather than embedding a
      // potentially 256 KiB source value in the cursor or trusting client values.
      let position: string | undefined, ordinal = 0
      do {
        await checkpoint()
        const page = await read(position)
        const index = page.records.findIndex(record => record.id === cursor.id)
        if (index >= 0) anchor = { record: page.records[index]!, ordinal: ordinal + index }
        ordinal += page.records.length
        position = page.nextCursor ?? undefined
      } while (!anchor && position)
      if (!anchor || orderHash(anchor.record) !== cursor.order || !filters.every(matches => matches(anchor!.record))) throw new HttpError(409, 'Table page position changed; refresh the results')
    }
    const selected: (PositionedRecord & { bytes: number })[] = []
    const accumulator = data.summary ? tableAccumulator(columns) : undefined
    let bytes = 0, total = 0, remaining = 0, ordinal = 0, position: string | undefined
    do {
      await checkpoint()
      const page = await read(position)
      for (const record of page.records) {
        const candidate = { record, ordinal: ordinal++ }
        if (!filters.every(matches => matches(record))) continue
        if (sortColumn) checkValue(sortColumn, record.values[sortColumn.id])
        total++; accumulator?.add(record)
        if (anchor && compare(candidate, anchor) <= 0) continue
        remaining++
        let low = 0, high = selected.length
        while (low < high) {
          const mid = (low + high) >>> 1
          if (compare(selected[mid]!, candidate) < 0) low = mid + 1; else high = mid
        }
        if (low >= data.limit) continue
        const size = Buffer.byteLength(JSON.stringify(record))
        selected.splice(low, 0, { ...candidate, bytes: size }); bytes += size
        while (selected.length > data.limit || selected.length > 1 && bytes > PAGE_BYTES) bytes -= selected.pop()!.bytes
      }
      position = page.nextCursor ?? undefined
    } while (position)
    await checkpoint()
    const records = selected.map(entry => entry.record), last = records.at(-1)
    return { records, total, nextCursor: last && remaining > records.length ? Buffer.from(JSON.stringify({ v: 1, scope, id: last.id, order: orderHash(last) })).toString('base64url') : null,
      ...(accumulator ? { summary: accumulator.finish() } : {}) }
  }, checkCredentials)
}

export async function tableQuery(ctx: HttpContext) {
  const userId = (await authenticate(ctx)).id
  return queryTable(userId, ctx.params.wid, ctx.params.id, ctx.request.body(), tableReadCredentials(ctx, userId))
}
