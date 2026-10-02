import type { HttpContext } from '@adonisjs/core/http'
import { authenticate } from './security.js'
import { tableService } from './tables.js'
import { readTableSnapshot, tableReadCredentials } from './table_reads.js'
import { HttpError, type TableColumn, type TableRecord } from './types.js'

type ColumnSummary = {
  count: number; empty: number
  sum?: number | null; average?: number | null; min?: number | null; max?: number | null
  earliest?: string | null; latest?: string | null
  checked?: number; unchecked?: number
}
export type TableCalculations = { recordCount: number; columns: Record<string, ColumnSummary> }

// Compare instants across offsets without throwing away source microseconds.
export function tableDateOrder(left: string, right: string): number {
  const delta = Date.parse(left) - Date.parse(right)
  if (delta) return delta
  const remainder = (value: string) => (value.match(/\.(\d+)/)?.[1] ?? '').slice(3).replace(/0+$/, '')
  const a = remainder(left), b = remainder(right)
  return a < b ? -1 : a > b ? 1 : 0
}

export function tableAccumulator(columns: TableColumn[]) {
  const result: TableCalculations = { recordCount: 0, columns: {} }
  const corrections = new Map<string, number>()
  for (const column of columns) result.columns[column.id] = { count: 0, empty: 0,
    ...(column.type === 'number' ? { sum: 0, average: null, min: null, max: null } : {}),
    ...(column.type === 'date' || column.type === 'datetime' ? { earliest: null, latest: null } : {}),
    ...(column.type === 'checkbox' ? { checked: 0, unchecked: 0 } : {}),
  }
  return { add(record: TableRecord) {
    result.recordCount++
    for (const column of columns) {
      const summary = result.columns[column.id]!, value = record.values[column.id]
      if (value == null || value === '') { summary.empty++; continue }
      summary.count++
      if (column.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(422, 'A number column contains a non-numeric value')
        if (summary.sum !== null) {
          const sum = summary.sum!, next = sum + value
          // Compensate ordinary floating-point cancellation; never serialize
          // overflow as a successful zero/empty total.
          const correction = (corrections.get(column.id) ?? 0) + (Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum)
          summary.sum = Number.isFinite(next) && Number.isFinite(correction) ? next : null
          corrections.set(column.id, correction)
        }
        summary.min = summary.min == null ? value : Math.min(summary.min, value)
        summary.max = summary.max == null ? value : Math.max(summary.max, value)
      } else if (column.type === 'checkbox') {
        if (typeof value !== 'boolean') throw new HttpError(422, 'A checkbox column contains a non-boolean value')
        if (value) summary.checked!++; else summary.unchecked!++
      } else if (column.type === 'date' || column.type === 'datetime') {
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new HttpError(422, 'A date column contains an invalid date')
        if (summary.earliest == null || tableDateOrder(value, summary.earliest) < 0) summary.earliest = value
        if (summary.latest == null || tableDateOrder(value, summary.latest) > 0) summary.latest = value
      }
    }
  }, finish() {
    for (const column of columns) {
      const summary = result.columns[column.id]!
      if (column.type !== 'number' || summary.sum === null) continue
      const sum = summary.sum! + (corrections.get(column.id) ?? 0)
      summary.sum = Number.isFinite(sum) ? sum : null
      summary.average = summary.count && summary.sum !== null ? summary.sum / summary.count : null
    }
    return result
  } }
}

export async function summarizeTable(userId: string, wid: string, tableId: string, checkCredentials?: () => Promise<void>): Promise<TableCalculations> {
  return readTableSnapshot(userId, wid, tableId, async (columns, read, checkpoint) => {
    const accumulator = tableAccumulator(columns)
    let cursor: string | undefined
    do {
      await checkpoint()
      const page = await read(cursor)
      for (const record of page.records) accumulator.add(record)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    await checkpoint()
    return accumulator.finish()
  }, checkCredentials)
}

export async function tableSummary(ctx: HttpContext) {
  const userId = (await authenticate(ctx)).id, wid: string = ctx.params.wid, tableId: string = ctx.params.id
  if (ctx.request.method() === 'HEAD') {
    await tableService.getTable(userId, wid, tableId)
    ctx.response.status(200).send('')
    return
  }
  return summarizeTable(userId, wid, tableId, tableReadCredentials(ctx, userId))
}
