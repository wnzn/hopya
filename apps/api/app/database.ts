import lucidDb from '@adonisjs/lucid/services/db'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit } from 'effect'

export type DbDialect = 'sqlite' | 'pg'
export type DbBindings = readonly unknown[] | Record<string, unknown>

export interface RunResult {
  changes: number
  lastInsertRowid?: number | bigint | string
}

export interface SnapshotTransaction {
  readonly dialect: DbDialect
  get<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row | undefined>
  all<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row[]>
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface DatabaseApi {
  readonly dialect: DbDialect
  get<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row | undefined>
  all<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row[]>
  run(sql: string, ...bindings: unknown[]): Promise<RunResult>
  sql(variants: Record<DbDialect, string>): string
  transaction<T>(callback: (database: DatabaseApi) => Promise<T>): Promise<T>
  beginSnapshot(): Promise<SnapshotTransaction>
  snapshot<T>(callback: (snapshot: SnapshotTransaction) => Promise<T>): Promise<T>
}

type Client = QueryClientContract | TransactionClientContract
const transactions = new AsyncLocalStorage<TransactionClientContract>()

const dialectOf = (client: Client): DbDialect => client.dialect.name === 'postgres' ? 'pg' : 'sqlite'

const bindingsOf = (values: unknown[]): DbBindings => {
  if (values.length !== 1) return values
  const value = values[0]
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return value as Record<string, unknown>
  }
  return values
}

// Knex uses :name for named bindings. Existing SQL uses @name, and unquoted
// camelCase columns need quoting on Postgres because it folds names.
const compatibleSql = (sql: string, bindings: DbBindings, dialect: DbDialect): string => {
  const named = !Array.isArray(bindings)
  let output = ''
  for (let index = 0; index < sql.length;) {
    const char = sql[index]
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      output += char
      index++
      while (index < sql.length) {
        output += sql[index]
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            output += sql[index + 1]
            index += 2
            continue
          }
          index++
          break
        }
        index++
      }
      continue
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index)
      if (end === -1) return output + sql.slice(index)
      output += sql.slice(index, end + 1)
      index = end + 1
      continue
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)
      if (end === -1) return output + sql.slice(index)
      output += sql.slice(index, end + 2)
      index = end + 2
      continue
    }
    if (named && char === '@' && /[A-Za-z_]/.test(sql[index + 1] ?? '')) {
      let end = index + 2
      while (/[A-Za-z0-9_]/.test(sql[end] ?? '')) end++
      output += `:${sql.slice(index + 1, end)}`
      index = end
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1
      while (/[A-Za-z0-9_$]/.test(sql[end] ?? '')) end++
      const identifier = sql.slice(index, end)
      output += dialect === 'pg' && /[a-z]/.test(identifier) && /[A-Z]/.test(identifier)
        ? `"${identifier}"`
        : identifier
      index = end
      continue
    }
    output += char
    index++
  }
  return output
}

const rowsOf = <Row>(result: unknown): Row[] => {
  if (Array.isArray(result)) return result as Row[]
  if (result !== null && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Row[] }).rows
  }
  return []
}

const runResultOf = (result: unknown): RunResult => {
  if (result === null || typeof result !== 'object') return { changes: 0 }
  const value = result as { changes?: unknown; rowCount?: unknown; lastInsertRowid?: unknown; lastID?: unknown }
  const changes = typeof value.changes === 'number' ? value.changes : typeof value.rowCount === 'number' ? value.rowCount : 0
  const lastInsertRowid = value.lastInsertRowid ?? value.lastID
  return typeof lastInsertRowid === 'number' || typeof lastInsertRowid === 'bigint' || typeof lastInsertRowid === 'string'
    ? { changes, lastInsertRowid }
    : { changes }
}

const execute = async (client: Client, sql: string, values: unknown[]): Promise<unknown> => {
  const bindings = bindingsOf(values)
  // Lucid's binding type omits null even though Knex and both configured
  // drivers support it. Keep the wider compatibility type at this boundary.
  return client.rawQuery(compatibleSql(sql, bindings, dialectOf(client)), bindings as never)
}

const scopedClient = (): Client => transactions.getStore() ?? lucidDb.connection()

const queriesFor = (client: Client) => ({
  get: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row | undefined> =>
    rowsOf<Row>(await execute(client, sql, bindings))[0],
  all: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row[]> =>
    rowsOf<Row>(await execute(client, sql, bindings)),
  run: async (sql: string, ...bindings: unknown[]): Promise<RunResult> =>
    runResultOf(await execute(client, sql, bindings)),
})

export const db: DatabaseApi = {
  get dialect(): DbDialect {
    return dialectOf(scopedClient())
  },

  async get<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row | undefined> {
    return queriesFor(scopedClient()).get<Row>(sql, ...bindings)
  },

  async all<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, ...bindings: unknown[]): Promise<Row[]> {
    return queriesFor(scopedClient()).all<Row>(sql, ...bindings)
  },

  async run(sql: string, ...bindings: unknown[]): Promise<RunResult> {
    return queriesFor(scopedClient()).run(sql, ...bindings)
  },

  sql(variants: Record<DbDialect, string>): string {
    return variants[db.dialect]
  },

  async transaction<T>(callback: (database: DatabaseApi) => Promise<T>): Promise<T> {
    const current = transactions.getStore()
    if (current) return callback(db)
    return lucidDb.transaction((transaction) => transactions.run(transaction, callback, db))
  },

  async beginSnapshot(): Promise<SnapshotTransaction> {
    const client = lucidDb.connection()
    const dialect = dialectOf(client)
    const transaction = await client.transaction(dialect === 'pg' ? { isolationLevel: 'repeatable read' } : undefined)
    try {
      if (dialect === 'pg') await transaction.rawQuery('SET TRANSACTION READ ONLY')
    } catch (error) {
      await transaction.rollback()
      throw error
    }
    const queries = queriesFor(transaction)
    let completed = false
    return {
      dialect,
      get: queries.get,
      all: queries.all,
      async commit() {
        if (completed) return
        await transaction.commit()
        completed = true
      },
      async rollback() {
        if (completed) return
        await transaction.rollback()
        completed = true
      },
    }
  },

  async snapshot<T>(callback: (snapshot: SnapshotTransaction) => Promise<T>): Promise<T> {
    const snapshot = await db.beginSnapshot()
    try {
      const result = await callback(snapshot)
      await snapshot.commit()
      return result
    } catch (error) {
      await snapshot.rollback()
      throw error
    }
  },
}

export class DbFailure {
  readonly _tag = 'DbFailure'
  constructor(readonly message: string, readonly cause?: unknown) {}
}

export const dbAsync = <A>(fn: () => Promise<A>, message: string): Effect.Effect<A, DbFailure> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new DbFailure(message, cause),
  })

const unwrapCause = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') return failure.value
  const defect = Cause.dieOption(cause)
  if (defect._tag === 'Some') return defect.value
  return cause
}

export const runSyncThrow = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw unwrapCause(exit.cause)
}

export const runPromiseThrow = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    throw unwrapCause(exit.cause)
  })

export const auditEffect = (
  actorId: string | null,
  workspaceId: string | null,
  action: string,
  resourceId: string | null,
  details: Record<string, unknown> = {},
): Effect.Effect<void, DbFailure> =>
  dbAsync(async () => {
    await db.run(
      'INSERT INTO audit_logs (id,actorId,workspaceId,action,resourceId,details,createdAt) VALUES (?,?,?,?,?,?,?)',
      randomUUID(), actorId, workspaceId, action, resourceId, JSON.stringify(details), new Date().toISOString(),
    )
  }, 'Audit write failed')

export async function audit(actorId: string | null, workspaceId: string | null, action: string, resourceId: string | null, details: Record<string, unknown> = {}): Promise<void> {
  try {
    await runPromiseThrow(auditEffect(actorId, workspaceId, action, resourceId, details))
  } catch (error) {
    if (error instanceof DbFailure && error.cause !== undefined) throw error.cause
    throw error
  }
}
