import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-tables-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { db, service, HttpError } = await import('../app/core.js')
const { tableService } = await import('../app/tables.js')
const { summarizeTable } = await import('../app/table_summary.js')
const { queryTable } = await import('../app/table_query.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

const denied = (operation: () => Promise<unknown>, status = 403) => assert.rejects(operation, (error: unknown) => error instanceof HttpError && error.status === status)
const createUser = async (name = 'Table user') => {
  const id = randomUUID()
  await db.run('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)', id, name, `${id}@example.test`, new Date().toISOString())
  return id
}

async function fixture() {
  const owner = await createUser('Owner')
  const workspace = await service.createWorkspace(owner, { name: 'Tables' })
  const project = await service.createNode(owner, workspace.id, { name: 'Project', kind: 'project' })
  const folder = await service.createNode(owner, workspace.id, { name: 'Folder', kind: 'folder', parentId: project.id })
  const list = await service.createNode(owner, workspace.id, { name: 'List', kind: 'list', parentId: folder.id })
  return { owner, wid: workspace.id, project, folder, list }
}

test('table records are typed, revision checked, replaced wholesale, and cleaned when a column is deleted', async () => {
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Private inventory', parentId: f.folder.id, icon: 'star', color: 'blue' })
  assert.equal(table.color, '#2563a6')
  await assert.rejects(() => tableService.createTable(f.owner, f.wid, { name: 'Invalid appearance', icon: '<svg />' }), /Invalid enum/)
  await assert.rejects(() => tableService.updateTable(f.owner, f.wid, table.id, { color: 'red;display:none', expectedUpdatedAt: table.updatedAt }))
  const styled = await tableService.updateTable(f.owner, f.wid, table.id, { icon: 'calendar', color: '#AABBCC', expectedUpdatedAt: table.updatedAt })
  assert.equal(styled.name, table.name)
  assert.equal(styled.color, '#aabbcc')
  assert.equal((await tableService.getTable(f.owner, f.wid, table.id)).icon, 'calendar')
  assert.equal((await service.getWorkspace(f.owner, f.wid)).tables.find(entry => entry.id === table.id)?.icon, 'calendar')
  const text = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Private text', type: 'text' })
  const number = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Quantity', type: 'number' })
  const date = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Date', type: 'date' })
  const datetime = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Time', type: 'datetime' })
  const checkbox = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Active', type: 'checkbox' })
  const select = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'State', type: 'select', options: ['Ready', 'Used'] })
  await denied(() => tableService.createColumn(f.owner, f.wid, table.id, { name: 'Invalid options', type: 'text', options: ['No'] }), 400)
  await assert.rejects(() => tableService.createColumn(f.owner, f.wid, table.id, { name: 'Duplicate options', type: 'select', options: ['Same', 'Same'] }))

  const record = await tableService.createRecord(f.owner, f.wid, table.id, { values: {
    [text.id]: 'private record value', [number.id]: 4.5, [date.id]: '2026-09-18',
    [datetime.id]: '2026-09-18T08:30:00+08:00', [checkbox.id]: true, [select.id]: 'Ready',
  } })
  assert.equal(record.values[number.id], 4.5)
  await denied(() => tableService.createRecord(f.owner, f.wid, table.id, { values: { [randomUUID()]: 'unknown' } }), 400)
  await denied(() => tableService.createRecord(f.owner, f.wid, table.id, { values: { [number.id]: '4' } }), 400)
  await denied(() => tableService.createRecord(f.owner, f.wid, table.id, { values: { [text.id]: 'x'.repeat(10001) } }), 400)
  await denied(() => tableService.createRecord(f.owner, f.wid, table.id, { values: { [date.id]: '2026-02-30' } }), 400)
  await denied(() => tableService.createRecord(f.owner, f.wid, table.id, { values: { [select.id]: 'Missing' } }), 400)
  await denied(() => tableService.createRecord(f.owner, f.wid, table.id, { values: { [text.id]: '界'.repeat(100000) } }), 400)

  const replaced = await tableService.updateRecord(f.owner, f.wid, table.id, record.id, { values: { [text.id]: null, [select.id]: 'Used' }, expectedUpdatedAt: record.updatedAt })
  assert.deepEqual(replaced.values, { [text.id]: null, [select.id]: 'Used' })
  await denied(() => tableService.updateRecord(f.owner, f.wid, table.id, record.id, { values: {}, expectedUpdatedAt: record.updatedAt }), 409)
  const renamed = await tableService.renameColumn(f.owner, f.wid, table.id, select.id, { name: 'Condition', expectedUpdatedAt: select.updatedAt })
  await denied(() => tableService.renameColumn(f.owner, f.wid, table.id, select.id, { name: 'Stale', expectedUpdatedAt: select.updatedAt }), 409)
  assert.equal(renamed.name, 'Condition')
  assert.deepEqual(await tableService.deleteColumn(f.owner, f.wid, table.id, select.id), { success: true, touchedRecords: 1 })
  const cleaned = await tableService.getRecord(f.owner, f.wid, table.id, record.id)
  assert.deepEqual(cleaned.values, { [text.id]: null })
  assert.notEqual(cleaned.updatedAt, replaced.updatedAt)

  const moved = await tableService.updateTable(f.owner, f.wid, table.id, { name: 'Renamed inventory', parentId: f.project.id, expectedUpdatedAt: styled.updatedAt })
  await denied(() => tableService.updateTable(f.owner, f.wid, table.id, { icon: 'heart', expectedUpdatedAt: table.updatedAt }), 409)
  assert.equal(moved.parentId, f.project.id)
  const exported = await service.exportWorkspace(f.owner, f.wid)
  assert.equal(exported.version, 8)
  assert.deepEqual(exported.tables.map((entry) => entry.id), [table.id])
  assert.deepEqual([exported.tables[0].icon, exported.tables[0].color], ['calendar', '#aabbcc'])
  assert.ok(exported.tableColumns.some((entry) => entry.id === text.id && Array.isArray(entry.options)))
  assert.deepEqual(exported.tableRecords.find((entry) => entry.id === record.id)?.values, { [text.id]: null })
  const tableAudits = await db.all<{ details: string }>("SELECT details FROM audit_logs WHERE workspaceId=? AND action LIKE 'table.%'", f.wid)
  const serialized = JSON.stringify(tableAudits)
  for (const privateValue of ['Private inventory', 'Private text', 'private record value', 'Renamed inventory', 'Condition']) assert.equal(serialized.includes(privateValue), false)
  const cleared = await tableService.updateTable(f.owner, f.wid, table.id, { icon: null, color: null, expectedUpdatedAt: moved.updatedAt })
  assert.equal(cleared.icon, null)
  assert.equal(cleared.color, null)
})

test('table hierarchy, workspace, permission, depth, and cursor boundaries fail closed', async () => {
  const f = await fixture()
  const other = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Scoped table', parentId: f.folder.id })
  const column = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Value', type: 'text' })
  const first = await tableService.createRecord(f.owner, f.wid, table.id, { values: { [column.id]: 'one' } })
  const second = await tableService.createRecord(f.owner, f.wid, table.id, { values: { [column.id]: 'two' } })
  const secondTable = await tableService.createTable(f.owner, f.wid, { name: 'Second' })
  await denied(() => tableService.createTable(f.owner, f.wid, { name: 'Cross workspace', parentId: other.project.id }), 404)
  await denied(() => tableService.createTable(f.owner, f.wid, { name: 'Inside list', parentId: f.list.id }), 400)
  await denied(() => tableService.getTable(other.owner, other.wid, table.id), 404)
  await denied(() => tableService.updateTable(other.owner, other.wid, table.id, { icon: 'heart', expectedUpdatedAt: table.updatedAt }), 404)
  await denied(() => summarizeTable(other.owner, other.wid, table.id), 404)
  await denied(() => queryTable(other.owner, other.wid, table.id, {}), 404)
  await denied(() => tableService.getRecord(f.owner, f.wid, secondTable.id, first.id), 404)
  await denied(() => service.deleteNode(f.owner, f.wid, f.folder.id), 409)

  const reader = await createUser('Reader')
  const readerRole = await service.createRole(f.owner, f.wid, { name: 'Table reader', permissions: ['tables:read'] })
  await service.addMember(f.owner, f.wid, { email: `${reader}@example.test`, roleId: readerRole.id })
  assert.equal((await service.getWorkspace(reader, f.wid)).tables.length, 2)
  assert.ok((await service.listNodes(reader, f.wid)).some((node) => node.id === f.folder.id))
  assert.equal((await tableService.pageRecords(reader, f.wid, table.id)).records.length, 2)
  await denied(() => tableService.createRecord(reader, f.wid, table.id, { values: {} }))
  await denied(() => tableService.updateTable(reader, f.wid, table.id, { icon: 'heart', expectedUpdatedAt: table.updatedAt }))

  const writer = await createUser('Writer')
  const writerRole = await service.createRole(f.owner, f.wid, { name: 'Table writer', permissions: ['tables:write'] })
  await service.addMember(f.owner, f.wid, { email: `${writer}@example.test`, roleId: writerRole.id })
  assert.equal((await service.getWorkspace(writer, f.wid)).tables.length, 2)
  assert.ok((await service.listNodes(writer, f.wid)).length > 0)
  await denied(() => tableService.getRecord(writer, f.wid, table.id, first.id))
  await denied(() => tableService.updateTable(writer, f.wid, table.id, { icon: 'heart', expectedUpdatedAt: table.updatedAt }))
  await denied(() => summarizeTable(writer, f.wid, table.id))
  await denied(() => queryTable(writer, f.wid, table.id, {}))
  await denied(() => tableService.deleteColumn(writer, f.wid, table.id, column.id))
  assert.ok(await tableService.createColumn(writer, f.wid, secondTable.id, { name: 'Blind column', type: 'text' }))
  await denied(() => tableService.listColumns(writer, f.wid, secondTable.id))
  assert.ok(await tableService.createRecord(writer, f.wid, secondTable.id, { values: {} }))

  const deleter = await createUser('Deleter')
  const deleterRole = await service.createRole(f.owner, f.wid, { name: 'Table deleter', permissions: ['tables:delete'] })
  await service.addMember(f.owner, f.wid, { email: `${deleter}@example.test`, roleId: deleterRole.id })
  assert.equal((await service.getWorkspace(deleter, f.wid)).tables.length, 2)
  assert.ok((await service.listNodes(deleter, f.wid)).some((node) => node.id === f.folder.id))
  await denied(() => tableService.pageRecords(deleter, f.wid, table.id))

  const taskReader = await createUser('Task reader')
  const taskRole = await service.createRole(f.owner, f.wid, { name: 'Task reader', permissions: ['items:read'] })
  await service.addMember(f.owner, f.wid, { email: `${taskReader}@example.test`, roleId: taskRole.id })
  assert.deepEqual((await service.getWorkspace(taskReader, f.wid)).tables, [])
  const taskExport = await service.exportWorkspace(taskReader, f.wid)
  assert.deepEqual([taskExport.tables, taskExport.tableColumns, taskExport.tableRecords], [[], [], []])

  const page = await tableService.pageRecords(f.owner, f.wid, table.id, { limit: 1 })
  assert.equal(page.records.length, 1)
  assert.ok(page.nextCursor)
  const next = await tableService.pageRecords(f.owner, f.wid, table.id, { limit: 1, cursor: page.nextCursor! })
  assert.equal(next.records.length, 1)
  assert.deepEqual(new Set([...page.records, ...next.records].map((record) => record.id)), new Set([first.id, second.id]))
  await denied(() => tableService.pageRecords(f.owner, f.wid, secondTable.id, { cursor: page.nextCursor! }), 400)

  const destination = await service.createNode(f.owner, f.wid, { name: 'Destination', kind: 'project' })
  let destinationParent = destination
  const destinationParents = [destination]
  for (let depth = 1; depth <= 30; depth++) {
    destinationParent = await service.createNode(f.owner, f.wid, { name: `Depth ${depth}`, kind: 'folder', parentId: destinationParent.id })
    destinationParents.push(destinationParent)
  }
  const moving = await service.createNode(f.owner, f.wid, { name: 'Moving', kind: 'folder', parentId: f.project.id })
  const leaf = await tableService.createTable(f.owner, f.wid, { name: 'Depth leaf', parentId: moving.id })
  const leafRecord = await tableService.createRecord(f.owner, f.wid, leaf.id, { values: {} })
  // A level-31 parent would put the folder at 32 and its Table at 33.
  await denied(() => service.updateNode(f.owner, f.wid, moving.id, { parentId: destinationParent.id, expectedParentId: f.project.id }), 400)
  assert.equal((await service.listNodes(f.owner, f.wid)).find(node => node.id === moving.id)!.parentId, f.project.id)
  await service.updateNode(f.owner, f.wid, moving.id, { parentId: destinationParents[29]!.id, expectedParentId: f.project.id })
  assert.equal((await tableService.updateTable(f.owner, f.wid, leaf.id, { name: 'Still editable at level 32', expectedUpdatedAt: leaf.updatedAt })).name, 'Still editable at level 32')
  assert.deepEqual(await tableService.getRecord(f.owner, f.wid, leaf.id, leafRecord.id), leafRecord)
})

test('table deletion cascades only after its count-only audit succeeds', async () => {
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Delete safely' })
  const column = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Secret column', type: 'text' })
  await tableService.createRecord(f.owner, f.wid, table.id, { values: { [column.id]: 'secret value' } })
  if (db.dialect === 'pg') {
    await db.run("CREATE FUNCTION fail_table_delete_audit() RETURNS trigger AS 'BEGIN IF NEW.action = ''table.delete'' THEN RAISE EXCEPTION ''audit unavailable''; END IF; RETURN NEW; END' LANGUAGE plpgsql")
    await db.run('CREATE TRIGGER fail_table_delete_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_table_delete_audit()')
  } else {
    await db.run("CREATE TRIGGER fail_table_delete_audit BEFORE INSERT ON audit_logs WHEN NEW.action='table.delete' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  }
  try { await assert.rejects(() => tableService.deleteTable(f.owner, f.wid, table.id), /audit unavailable/) }
  finally {
    await db.run(db.dialect === 'pg' ? 'DROP TRIGGER fail_table_delete_audit ON audit_logs' : 'DROP TRIGGER fail_table_delete_audit')
    if (db.dialect === 'pg') await db.run('DROP FUNCTION fail_table_delete_audit()')
  }
  assert.ok(await db.get('SELECT id FROM tables WHERE workspaceId=? AND id=?', f.wid, table.id))
  assert.equal(Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM table_records WHERE workspaceId=? AND tableId=?', f.wid, table.id))?.count), 1)

  assert.deepEqual(await tableService.deleteTable(f.owner, f.wid, table.id), { success: true })
  for (const relation of ['tables', 'table_columns', 'table_records']) {
    assert.equal(Number((await db.get<{ count: number | string }>(`SELECT count(*) AS count FROM ${relation} WHERE workspaceId=?`, f.wid))?.count), 0)
  }
  const audit = await db.get<{ details: string }>("SELECT details FROM audit_logs WHERE workspaceId=? AND action='table.delete'", f.wid)
  assert.deepEqual(JSON.parse(audit!.details), { columns: 1, records: 1 })
  assert.equal(audit!.details.includes('Secret column') || audit!.details.includes('secret value'), false)
})

test('column deletion rolls record cleanup back when its audit fails', async () => {
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Rollback cleanup' })
  const column = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Secret column', type: 'text' })
  const record = await tableService.createRecord(f.owner, f.wid, table.id, { values: { [column.id]: 'secret value' } })
  if (db.dialect === 'pg') {
    await db.run("CREATE FUNCTION fail_column_delete_audit() RETURNS trigger AS 'BEGIN IF NEW.action = ''table.column.delete'' THEN RAISE EXCEPTION ''audit unavailable''; END IF; RETURN NEW; END' LANGUAGE plpgsql")
    await db.run('CREATE TRIGGER fail_column_delete_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_column_delete_audit()')
  } else {
    await db.run("CREATE TRIGGER fail_column_delete_audit BEFORE INSERT ON audit_logs WHEN NEW.action='table.column.delete' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  }
  try { await assert.rejects(() => tableService.deleteColumn(f.owner, f.wid, table.id, column.id), /audit unavailable/) }
  finally {
    await db.run(db.dialect === 'pg' ? 'DROP TRIGGER fail_column_delete_audit ON audit_logs' : 'DROP TRIGGER fail_column_delete_audit')
    if (db.dialect === 'pg') await db.run('DROP FUNCTION fail_column_delete_audit()')
  }
  assert.ok(await db.get('SELECT id FROM table_columns WHERE workspaceId=? AND tableId=? AND id=?', f.wid, table.id, column.id))
  assert.deepEqual((await tableService.getRecord(f.owner, f.wid, table.id, record.id)).values, { [column.id]: 'secret value' })
})

test('table record pages enforce an encoded byte budget without losing cursor progress', async () => {
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Bounded records' })
  const column = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Payload', type: 'text' })
  for (let index = 0; index < 220; index++) {
    await tableService.createRecord(f.owner, f.wid, table.id, { values: { [column.id]: `${index}`.padEnd(10000, 'x') } })
  }

  const first = await tableService.pageRecords(f.owner, f.wid, table.id, { limit: 500 })
  assert.ok(first.records.length > 0 && first.records.length < 220)
  assert.ok(first.nextCursor)
  const seen = new Set(first.records.map((record) => record.id))
  let cursor: string | null = first.nextCursor
  while (cursor) {
    const page = await tableService.pageRecords(f.owner, f.wid, table.id, { limit: 500, cursor })
    for (const record of page.records) {
      assert.equal(seen.has(record.id), false)
      seen.add(record.id)
    }
    cursor = page.nextCursor
  }
  assert.equal(seen.size, 220)

  const ordered: string[] = []
  cursor = null
  do {
    const page = await queryTable(f.owner, f.wid, table.id, { sort: { columnId: column.id, direction: 'desc' }, limit: 500, ...(cursor ? { cursor } : {}) })
    assert.ok(Buffer.byteLength(JSON.stringify(page.records)) < 2 * 1024 * 1024)
    assert.equal(page.total, 220)
    ordered.push(...page.records.map(record => record.values[column.id] as string))
    cursor = page.nextCursor
  } while (cursor)
  assert.deepEqual(ordered, Array.from({ length: 220 }, (_, index) => `${index}`.padEnd(10000, 'x')).sort().reverse(), 'Sorted byte-bounded pages preserve every row across chunks')
})

test('Table ordering and AND filters use typed values, stable ties and filter-bound cursor positions', async () => {
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Filtered inventory' })
  const text = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Name', type: 'text' })
  const number = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Amount', type: 'number' })
  const checkbox = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Active', type: 'checkbox' })
  const date = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Observed', type: 'datetime' })
  const early = '2026-10-02T08:00:00.123456+08:00', later = '2026-10-02T00:00:00.123457Z'
  const rows = []
  for (const values of [
    { [text.id]: 'Alpha', [number.id]: 10, [checkbox.id]: false, [date.id]: later },
    { [text.id]: 'alpha', [number.id]: -2, [checkbox.id]: true, [date.id]: early },
    { [text.id]: 'beta', [number.id]: 0, [checkbox.id]: false },
    { [text.id]: 'ALPHA', [number.id]: 10, [checkbox.id]: false },
    { [text.id]: '', [number.id]: null, [checkbox.id]: null }, {},
  ]) rows.push(await tableService.createRecord(f.owner, f.wid, table.id, { values }))
  const sort = { columnId: number.id, direction: 'desc' }
  const filters = [{ columnId: text.id, operator: 'contains', value: 'aLpHa' }, { columnId: checkbox.id, operator: 'is', value: false }]
  const first = await queryTable(f.owner, f.wid, table.id, { filters, sort, limit: 1, summary: true })
  assert.equal(first.total, 2); assert.equal(first.summary!.columns[number.id]!.sum, 20)
  const next = await queryTable(f.owner, f.wid, table.id, { filters, sort, limit: 1, cursor: first.nextCursor })
  assert.equal(next.nextCursor, null)
  assert.deepEqual(new Set([...first.records, ...next.records].map(record => record.id)), new Set([rows[0]!.id, rows[3]!.id]), 'Equal values do not duplicate or skip records')
  await denied(() => queryTable(f.owner, f.wid, table.id, { filters: [], sort, cursor: first.nextCursor }), 400)
  await denied(() => queryTable(f.owner, f.wid, table.id, { filters, sort: { ...sort, direction: 'asc' }, cursor: first.nextCursor }), 400)
  const other = await tableService.createTable(f.owner, f.wid, { name: 'Other' })
  await denied(() => queryTable(f.owner, f.wid, other.id, { filters, sort, cursor: first.nextCursor }), 400)
  const unfiltered = await queryTable(f.owner, f.wid, table.id, { limit: 1 })
  await denied(() => queryTable(f.owner, f.wid, other.id, { cursor: unfiltered.nextCursor }), 400)
  await denied(() => queryTable(f.owner, f.wid, table.id, { sort: { columnId: randomUUID(), direction: 'asc' } }), 400)
  await denied(() => queryTable(f.owner, f.wid, table.id, { filters: [{ columnId: number.id, operator: 'contains', value: '1' }] }), 400)
  await denied(() => queryTable(f.owner, f.wid, table.id, { filters: [{ columnId: number.id, operator: 'is', value: '10' }] }), 400)
  assert.deepEqual((await queryTable(f.owner, f.wid, table.id, { sort })).records.map(record => record.values[number.id] ?? null), [10, 10, 0, -2, null, null])
  assert.equal((await queryTable(f.owner, f.wid, table.id, { filters: [{ columnId: number.id, operator: 'gte', value: 0 }] })).total, 3)
  assert.equal((await queryTable(f.owner, f.wid, table.id, { filters: [{ columnId: text.id, operator: 'empty' }] })).total, 2)
  const dates = await queryTable(f.owner, f.wid, table.id, { sort: { columnId: date.id, direction: 'asc' }, filters: [{ columnId: date.id, operator: 'not_empty' }] })
  assert.deepEqual(dates.records.map(record => record.values[date.id]), [early, later])
  assert.equal((await queryTable(f.owner, f.wid, table.id, { filters: [{ columnId: date.id, operator: 'gt', value: early }] })).records[0]!.id, rows[0]!.id)
  const anchor = first.records[0]!
  await tableService.updateRecord(f.owner, f.wid, table.id, anchor.id, { values: { ...anchor.values, [number.id]: 12 }, expectedUpdatedAt: anchor.updatedAt })
  await denied(() => queryTable(f.owner, f.wid, table.id, { filters, sort, cursor: first.nextCursor }), 409)
})

test('PostgreSQL column cleanup preserves valid records near the compact JSON limit', async () => {
  if (db.dialect !== 'pg') return
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Near limit' })
  const columns = []
  for (let index = 0; index < 24; index++) columns.push(await tableService.createColumn(f.owner, f.wid, table.id, { name: `Payload ${index}`, type: 'text' }))
  const filler = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Filler', type: 'text' })
  const numbers = []
  for (let index = 0; index < 73; index++) numbers.push(await tableService.createColumn(f.owner, f.wid, table.id, { name: `Number ${index}`, type: 'number' }))
  const removed = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Remove', type: 'text' })
  const values: Record<string, string | number | null> = Object.fromEntries(columns.map((column) => [column.id, 'x'.repeat(10000)]))
  for (const column of numbers) values[column.id] = Number.MIN_VALUE
  values[filler.id] = 'y'.repeat(10000)
  values[removed.id] = null
  assert.ok(Buffer.byteLength(JSON.stringify(values)) < 262144)
  const expanded = await db.get<{ size: number | string }>('SELECT octet_length(jsonb_delete(CAST(? AS jsonb),CAST(? AS text))::text) AS size', JSON.stringify(values), removed.id)
  assert.ok(Number(expanded!.size) > 262344)
  const record = await tableService.createRecord(f.owner, f.wid, table.id, { values })

  assert.deepEqual(await tableService.deleteColumn(f.owner, f.wid, table.id, removed.id), { success: true, touchedRecords: 1 })
  const cleaned = await tableService.getRecord(f.owner, f.wid, table.id, record.id)
  assert.equal(cleaned.values[removed.id], undefined)
  assert.equal(cleaned.values[filler.id], values[filler.id])
  assert.equal(cleaned.values[columns[0]!.id], values[columns[0]!.id])
})

test('Table calculations distinguish empty, zero and false and order dates by precise instant', async () => {
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Calculations' })
  const text = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Name', type: 'text' })
  const number = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Amount', type: 'number' })
  const large = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Large', type: 'number' })
  const checkbox = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Active', type: 'checkbox' })
  const date = await tableService.createColumn(f.owner, f.wid, table.id, { name: 'Observed', type: 'datetime' })
  const empty = await summarizeTable(f.owner, f.wid, table.id)
  assert.deepEqual(empty.columns[number.id], { count: 0, empty: 0, sum: 0, average: null, min: null, max: null })
  const early = '2026-10-02T08:00:00.123456+08:00', later = '2026-10-02T00:00:00.123457Z'
  for (const values of [
    { [text.id]: '', [number.id]: 0, [checkbox.id]: false, [date.id]: later, [large.id]: Number.MAX_VALUE },
    { [text.id]: 'Present', [number.id]: 5, [checkbox.id]: true, [date.id]: early, [large.id]: Number.MAX_VALUE },
    { [text.id]: null, [number.id]: -2, [checkbox.id]: null },
    {},
  ]) await tableService.createRecord(f.owner, f.wid, table.id, { values })
  const summary = await summarizeTable(f.owner, f.wid, table.id)
  assert.equal(summary.recordCount, 4)
  assert.deepEqual(summary.columns[text.id], { count: 1, empty: 3 })
  assert.deepEqual(summary.columns[number.id], { count: 3, empty: 1, sum: 3, average: 1, min: -2, max: 5 })
  assert.deepEqual(summary.columns[checkbox.id], { count: 2, empty: 2, checked: 1, unchecked: 1 })
  assert.deepEqual(summary.columns[date.id], { count: 2, empty: 2, earliest: early, latest: later })
  assert.equal(summary.columns[large.id]!.sum, null, 'Overflow is explicit rather than a fake zero')
  assert.equal(summary.columns[large.id]!.average, null)
  const newest = '2026-10-01T23:00:00-04:00'
  await tableService.createRecord(f.owner, f.wid, table.id, { values: { [date.id]: newest } })
  assert.equal((await summarizeTable(f.owner, f.wid, table.id)).columns[date.id]!.latest, newest, 'Offsets determine ordering, not textual date order')
})

test('Table query and calculation snapshots remain consistent and release shared slots after revocation, cancellation and deadline failure', async () => {
  const f = await fixture()
  const table = await tableService.createTable(f.owner, f.wid, { name: 'Snapshot totals' })
  for (let row = 0; row < 45; row++) await tableService.createRecord(f.owner, f.wid, table.id, { values: {} })
  const reader = await createUser('Summary reader')
  const role = await service.createRole(f.owner, f.wid, { name: 'Summary reader', permissions: ['tables:read'] })
  await service.addMember(f.owner, f.wid, { email: `${reader}@example.test`, roleId: role.id })
  const originalBegin = db.beginSnapshot, originalNow = Date.now
  let afterChunk: (() => Promise<void>) | undefined
  let closed = 0
  db.beginSnapshot = async () => {
    const snapshot = await originalBegin()
    return { ...snapshot,
      all: async <Row extends Record<string, unknown>>(sql: string, ...bindings: unknown[]) => {
        const rows = await snapshot.all<Row>(sql, ...bindings)
        if (sql.includes('FROM table_records') && afterChunk) {
          const action = afterChunk; afterChunk = undefined; await action()
        }
        return rows
      },
      commit: async () => { await snapshot.commit(); closed++ },
      rollback: async () => { await snapshot.rollback(); closed++ },
    }
  }
  try {
    afterChunk = async () => { await tableService.createRecord(f.owner, f.wid, table.id, { values: {} }) }
    const snapshot = await queryTable(reader, f.wid, table.id, { limit: 1, summary: true })
    assert.equal(snapshot.total, 45, 'Concurrent insert is outside the pinned snapshot')
    assert.equal(snapshot.summary!.recordCount, 45)
    assert.equal((await summarizeTable(reader, f.wid, table.id)).recordCount, 46)
    afterChunk = async () => { await service.deleteMember(f.owner, f.wid, reader) }
    await denied(() => queryTable(reader, f.wid, table.id, {}))
    let cancelled = false
    afterChunk = async () => { cancelled = true }
    await denied(() => summarizeTable(f.owner, f.wid, table.id, async () => { if (cancelled) throw new HttpError(499, 'Client disconnected') }), 499)
    afterChunk = async () => { Date.now = () => originalNow() + 30_001 }
    await denied(() => queryTable(f.owner, f.wid, table.id, {}), 504)
    Date.now = originalNow
    assert.equal(closed, 5, 'Every successful, denied, cancelled or expired snapshot is closed')

    let release!: () => void, admitted!: () => void, arrivals = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { admitted = resolve })
    const hold = async () => { if (++arrivals === 2) admitted(); await gate }
    const pending = [summarizeTable(f.owner, f.wid, table.id, hold), queryTable(f.owner, f.wid, table.id, {}, hold)]
    try {
      await ready
      await denied(() => summarizeTable(f.owner, f.wid, table.id), 429)
    } finally { release(); await Promise.all(pending) }
    assert.equal((await summarizeTable(f.owner, f.wid, table.id)).recordCount, 46, 'Failure and admission slots are reusable')
  } finally { db.beginSnapshot = originalBegin; Date.now = originalNow }
})
