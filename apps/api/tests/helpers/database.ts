import { Database } from '@adonisjs/lucid/database'
import { defineConfig } from '@adonisjs/lucid'
import type { Emitter } from '@adonisjs/core/events'
import type { Logger } from '@adonisjs/core/logger'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { DatabaseApi, RunResult } from '../../app/database.js'

type Client = QueryClientContract | TransactionClientContract

const logger = { trace() {} } as unknown as Logger
const emitter = { emit: async () => {}, hasListeners: () => false } as unknown as Emitter<Record<string, unknown>>

const rows = <Row>(result: unknown): Row[] => Array.isArray(result)
  ? result as Row[]
  : (result as { rows?: Row[] } | null)?.rows ?? []

const result = (value: unknown): RunResult => {
  const row = value as { changes?: number; rowCount?: number; lastInsertRowid?: number | bigint | string; lastID?: number | bigint | string } | null
  const changes = row?.changes ?? row?.rowCount ?? 0
  const lastInsertRowid = row?.lastInsertRowid ?? row?.lastID
  return lastInsertRowid === undefined ? { changes } : { changes, lastInsertRowid }
}

const apiFor = (client: Client): DatabaseApi => ({
  dialect: client.dialect.name === 'postgres' ? 'pg' : 'sqlite',
  async get<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row | undefined> {
    return rows<Row>(await client.rawQuery(sql, bindings as never))[0]
  },
  async all<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row[]> {
    return rows<Row>(await client.rawQuery(sql, bindings as never))
  },
  async run(sql: string, ...bindings: unknown[]) {
    return result(await client.rawQuery(sql, bindings as never))
  },
  sql(variants) {
    return variants[client.dialect.name === 'postgres' ? 'pg' : 'sqlite']
  },
  async transaction<T>(callback: (database: DatabaseApi) => Promise<T>) {
    if (client.isTransaction) return callback(apiFor(client))
    return client.transaction((transaction) => callback(apiFor(transaction)))
  },
  async beginSnapshot() {
    throw new Error('Test database snapshots are not supported')
  },
  async snapshot() {
    throw new Error('Test database snapshots are not supported')
  },
})

export function openTestDatabase(filename: string): DatabaseApi & { close(): Promise<void> } {
  const database = new Database(defineConfig({
    connection: 'sqlite',
    connections: {
      sqlite: {
        client: 'better-sqlite3',
        connection: { filename },
        useNullAsDefault: true,
        pool: {
          afterCreate(connection, done) {
            connection.pragma('foreign_keys = ON')
            connection.pragma('busy_timeout = 1000')
            done(null, connection)
          },
        },
      },
    },
  }), logger, emitter)
  return Object.assign(apiFor(database.connection()), {
    close: () => database.manager.closeAll(true),
  })
}
