import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import knex from 'knex'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-sql-'))
process.env.DATA_DIR = join(directory, 'app')
process.env.SQL_SQLITE_ROOT = directory
process.env.SQL_CONNECTION_KEY = randomBytes(32).toString('hex')
const dialect = (process.env.TEST_SQL_DIALECT || 'sqlite') as 'sqlite' | 'pg' | 'mysql'
const port = Number(process.env.TEST_SQL_PORT || (dialect === 'pg' ? 5432 : 3306))
process.env.SQL_ALLOWED_HOSTS = `127.0.0.1:${port}`
const remoteConfig = dialect === 'sqlite' ? { client: 'better-sqlite3', connection: { filename: join(directory, 'source.sqlite') }, useNullAsDefault: true }
  : { client: dialect === 'pg' ? 'pg' : 'mysql2', connection: { host: '127.0.0.1', port, database: 'hopya_test', user: 'hopya_test', password: process.env.TEST_SQL_PASSWORD } }
const source = knex(remoteConfig)
await migrateDatabase()
const { db, service, HttpError } = await import('../app/core.js')
const { tableService } = await import('../app/tables.js')
const { sqlTables } = await import('../app/table_sql.js')
const { summarizeTable } = await import('../app/table_summary.js')
const { queryTable } = await import('../app/table_query.js')
after(async () => { await source.destroy(); await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })
const denied = (operation: () => Promise<unknown>, status = 403) => assert.rejects(operation, (error: unknown) => error instanceof HttpError && error.status === status)
const user = async () => {
  const id = randomUUID()
  await db.run('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)', id, 'Reviewer', `${id}@example.test`, new Date().toISOString())
  return id
}

test('live SQL writes reach the source with stale-write, permission, secret and schema protections', async () => {
  const tableName = `inventory_${randomBytes(4).toString('hex')}`
  await source.schema.createTable(tableName, table => {
    table.integer('tenant').notNullable(); table.integer('id').notNullable(); table.primary(['tenant', 'id'])
    table.text('description'); table.integer('quantity'); table.boolean('active')
    if (dialect === 'pg') table.timestamp('observed', { useTz: true, precision: 6 })
  })
  try {
    await source(tableName).insert([{ tenant: 1, id: 1, description: 'Private source value', quantity: 4, active: true }, { tenant: 1, id: 2, description: 'Second', quantity: 7, active: false }, { tenant: 2, id: 1, description: 'Third', quantity: 8, active: null }])
    const owner = await user(), outsider = await user(), reader = await user()
    const workspace = await service.createWorkspace(owner, { name: 'SQL workspace' }), wid = workspace.id
    const connection = await sqlTables.createConnection(owner, wid, { name: 'Inventory DB', dialect,
      ...(dialect === 'sqlite' ? { filename: 'source.sqlite' } : { host: '127.0.0.1', port, database: 'hopya_test', username: 'hopya_test', password: process.env.TEST_SQL_PASSWORD, tls: false }) })
    assert.equal('encrypted' in connection || 'password' in connection || 'filename' in connection, false)
    const stored = await db.get<{ encrypted: string }>('SELECT encrypted FROM table_connections WHERE id=?', connection.id)
    assert.ok(stored?.encrypted); assert.equal(stored.encrypted.includes('source.sqlite'), false)
    const catalog = await sqlTables.catalog(owner, wid, connection.id)
    assert.ok(catalog.tables.some(table => table.name === tableName))
    const schema = dialect === 'sqlite' ? 'main' : dialect === 'pg' ? 'public' : 'hopya_test'
    const table = await sqlTables.connect(owner, wid, { connectionId: connection.id, schema, table: tableName, name: 'Live inventory' })
    const other = await sqlTables.connect(owner, wid, { connectionId: connection.id, schema, table: tableName, name: 'Second link' })
    const columns = await tableService.listColumns(owner, wid, table.id)
    const description = columns.find(column => column.name === 'description')!, quantity = columns.find(column => column.name === 'quantity')!
    assert.equal(columns.find(column => column.name === 'id')!.readOnly, true)
    const first = await tableService.pageRecords(owner, wid, table.id, { limit: 1 })
    assert.equal(first.records[0]!.values[description.id], 'Private source value')
    const next = await tableService.pageRecords(owner, wid, table.id, { limit: 1, cursor: first.nextCursor! })
    assert.equal(next.records[0]!.values[description.id], 'Second')
    const third = await tableService.pageRecords(owner, wid, table.id, { limit: 1, cursor: next.nextCursor! })
    assert.equal(third.records[0]!.values[description.id], 'Third'); assert.equal(third.nextCursor, null)
    await denied(() => tableService.pageRecords(owner, wid, other.id, { cursor: first.nextCursor! }), 400)
    const record = first.records[0]!
    const update = { values: { ...record.values, [description.id]: 'Written through Hopya' }, expectedUpdatedAt: record.updatedAt }
    const role = await service.createRole(owner, wid, { name: 'SQL reader', permissions: ['tables:read'] })
    await service.addMember(owner, wid, { email: `${reader}@example.test`, roleId: role.id })
    const summary = await summarizeTable(reader, wid, table.id)
    assert.equal(summary.recordCount, 3)
    assert.equal(summary.columns[quantity.id]!.sum, 19, 'Live calculations include every source row, not the requested grid page')
    const query = { filters: [{ columnId: quantity.id, operator: 'gte', value: 7 }], sort: { columnId: quantity.id, direction: 'desc' }, limit: 1, summary: true }
    const ordered = await queryTable(reader, wid, table.id, query)
    assert.equal(ordered.records[0]!.values[quantity.id], 8)
    assert.equal(ordered.total, 2); assert.equal(ordered.summary!.columns[quantity.id]!.sum, 15)
    const orderedNext = await queryTable(reader, wid, table.id, { ...query, cursor: ordered.nextCursor })
    assert.equal(orderedNext.records[0]!.values[quantity.id], 7); assert.equal(orderedNext.nextCursor, null)
    const natural = await queryTable(reader, wid, table.id, { filters: [{ columnId: description.id, operator: 'not_empty' }] })
    assert.deepEqual(natural.records.map(record => record.id), [first.records[0]!.id, next.records[0]!.id, third.records[0]!.id], 'Filtering without ordering preserves composite source-key order')
    await denied(() => tableService.updateRecord(reader, wid, table.id, record.id, update))
    await denied(() => sqlTables.listConnections(reader, wid))
    await denied(() => sqlTables.catalog(outsider, wid, connection.id))
    await denied(() => tableService.getRecord(outsider, wid, table.id, record.id))
    const updated = await tableService.updateRecord(owner, wid, table.id, record.id, update)
    assert.equal((await source(tableName).where({ tenant: 1, id: 1 }).first()).description, 'Written through Hopya')
    await denied(() => tableService.updateRecord(owner, wid, table.id, record.id, update), 409)
    await source(tableName).where({ tenant: 1, id: 1 }).update({ quantity: 99 })
    await denied(() => tableService.updateRecord(owner, wid, table.id, record.id, { ...update, expectedUpdatedAt: updated.updatedAt }), 409)
    const fresh = await tableService.getRecord(owner, wid, table.id, record.id)
    assert.equal(fresh.values[quantity.id], 99)
    assert.equal((await summarizeTable(reader, wid, table.id)).columns[quantity.id]!.sum, 114, 'External writes appear on the next calculation')
    await denied(() => tableService.updateRecord(owner, wid, table.id, record.id, { values: { ...fresh.values, [columns.find(column => column.name === 'id')!.id]: 900 }, expectedUpdatedAt: fresh.updatedAt }), 400)
    await tableService.updateRecord(owner, wid, table.id, record.id, { values: { ...fresh.values, [description.id]: null }, expectedUpdatedAt: fresh.updatedAt })
    assert.equal((await source(tableName).where({ tenant: 1, id: 1 }).first()).description, null)
    if (dialect === 'pg') {
      await source(tableName).where({ tenant: 1, id: 1 }).update({ observed: '2026-10-02T12:00:00.123456Z' })
      const precise = await tableService.getRecord(owner, wid, table.id, record.id)
      await source(tableName).where({ tenant: 1, id: 1 }).update({ observed: '2026-10-02T12:00:00.123457Z' })
      await denied(() => tableService.updateRecord(owner, wid, table.id, record.id, { values: { [description.id]: 'stale microsecond' }, expectedUpdatedAt: precise.updatedAt }), 409)
    }
    await denied(() => sqlTables.deleteConnection(owner, wid, connection.id), 409)
    const exported = await service.exportWorkspace(owner, wid)
    assert.equal(exported.tableSources.length, 2)
    assert.equal(JSON.stringify(exported).includes('encrypted'), false)
    const audits = JSON.stringify(await db.all('SELECT details FROM audit_logs WHERE workspaceId=?', wid))
    assert.equal(audits.includes('Written through Hopya') || audits.includes('Private source value'), false)
    assert.equal(Number((await db.get<{ count: number }>("SELECT count(*) AS count FROM audit_logs WHERE workspaceId=? AND action='table.sql.update.applied'", wid))!.count), 2)
    if (dialect === 'sqlite') {
      await source(tableName).where({ tenant: 1, id: 1 }).update({ quantity: 'invalid source number' })
      await denied(() => queryTable(owner, wid, table.id, { sort: { columnId: quantity.id, direction: 'asc' } }), 422)
      await source(tableName).where({ tenant: 1, id: 1 }).update({ quantity: 99 })
    }
    await source.schema.alterTable(tableName, table => { table.text('new_column') })
    await denied(() => tableService.pageRecords(owner, wid, table.id), 409)
    await denied(() => summarizeTable(owner, wid, table.id), 409)
    await tableService.deleteTable(owner, wid, table.id)
    await tableService.deleteTable(owner, wid, other.id)
    await sqlTables.deleteConnection(owner, wid, connection.id)
    assert.equal((await source(tableName)).length, 3, 'Removing a Hopya link preserves its source table')
    const workspaceConnection = await sqlTables.createConnection(owner, wid, { name: 'Cascade', dialect,
      ...(dialect === 'sqlite' ? { filename: 'source.sqlite' } : { host: '127.0.0.1', port, database: 'hopya_test', username: 'hopya_test', password: process.env.TEST_SQL_PASSWORD, tls: false }) })
    await sqlTables.connect(owner, wid, { connectionId: workspaceConnection.id, schema, table: tableName, name: 'Cascade link' })
    await service.deleteWorkspace(owner, wid)
    assert.equal((await source(tableName)).length, 3, 'Workspace deletion removes links, never source data')
  } finally { await source.schema.dropTableIfExists(tableName) }
})

test('SQL connections require explicit network/filesystem scope and audit before write-back', async () => {
  const owner = await user(), { id: wid } = await service.createWorkspace(owner, { name: 'Boundaries' })
  await denied(() => sqlTables.createConnection(owner, wid, { name: 'Denied host', dialect: 'pg', host: 'unapproved.example', database: 'data', username: 'user', password: 'secret', tls: false }), 403)
  if (dialect !== 'sqlite') return
  symlinkSync(join(directory, 'app', 'hopya.sqlite'), join(directory, 'app-link.sqlite'))
  await denied(() => sqlTables.createConnection(owner, wid, { name: 'App DB', dialect: 'sqlite', filename: 'app-link.sqlite' }), 400)
  const connection = await sqlTables.createConnection(owner, wid, { name: 'Source', dialect: 'sqlite', filename: 'source.sqlite' })
  await source.schema.createTable('audit_guard', table => { table.integer('id').primary(); table.text('value') })
  await source('audit_guard').insert({ id: 1, value: 'unchanged' })
  const table = await sqlTables.connect(owner, wid, { connectionId: connection.id, schema: 'main', table: 'audit_guard', name: 'Guard' })
  const column = (await tableService.listColumns(owner, wid, table.id)).find(column => column.name === 'value')!
  const record = (await tableService.pageRecords(owner, wid, table.id)).records[0]!
  await db.run("CREATE TRIGGER fail_sql_intent BEFORE INSERT ON audit_logs WHEN NEW.action='table.sql.update.intent' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  try {
    await assert.rejects(() => tableService.updateRecord(owner, wid, table.id, record.id, { values: { [column.id]: 'should not write' }, expectedUpdatedAt: record.updatedAt }), /audit unavailable/)
    assert.equal((await source('audit_guard').first()).value, 'unchanged')
  } finally { await db.run('DROP TRIGGER fail_sql_intent') }
})
