import { setImmediate } from 'node:timers/promises'
import type { HttpContext } from '@adonisjs/core/http'
import { db } from './database.js'
import { authenticate } from './security.js'
import { decodeTableColumn, decodeTableRecord, tableService } from './tables.js'
import { sqlTables } from './table_sql.js'
import { HttpError, type TableColumn, type TableRecord } from './types.js'

type RecordPage = { records: TableRecord[]; nextCursor: string | null }
type SnapshotWork<T> = (columns: TableColumn[], read: (cursor?: string) => Promise<RecordPage>, checkpoint: () => Promise<void>) => Promise<T>
const byUser = new Map<string, number>()
let active = 0

// Queries and calculations share admission and the same bounded data reader.
export async function readTableSnapshot<T>(userId: string, wid: string, tableId: string, work: SnapshotWork<T>, checkCredentials?: () => Promise<void>): Promise<T> {
  await tableService.getTable(userId, wid, tableId)
  if (active >= 4 || (byUser.get(userId) ?? 0) >= 2) throw new HttpError(429, 'Too many Table queries or calculations; try again shortly')
  active++; byUser.set(userId, (byUser.get(userId) ?? 0) + 1)
  const deadline = Date.now() + 30_000
  const checkpoint = async () => {
    await setImmediate()
    if (Date.now() >= deadline) throw new HttpError(504, 'Table read deadline exceeded; no partial results returned')
    await checkCredentials?.()
    await tableService.getTable(userId, wid, tableId)
  }
  try {
    await checkpoint()
    const link = await sqlTables.link(wid, tableId)
    const result = link
      ? await sqlTables.readSnapshot(userId, link, (columns, read) => work(columns, cursor => read(20, cursor), checkpoint), checkpoint)
      : await db.snapshot(async snapshot => {
        const columns = (await snapshot.all<Parameters<typeof decodeTableColumn>[0]>('SELECT id,workspaceId,tableId,name,type,options,position,createdAt,updatedAt FROM table_columns WHERE workspaceId=? AND tableId=? ORDER BY position,id', wid, tableId)).map(decodeTableColumn)
        return work(columns, async cursor => {
          const key: string[] | undefined = cursor ? JSON.parse(cursor) : undefined
          const rows = await snapshot.all<Parameters<typeof decodeTableRecord>[0]>(`SELECT id,workspaceId,tableId,data,createdAt,updatedAt FROM table_records WHERE workspaceId=? AND tableId=? ${key ? 'AND (createdAt>? OR (createdAt=? AND id>?))' : ''} ORDER BY createdAt,id LIMIT 20`, wid, tableId, ...(key ? [key[0], key[0], key[1]] : []))
          return { records: rows.map(decodeTableRecord), nextCursor: rows.length === 20 ? JSON.stringify([rows.at(-1)!.createdAt, rows.at(-1)!.id]) : null }
        }, checkpoint)
      })
    await checkpoint()
    return result
  } finally {
    active--
    const count = byUser.get(userId)! - 1
    if (count) byUser.set(userId, count); else byUser.delete(userId)
  }
}

export const tableReadCredentials = (ctx: HttpContext, userId: string) => async () => {
  if (ctx.request.request.aborted || ctx.response.response.destroyed) throw new HttpError(499, 'Table read cancelled')
  if ((await authenticate(ctx)).id !== userId) throw new HttpError(401, 'Authentication required')
}
