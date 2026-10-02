import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import knex, { type Knex } from 'knex'
import { Effect } from 'effect'
import { z } from 'zod'
import { audit, db, runPromiseThrow } from './database.js'
import { dataDir } from './settings.js'
import { dateSchema, requirePermission } from './service.js'
import { HttpError, type TableColumn, type TableColumnType, type TableRecord, type TableValue } from './types.js'

const id = z.string().uuid()
const identifier = z.string().min(1).max(120).refine(value => !/[\u0000-\u001f]/.test(value), 'Invalid SQL identifier')
const connectionInput = z.object({
  name: z.string().trim().min(1).max(120), dialect: z.enum(['pg', 'mysql', 'sqlite']),
  host: z.string().min(1).max(253).optional(), port: z.number().int().min(1).max(65535).optional(),
  database: z.string().min(1).max(120).optional(), username: z.string().max(120).optional(),
  password: z.string().max(4096).optional(), tls: z.boolean().default(true),
  filename: z.string().min(1).max(1024).optional(),
}).strict().superRefine((data, ctx) => {
  if (data.dialect === 'sqlite' ? !data.filename : !data.host || !data.database || !data.username)
    ctx.addIssue({ code: 'custom', message: 'Provide a SQLite filename or database host, database and username' })
})
type Configuration = z.infer<typeof connectionInput>
type Connection = { id: string; workspaceId: string; name: string; dialect: Configuration['dialect']; encrypted: string; createdAt: string }
export type TableLink = { tableId: string; workspaceId: string; connectionId: string; sourceSchema: string; sourceTable: string; schemaHash: string }
type SourceColumn = { name: string; sourceType: string; type: TableColumnType; primary: number; nullable: boolean; generated: boolean; writable: boolean; hasDefault: boolean }
type Row = Record<string, unknown>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MAX_RECORD_BYTES = 256 * 1024
let active = 0

function key() {
  const secret = process.env.SQL_CONNECTION_KEY || process.env.APP_KEY
  if (!secret || secret.length < 32) throw new HttpError(503, 'Set SQL_CONNECTION_KEY or a persistent APP_KEY before adding SQL connections')
  return createHash('sha256').update(`hopya.sql.v1:${secret}`).digest()
}
function encrypt(config: Configuration, wid: string, cid: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(`${wid}:${cid}`))
  const data = Buffer.concat([cipher.update(JSON.stringify(config)), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}
function decrypt(connection: Connection): Configuration {
  try {
    const bytes = Buffer.from(connection.encrypted, 'base64'), decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
    decipher.setAAD(Buffer.from(`${connection.workspaceId}:${connection.id}`))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return connectionInput.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()))
  } catch { throw new HttpError(503, 'SQL connection could not be decrypted; check the configured key') }
}
const safeConnection = ({ encrypted: _secret, ...metadata }: Connection) => metadata

async function getConnection(wid: string, cid: string): Promise<Connection> {
  const connection = await db.get<Connection>('SELECT id,workspaceId,name,dialect,encrypted,createdAt FROM table_connections WHERE workspaceId=? AND id=?', wid, id.parse(cid))
  if (!connection) throw new HttpError(404, 'SQL connection not found')
  return connection
}

async function lockConnection(wid: string, cid: string) {
  if (db.dialect === 'pg') await db.get('SELECT id FROM table_connections WHERE workspaceId=? AND id=? FOR UPDATE', wid, cid)
  else await db.run('UPDATE table_connections SET name=name WHERE workspaceId=? AND id=?', wid, cid)
  return getConnection(wid, cid)
}

async function clientConfig(config: Configuration): Promise<Knex.Config> {
  if (config.dialect === 'sqlite') {
    if (!process.env.SQL_SQLITE_ROOT) throw new HttpError(503, 'Set SQL_SQLITE_ROOT to enable SQLite connections')
    const root = await realpath(process.env.SQL_SQLITE_ROOT)
    const filename = await realpath(resolve(root, config.filename!))
    const path = relative(root, filename)
    const sourceStat = await stat(filename)
    const appStat = await stat(resolve(dataDir, 'hopya.sqlite')).catch(() => null)
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path) || (appStat && sourceStat.dev === appStat.dev && sourceStat.ino === appStat.ino) || !sourceStat.isFile())
      throw new HttpError(400, 'SQLite files must be existing databases inside SQL_SQLITE_ROOT, separate from Hopya storage')
    return { client: 'better-sqlite3', connection: { filename, options: { safeIntegers: true } }, useNullAsDefault: true,
      pool: { min: 0, max: 1, afterCreate(connection: any, done: (error: unknown, connection: unknown) => void) {
        try { connection.pragma('foreign_keys = ON'); connection.pragma('trusted_schema = OFF'); connection.pragma('busy_timeout = 5000'); done(null, connection) } catch (error) { done(error, connection) }
      } } }
  }
  const port = config.port ?? (config.dialect === 'pg' ? 5432 : 3306)
  const allowed = (process.env.SQL_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase())
  if (!allowed.includes(`${config.host!.toLowerCase()}:${port}`)) throw new HttpError(403, 'SQL destination is not in the operator SQL_ALLOWED_HOSTS list')
  return { client: config.dialect === 'pg' ? 'pg' : 'mysql2',
    connection: { host: config.host, port, database: config.database, user: config.username, password: config.password,
      ...(config.tls ? { ssl: { rejectUnauthorized: true } } : {}),
      ...(config.dialect === 'pg' ? { connectionTimeoutMillis: 5000, statement_timeout: 10000, query_timeout: 12000 }
        : { connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, multipleStatements: false, flags: '-LOCAL_FILES' }),
    }, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 6000 }
}

async function withClient<T>(connection: Connection, work: (client: Knex, config: Configuration) => Promise<T>): Promise<T> {
  if (active >= 4) throw new HttpError(429, 'Too many live SQL operations; try again shortly')
  active++
  let client: Knex | undefined
  try {
    return await runPromiseThrow(Effect.tryPromise({
      try: async () => {
        const config = decrypt(connection)
        client = knex({ ...await clientConfig(config), debug: false, log: { warn() {}, error() {}, deprecate() {}, debug() {} } })
        return work(client, config)
      },
      catch: error => {
        if (error instanceof HttpError) return error
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        const reason: Record<string, string> = {
          ER_BAD_FIELD_ERROR: 'Source schema could not be read', ER_PARSE_ERROR: 'Source SQL syntax is incompatible',
          ER_ACCESS_DENIED_ERROR: 'Source authentication failed', ECONNREFUSED: 'Source connection refused',
          ER_BAD_NULL_ERROR: 'Source column requires a value', ER_DATA_TOO_LONG: 'Value exceeds source column size',
          ER_NO_SUCH_TABLE: 'Source table no longer exists', ER_DUP_ENTRY: 'Value violates source uniqueness',
        }
        return new HttpError(502, `${reason[code] || 'SQL operation failed'}; check connection settings, source permissions, and column constraints`)
      },
    }))
  } finally { try { await client?.destroy() } finally { active-- } }
}

function quote(dialect: Configuration['dialect'], value: string) {
  identifier.parse(value)
  const char = dialect === 'mysql' ? '`' : '"'
  return char + value.replaceAll(char, char + char).replaceAll('?', '\\?') + char
}
const qualified = (dialect: Configuration['dialect'], link: TableLink) =>
  dialect === 'sqlite' ? quote(dialect, link.sourceTable) : `${quote(dialect, link.sourceSchema)}.${quote(dialect, link.sourceTable)}`

const projection = (dialect: Configuration['dialect'], columns: SourceColumn[]) => columns.map(column => {
  const name = quote(dialect, column.name)
  // Driver Date objects truncate PostgreSQL's microseconds, which would hide
  // external changes from the optimistic value revision.
  return dialect === 'pg' && (column.type === 'date' || column.sourceType.startsWith('timestamp')) ? `CAST(${name} AS text) AS ${name}` : name
}).join(',')

async function query(client: Knex | Knex.Transaction, sql: string, bindings: unknown[] = []): Promise<Row[]> {
  const result = await client.raw(sql, bindings as never).timeout(12000)
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result
  return result.rows ?? []
}

async function sourceColumns(client: Knex, config: Configuration, schema: string, table: string): Promise<SourceColumn[]> {
  let rows: Row[]
  if (config.dialect === 'sqlite') {
    if (schema !== 'main') throw new HttpError(400, 'SQLite source schema must be main')
    const exists = await query(client, "SELECT name FROM sqlite_master WHERE type='table' AND name=? AND name NOT LIKE 'sqlite_%'", [table])
    if (!exists.length) throw new HttpError(404, 'Source table not found')
    rows = await query(client, 'SELECT name,type AS source_type,"notnull" AS required,pk AS primary_position,hidden,dflt_value AS column_default FROM pragma_table_xinfo(?) ORDER BY cid', [table])
  } else {
    const relation = await query(client, `SELECT table_type AS kind${config.dialect === 'mysql' ? ',engine AS engine' : ''} FROM information_schema.tables WHERE table_schema=? AND table_name=?`, [schema, table])
    if (!relation.length || relation[0]!.kind !== 'BASE TABLE') throw new HttpError(400, 'Choose a source base table')
    if (config.dialect === 'mysql' && relation[0]!.engine !== 'InnoDB') throw new HttpError(400, 'Live MySQL Tables require the transactional InnoDB engine')
    rows = await query(client, `SELECT c.column_name AS name,c.data_type AS source_type,c.is_nullable AS is_nullable,c.column_default AS column_default,${config.dialect === 'pg' ? 'c.is_generated' : "'NEVER' AS is_generated"},
      ${config.dialect === 'pg' ? 'c.is_identity' : 'c.extra'} AS extra,
      COALESCE(k.ordinal_position,0) AS primary_position
      FROM information_schema.columns c LEFT JOIN (
        SELECT u.table_schema,u.table_name,u.column_name,u.ordinal_position FROM information_schema.key_column_usage u
        JOIN information_schema.table_constraints t ON t.constraint_schema=u.constraint_schema AND t.constraint_name=u.constraint_name AND t.table_name=u.table_name
        WHERE t.constraint_type='PRIMARY KEY'
      ) k ON k.table_schema=c.table_schema AND k.table_name=c.table_name AND k.column_name=c.column_name
      WHERE c.table_schema=? AND c.table_name=? ORDER BY c.ordinal_position`, [schema, table])
  }
  if (!rows.length) throw new HttpError(404, 'Source table not found')
  if (rows.length > 100) throw new HttpError(400, 'Live Tables support at most 100 columns')
  return rows.map(row => {
    const name = identifier.parse(row.name), sourceType = String(row.source_type).toLowerCase()
    const primary = Number(row.primary_position)
    // Exact decimals, big integers and timezone-free timestamps stay strings.
    const boolean = /^(boolean|bool)$/.test(sourceType)
    const number = /^(smallint|integer|int|int2|int4|tinyint|mediumint|real|double precision|float|double)$/.test(sourceType)
    const date = sourceType === 'date', datetime = sourceType === 'timestamp with time zone'
    const text = /^(text|character varying|character|varchar.*|char.*|uuid|bigint|int8|numeric.*|decimal.*|timestamp.*|datetime.*|time.*|enum|tinytext|mediumtext|longtext|)$/.test(sourceType)
    const generated = Boolean(Number(row.hidden)) || row.is_generated === 'ALWAYS' || /generated|auto_increment/i.test(String(row.extra)) || row.extra === 'YES'
    return { name, sourceType, type: boolean ? 'checkbox' : number ? 'number' : date ? 'date' : datetime ? 'datetime' : 'text', primary,
      nullable: !primary && (config.dialect === 'sqlite' ? !row.required : row.is_nullable === 'YES'),
      generated, writable: !generated && !primary && (boolean || number || date || datetime || text), hasDefault: row.column_default != null || generated }
  })
}

function columnId(link: TableLink, column: SourceColumn) { const value = hash([link.tableId, column.name]); return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20, 32)}` }
function columnsFor(link: TableLink, columns: SourceColumn[]): TableColumn[] {
  return columns.map((column, position) => ({ id: columnId(link, column), workspaceId: link.workspaceId, tableId: link.tableId,
    name: column.name, type: column.type, options: [], position, createdAt: '', updatedAt: link.schemaHash,
    readOnly: !column.writable, sourceType: column.sourceType, primaryKey: Boolean(column.primary) }))
}
function normalized(column: SourceColumn, value: unknown): TableValue {
  if (value === null || value === undefined) return null
  if (column.type === 'checkbox') return value === true || value === 1 || value === 1n
  if (value instanceof Date) return column.type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  if (column.type === 'datetime' && typeof value === 'string') return value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new HttpError(422, 'A source number exceeds JavaScript precision; expose it as text in the database')
    return column.type === 'number' ? value : String(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') {
    if (column.type !== 'number') return String(value)
    const number = Number(value)
    if (!Number.isSafeInteger(number)) throw new HttpError(422, 'A source number exceeds JavaScript precision; expose it as text in the database')
    return number
  }
  if (Buffer.isBuffer(value)) return value.toString('base64')
  return JSON.stringify(value)
}
function keyColumns(columns: SourceColumn[]) {
  const keys = columns.filter(column => column.primary).sort((a, b) => a.primary - b.primary)
  if (!keys.length || keys.some(column => !/^(text|character varying|character|varchar.*|char.*|uuid|bigint|int8|numeric.*|decimal.*|smallint|integer|int|int2|int4|tinyint|mediumint|real|double precision|float|double)$/.test(column.sourceType)))
    throw new HttpError(400, 'A live Table requires a text or numeric primary key (composite keys are supported)')
  return keys
}
function rowRecord(link: TableLink, columns: SourceColumn[], row: Row): TableRecord {
  const values = Object.fromEntries(columns.map(column => [columnId(link, column), normalized(column, row[column.name])]))
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_RECORD_BYTES) throw new HttpError(422, 'Source record exceeds the 256 KiB live record limit')
  const key = keyColumns(columns).map(column => normalized(column, row[column.name]))
  const recordId = Buffer.from(JSON.stringify({ scope: hash([link.workspaceId, link.tableId, link.schemaHash]), key })).toString('base64url')
  if (recordId.length > 4096) throw new HttpError(422, 'Source primary key is too large')
  return { id: recordId, workspaceId: link.workspaceId, tableId: link.tableId, values, createdAt: '', updatedAt: hash(values) }
}
function decodeKey(link: TableLink, columns: SourceColumn[], value: string): TableValue[] {
  try {
    const parsed = z.object({ scope: z.literal(hash([link.workspaceId, link.tableId, link.schemaHash])), key: z.array(z.union([z.string().max(2000), z.number().finite()])) }).strict()
      .parse(JSON.parse(Buffer.from(z.string().max(4096).parse(value), 'base64url').toString()))
    if (parsed.key.length !== keyColumns(columns).length || Buffer.from(JSON.stringify(parsed)).toString('base64url') !== value) throw new Error()
    return parsed.key
  } catch { throw new HttpError(400, 'Invalid live record key or cursor') }
}
async function verifySchema(client: Knex, config: Configuration, link: TableLink) {
  const columns = await sourceColumns(client, config, link.sourceSchema, link.sourceTable)
  if (hash(columns) !== link.schemaHash) throw new HttpError(409, 'Source schema changed; reconnect this Table before editing')
  keyColumns(columns)
  return columns
}
async function assertLinkAccess(userId: string, link: TableLink, write = false) {
  await requirePermission(userId, link.workspaceId, 'tables:read')
  if (write) await requirePermission(userId, link.workspaceId, 'tables:write')
  const current = await sqlTables.link(link.workspaceId, link.tableId)
  if (!current || hash(current) !== hash(link)) throw new HttpError(409, 'Live Table connection changed')
}

export const sqlTables = {
  async link(wid: string, tableId: string): Promise<TableLink | undefined> {
    return db.get<TableLink>('SELECT tableId,workspaceId,connectionId,sourceSchema,sourceTable,schemaHash FROM table_links WHERE workspaceId=? AND tableId=?', wid, id.parse(tableId))
  },
  async source(userId: string, wid: string, tableId: string) {
    await requirePermission(userId, wid, 'tables:read')
    if (!await db.get('SELECT id FROM tables WHERE workspaceId=? AND id=?', wid, id.parse(tableId))) throw new HttpError(404, 'Table not found')
    const link = await this.link(wid, tableId)
    if (!link) return null
    const connection = await getConnection(wid, link.connectionId)
    return { dialect: connection.dialect, connectionName: connection.name, schema: link.sourceSchema, table: link.sourceTable }
  },
  async listConnections(userId: string, wid: string) {
    await requirePermission(userId, wid, 'credentials:manage')
    return (await db.all<Connection>('SELECT id,workspaceId,name,dialect,createdAt FROM table_connections WHERE workspaceId=? ORDER BY createdAt,id', wid)).map(safeConnection)
  },
  async createConnection(userId: string, wid: string, input: unknown) {
    await requirePermission(userId, wid, 'credentials:manage')
    const config = connectionInput.parse(input), cid = randomUUID()
    await clientConfig(config)
    const connection: Connection = { id: cid, workspaceId: wid, name: config.name, dialect: config.dialect, encrypted: encrypt(config, wid, cid), createdAt: new Date().toISOString() }
    await withClient(connection, client => query(client, 'SELECT 1'))
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'credentials:manage')
      await db.run('INSERT INTO table_connections(id,workspaceId,name,dialect,encrypted,createdAt) VALUES (@id,@workspaceId,@name,@dialect,@encrypted,@createdAt)', connection)
      await audit(userId, wid, 'table.connection.create', cid, { dialect: config.dialect })
      return safeConnection(connection)
    })
  },
  async deleteConnection(userId: string, wid: string, cid: string) {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'credentials:manage')
      await lockConnection(wid, id.parse(cid))
      if (await db.get('SELECT tableId FROM table_links WHERE workspaceId=? AND connectionId=? LIMIT 1', wid, cid)) throw new HttpError(409, 'Remove linked Hopya Tables before deleting this connection')
      await db.run('DELETE FROM table_connections WHERE workspaceId=? AND id=?', wid, cid)
      await audit(userId, wid, 'table.connection.delete', cid)
      return { success: true }
    })
  },
  async catalog(userId: string, wid: string, cid: string) {
    await requirePermission(userId, wid, 'credentials:manage')
    const result = await withClient(await getConnection(wid, cid), async (client, config) => {
      const rows = config.dialect === 'sqlite'
        ? await query(client, "SELECT 'main' AS schema,name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 501")
        : await query(client, `SELECT table_schema AS ${quote(config.dialect, 'schema')},table_name AS name FROM information_schema.tables WHERE table_type='BASE TABLE' AND ${config.dialect === 'pg' ? "table_schema NOT IN ('pg_catalog','information_schema')" : 'table_schema=?'} ORDER BY table_schema,table_name LIMIT 501`, config.dialect === 'pg' ? [] : [config.database])
      return { tables: rows.slice(0, 500), more: rows.length > 500 }
    })
    await requirePermission(userId, wid, 'credentials:manage')
    return result
  },
  async connect(userId: string, wid: string, input: unknown) {
    await requirePermission(userId, wid, 'credentials:manage')
    await requirePermission(userId, wid, 'tables:read')
    await requirePermission(userId, wid, 'tables:write')
    const data = z.object({ connectionId: id, schema: identifier, table: identifier, name: identifier, parentId: id.nullable().default(null) }).strict().parse(input)
    const connection = await getConnection(wid, data.connectionId)
    const columns = await withClient(connection, (client, config) => sourceColumns(client, config, data.schema, data.table))
    keyColumns(columns)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'credentials:manage')
      await requirePermission(userId, wid, 'tables:read')
      await lockConnection(wid, connection.id)
      const { tableService } = await import('./tables.js')
      const table = await tableService.createTable(userId, wid, { name: data.name, parentId: data.parentId })
      await db.run('INSERT INTO table_links(tableId,workspaceId,connectionId,sourceSchema,sourceTable,schemaHash) VALUES (?,?,?,?,?,?)', table.id, wid, connection.id, data.schema, data.table, hash(columns))
      await audit(userId, wid, 'table.connect', table.id, { connectionId: connection.id, columns: columns.length })
      return table
    })
  },
  async columns(userId: string, link: TableLink) {
    await assertLinkAccess(userId, link)
    const result = await withClient(await getConnection(link.workspaceId, link.connectionId), async (client, config) => columnsFor(link, await verifySchema(client, config, link)))
    await assertLinkAccess(userId, link)
    return result
  },
  async page(userId: string, link: TableLink, input: unknown = {}) {
    const data = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), cursor: z.string().max(4096).optional() }).strict().parse(input)
    return this.readSnapshot(userId, link, async (columns, read) => read(data.limit, data.cursor), undefined)
  },
  async readSnapshot<T>(userId: string, link: TableLink, work: (columns: TableColumn[], read: (limit: number, cursor?: string) => Promise<{ records: TableRecord[]; nextCursor: string | null }>) => Promise<T>, checkpoint?: () => Promise<void>): Promise<T> {
    await assertLinkAccess(userId, link)
    return withClient(await getConnection(link.workspaceId, link.connectionId), async (client, config) => {
      const columns = await verifySchema(client, config, link), keys = keyColumns(columns)
      // Knex joins isolation/read-only characteristics without MySQL's required
      // comma. This request-owned single-connection pool sets read-only separately.
      if (config.dialect === 'mysql') await query(client, 'SET SESSION TRANSACTION READ ONLY')
      return client.transaction(async transaction => {
        const read = async (limit: number, cursor?: string) => {
          await checkpoint?.()
          await assertLinkAccess(userId, link)
          let key = cursor ? decodeKey(link, columns, cursor) : undefined
          const records: TableRecord[] = []
          let bytes = 0
          let more = false
          while (true) {
            const clauses = key ? keys.map((column, index) => `(${keys.slice(0, index).map(prior => `${quote(config.dialect, prior.name)}=?`).concat(`${quote(config.dialect, column.name)}>?`).join(' AND ')})`) : []
            const chunkLimit = Math.min(10, limit + 1 - records.length)
            const rows = await query(transaction, `SELECT ${projection(config.dialect, columns)} FROM ${qualified(config.dialect, link)}${key ? ` WHERE (${clauses.join(' OR ')})` : ''} ORDER BY ${keys.map(column => quote(config.dialect, column.name)).join(',')} LIMIT ?`, [...(key ? keys.flatMap((_, index) => key!.slice(0, index + 1)) : []), chunkLimit])
            for (const row of rows) {
              const record = rowRecord(link, columns, row), size = Buffer.byteLength(JSON.stringify(record))
              if (records.length === limit || (records.length && bytes + size > 2 * 1024 * 1024)) { more = true; break }
              records.push(record); bytes += size
              key = decodeKey(link, columns, record.id)
            }
            if (more || rows.length < chunkLimit) break
            await checkpoint?.()
            await assertLinkAccess(userId, link)
          }
          await assertLinkAccess(userId, link)
          await checkpoint?.()
          return { records, nextCursor: more ? records.at(-1)!.id : null }
        }
        return work(columnsFor(link, columns), read)
      }, config.dialect === 'sqlite' ? undefined : { isolationLevel: 'repeatable read', readOnly: config.dialect === 'pg' })
    })
  },
  async get(userId: string, link: TableLink, recordId: string) {
    await assertLinkAccess(userId, link)
    const result = await withClient(await getConnection(link.workspaceId, link.connectionId), async (client, config) => {
      const columns = await verifySchema(client, config, link), keys = decodeKey(link, columns, recordId)
      const rows = await query(client, `SELECT ${projection(config.dialect, columns)} FROM ${qualified(config.dialect, link)} WHERE ${keyColumns(columns).map(column => `${quote(config.dialect, column.name)}=?`).join(' AND ')} LIMIT 1`, keys)
      if (!rows.length) throw new HttpError(404, 'Source record not found')
      return rowRecord(link, columns, rows[0]!)
    })
    await assertLinkAccess(userId, link)
    return result
  },
  async update(userId: string, link: TableLink, recordId: string, input: unknown) {
    await assertLinkAccess(userId, link, true)
    const data = z.object({ values: z.record(z.string().uuid(), z.union([z.string().max(10000), z.number().finite(), z.boolean(), z.null()]))
      .refine(values => Object.keys(values).length <= 100 && Buffer.byteLength(JSON.stringify(values)) <= MAX_RECORD_BYTES, 'Source update exceeds its column or byte limit'),
    expectedUpdatedAt: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input)
    const operationId = randomUUID()
    // A durable intent precedes the remote transaction. Two independent databases
    // cannot atomically commit; an unresolved intent is never reported as success.
    await db.transaction(async () => {
      await assertLinkAccess(userId, link, true)
      await audit(userId, link.workspaceId, 'table.sql.update.intent', operationId, { tableId: link.tableId })
    })
    const updated = await withClient(await getConnection(link.workspaceId, link.connectionId), async (client, config) => {
      const columns = await verifySchema(client, config, link), keys = decodeKey(link, columns, recordId)
      return client.transaction(async transaction => {
        const where = keyColumns(columns).map(column => `${quote(config.dialect, column.name)}=?`).join(' AND ')
        const rows = await query(transaction, `SELECT ${projection(config.dialect, columns)} FROM ${qualified(config.dialect, link)} WHERE ${where}${config.dialect === 'sqlite' ? '' : ' FOR UPDATE'}`, keys)
        if (!rows.length) throw new HttpError(404, 'Source record not found')
        const previous = rowRecord(link, columns, rows[0]!)
        if (previous.updatedAt !== data.expectedUpdatedAt) throw new HttpError(409, 'Source record changed; reload before saving')
        const known = new Set(columns.map(column => columnId(link, column)))
        if (Object.keys(data.values).some(key => !known.has(key))) throw new HttpError(400, 'Unknown source column')
        const changes: { column: SourceColumn; value: TableValue }[] = []
        for (const column of columns) {
          const cid = columnId(link, column)
          if (!Object.hasOwn(data.values, cid) || data.values[cid] === previous.values[cid]) continue
          const value = data.values[cid]!
          if (!column.writable) throw new HttpError(400, 'Primary keys, generated and unsupported source columns are read-only')
          if (value === null ? !column.nullable : column.type === 'number' ? typeof value !== 'number' : column.type === 'checkbox' ? typeof value !== 'boolean' : typeof value !== 'string')
            throw new HttpError(400, 'Invalid source column value')
          if (value !== null && (column.type === 'date' ? !dateSchema.safeParse(value).success : column.type === 'datetime' && !z.string().datetime({ offset: true }).safeParse(value).success))
            throw new HttpError(400, 'Invalid source date value')
          changes.push({ column, value })
        }
        await assertLinkAccess(userId, link, true)
        if (changes.length) await query(transaction, `UPDATE ${qualified(config.dialect, link)} SET ${changes.map(change => `${quote(config.dialect, change.column.name)}=?`).join(',')} WHERE ${where}`, [...changes.map(change => change.value), ...keys])
        const fresh = await query(transaction, `SELECT ${projection(config.dialect, columns)} FROM ${qualified(config.dialect, link)} WHERE ${where}`, keys)
        if (!fresh.length) throw new HttpError(409, 'Source trigger removed or changed the primary key; reload the table')
        await assertLinkAccess(userId, link, true)
        return rowRecord(link, columns, fresh[0]!)
      })
    })
    try { await db.transaction(async () => { await audit(userId, link.workspaceId, 'table.sql.update.applied', operationId, { tableId: link.tableId }) }) }
    catch { throw new HttpError(503, 'Source update committed but audit completion failed; reload before making further changes') }
    await assertLinkAccess(userId, link)
    return updated
  },
}
