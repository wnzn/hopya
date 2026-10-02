import { test } from './japa.js'
import assert from 'node:assert/strict'
import { integrationServer } from './storage-sso-fixture.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import knex from 'knex'

// Covers the distinct import/export failure modes: permission boundaries,
// row validation with row numbers, the 500-row cap, all-or-nothing inserts,
// export filters, CSV round-tripping and oversized payloads.
test('task import/export endpoints', async (t) => {
  const sourceDirectory = mkdtempSync(join(tmpdir(), 'hopya-sql-http-'))
  const source = knex({ client: 'better-sqlite3', connection: { filename: join(sourceDirectory, 'live.sqlite') }, useNullAsDefault: true })
  t.after(async () => { await source.destroy(); rmSync(sourceDirectory, { recursive: true, force: true }) })
  const api = await integrationServer(t, { SQL_SQLITE_ROOT: sourceDirectory })
  const owner = await api.user(true)
  const outsider = await api.user(true)
  const post = async (path: string, body: unknown, token = owner.token) => {
    const response = await api.request(path, { method: 'POST', body, token })
    assert.ok(response.status === 200 || response.status === 201, `${path}: ${response.status} ${await response.clone().text()}`)
    return response.json() as Promise<Record<string, unknown> & { id: string }>
  }
  const workspace = await post('/workspaces', { name: 'ImportExport' })
  const wid = workspace.id
  const base = `/workspaces/${wid}`
  const project = await post(`${base}/nodes`, { name: 'Project', kind: 'project' })
  const list = await post(`${base}/nodes`, { name: 'Backlog', kind: 'list', parentId: project.id })
  const other = await post(`${base}/nodes`, { name: 'Other', kind: 'list', parentId: project.id })
  const folder = await post(`${base}/nodes`, { name: 'Folder', kind: 'folder', parentId: project.id })
  const sublist = await post(`${base}/nodes`, { name: 'Sub', kind: 'list', parentId: folder.id })

  const channel = await post(`${base}/fields`, { name: 'Channel', type: 'text' })
  const effort = await post(`${base}/fields`, { name: 'Effort', type: 'number' })
  const flag = await post(`${base}/fields`, { name: 'Flag', type: 'checkbox' })
  const severity = await post(`${base}/fields`, { name: 'Severity', type: 'select', options: ['low', 'high'] })
  const stars = await post(`${base}/fields`, { name: 'Stars', type: 'rating', settings: { maxRating: 3 } })

  const viewer = await api.user()
  const memberUser = await api.user()
  await post(`${base}/roles`, { name: 'Reader', permissions: ['items:read'] })
  const roles = await (await api.request(`${base}/roles`, { token: owner.token })).json() as { id: string; name: string }[]
  await post(`${base}/members`, { email: viewer.email, roleId: roles.find((role) => role.name === 'Reader')!.id })
  await post(`${base}/members`, { email: memberUser.email, roleId: roles.find((role) => role.name === 'Member')!.id })

  const importPath = `${base}/items/import`
  const exportPath = `${base}/items/export`
  const importAs = (body: unknown, token = owner.token) => api.request(importPath, { method: 'POST', body, token })
  const exportJson = async (query: string, token = owner.token) => {
    const response = await api.request(`${exportPath}${query}`, { token })
    assert.equal(response.status, 200, `${query}: ${response.status}`)
    return response.json() as Promise<Record<string, unknown>[]>
  }

  await t.test('permission boundaries: outsider denied both, viewer denied import but allowed export', async () => {
    const payload = { nodeId: list.id, format: 'json', data: JSON.stringify([{ title: 'Nope' }]) }
    assert.equal((await importAs(payload, outsider.token)).status, 403)
    assert.equal((await api.request(`${exportPath}?format=json`, { token: outsider.token })).status, 403)
    assert.equal((await importAs(payload, viewer.token)).status, 403)
    const readerExport = await api.request(`${exportPath}?format=json`, { token: viewer.token })
    assert.equal(readerExport.status, 200)
    assert.ok(Array.isArray(await readerExport.json()))
  })

  await t.test('JSON import happy path with assignee, tags and custom fields', async () => {
    const data = JSON.stringify([
      { title: 'JSON one', description: 'First', status: 'todo', priority: 'medium', tags: ['x', 'y', 'x'], assignee: memberUser.email, customFields: { [channel.id]: 'email', Effort: 5 } },
      { title: 'JSON two', status: 'Done', 'custom:Stars': 3, 'custom:Flag': true, 'custom:Severity': 'high' },
    ])
    const response = await importAs({ nodeId: list.id, format: 'json', data })
    assert.equal(response.status, 201)
    const result = await response.json() as { imported: number; ids: string[] }
    assert.equal(result.imported, 2)
    assert.equal(result.ids.length, 2)
    const first = await (await api.request(`${base}/items/${result.ids[0]}`, { token: owner.token })).json() as Record<string, unknown>
    assert.equal(first.title, 'JSON one')
    assert.deepEqual(first.tags, ['x', 'y'])
    assert.equal(first.assigneeId, memberUser.id)
    assert.deepEqual(first.customFields, { [channel.id]: 'email', [effort.id]: 5 })
    const second = await (await api.request(`${base}/items/${result.ids[1]}`, { token: owner.token })).json() as Record<string, unknown>
    assert.equal(second.status, 'done')
    assert.deepEqual(second.customFields, { [stars.id]: 3, [flag.id]: true, [severity.id]: 'high' })
  })

  await t.test('CSV import handles quoted commas, newlines and semicolon tags', async () => {
    const data = [
      'title,description,status,priority,startDate,dueDate,tags,assignee,custom:Channel,custom:Effort,custom:Flag,custom:Severity,custom:Stars',
      `"Report, Q3","line1\nline2",Done,high,2026-01-05,2026-01-10,"alpha; beta;alpha",${memberUser.email},web,3,yes,high,2`,
      'Plain,,todo,none,,,,,,,no,,',
    ].join('\r\n')
    const response = await importAs({ nodeId: list.id, format: 'csv', data })
    assert.equal(response.status, 201, await response.clone().text())
    const result = await response.json() as { imported: number; ids: string[] }
    assert.equal(result.imported, 2)
    const item = await (await api.request(`${base}/items/${result.ids[0]}`, { token: owner.token })).json() as Record<string, unknown>
    assert.equal(item.title, 'Report, Q3')
    assert.equal(item.description, 'line1\nline2')
    assert.equal(item.status, 'done')
    assert.deepEqual(item.tags, ['alpha', 'beta'])
    assert.equal(item.assigneeId, memberUser.id)
    assert.deepEqual(item.customFields, { [channel.id]: 'web', [effort.id]: 3, [flag.id]: true, [severity.id]: 'high', [stars.id]: 2 })
  })

  await t.test('row cap of 500 is enforced', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ title: `Bulk ${index}` }))
    const response = await importAs({ nodeId: list.id, format: 'json', data: JSON.stringify(rows) })
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /500/)
  })

  await t.test('failed imports insert nothing', async () => {
    const before = (await exportJson(`?format=json&nodeId=${list.id}&limit=5000`)).length
    const data = JSON.stringify([{ title: 'Good one' }, { title: 'Bad one', status: 'nope' }, { title: 'Good two' }])
    assert.equal((await importAs({ nodeId: list.id, format: 'json', data })).status, 400)
    const after = (await exportJson(`?format=json&nodeId=${list.id}&limit=5000`)).length
    assert.equal(after, before)
  })

  await t.test('exported CSV round-trips through the importer', async () => {
    const expected = await exportJson(`?format=json&nodeId=${list.id}&limit=5000`)
    assert.ok(expected.length > 0)
    const response = await api.request(`${exportPath}?format=csv&nodeId=${list.id}&limit=5000`, { token: owner.token })
    assert.equal(response.status, 200)
    const csv = await response.text()
    const header = csv.split(/\r?\n/)[0]!
    for (const column of ['id', 'title', 'description', 'status', 'tags', 'assigneeEmail', 'nodePath', 'custom:Channel']) {
      assert.ok(header.split(',').some((cell) => cell.replaceAll('"', '') === column || cell.replaceAll('"', '').startsWith(`${column}`)), `header has ${column}: ${header}`)
    }
    const dataRows = csv.trim().split(/\r?\n/).length - 1
    assert.ok(dataRows >= expected.length, 'embedded newlines stay inside quoted cells')
    const target = await post(`${base}/nodes`, { name: 'Roundtrip', kind: 'list', parentId: project.id })
    const importResponse = await importAs({ nodeId: target.id, format: 'csv', data: csv })
    assert.equal(importResponse.status, 201, await importResponse.clone().text())
    const imported = await (await api.request(`${exportPath}?format=json&nodeId=${target.id}&limit=5000`, { token: owner.token })).json() as Record<string, unknown>[]
    assert.equal(imported.length, expected.length)
    const byTitle = new Map(imported.map((item) => [item.title, item]))
    assert.deepEqual(byTitle.get('Report, Q3')!.tags, ['alpha', 'beta'])
    assert.equal(byTitle.get('Report, Q3')!.status, 'done')
    assert.equal(byTitle.get('Report, Q3')!.assigneeId, memberUser.id)
    assert.deepEqual(byTitle.get('JSON one')!.customFields, { [channel.id]: 'email', [effort.id]: 5, [flag.id]: null, [severity.id]: null, [stars.id]: null })
  })

  await t.test('oversized payloads are rejected', async () => {
    const response = await importAs({ nodeId: list.id, format: 'json', data: `{"x":"${'y'.repeat(1_000_001)}"}` })
    assert.ok(response.status === 400 || response.status === 413, `status ${response.status}`)
  })

  await t.test('Table imports are atomic and typed JSON/CSV exports include records beyond the displayed page', async () => {
    const tableImport = await api.request(`${base}/tables/import`, { method: 'POST', token: owner.token, body: { format: 'json', name: 'Typed table', data: JSON.stringify(Array.from({ length: 130 }, (_, index) => ({ Name: `Row ${index}, quoted\nvalue`, Count: index, Active: index === 0 ? null : false }))) } })
    assert.equal(tableImport.status, 201, await tableImport.clone().text())
    const { table, imported } = await tableImport.json() as { table: { id: string }; imported: number }
    assert.equal(imported, 130)
    const path = `${base}/tables/${table.id}`
    assert.equal((await api.request(`${path}/export`, { token: viewer.token })).status, 403, 'Task-only read does not grant Table export')
    assert.equal((await api.request(`${path}/export`, { token: outsider.token })).status, 403)
    const response = await api.request(`${path}/export?format=json`, { token: owner.token })
    assert.equal(response.status, 200)
    const exported = await response.json() as { columns: { key: string; name: string; type: string }[]; records: Record<string, unknown>[] }
    assert.equal(exported.records.length, 130)
    const count = exported.columns.find(column => column.name === 'Count')!, active = exported.columns.find(column => column.name === 'Active')!
    assert.equal(count.type, 'number'); assert.equal(active.type, 'checkbox')
    const summaryResponse = await api.request(`${path}/summary`, { token: owner.token })
    assert.equal(summaryResponse.status, 200)
    const summary = await summaryResponse.json() as { recordCount: number; columns: Record<string, { sum: number }> }
    assert.equal(summary.recordCount, 130)
    assert.equal(summary.columns[count.key]!.sum, 8385, 'HTTP calculation is not truncated to the first 100 displayed rows')
    assert.equal((await api.request(`${path}/summary`, { method: 'HEAD', token: owner.token })).status, 200)
    assert.equal((await api.request(`${path}/summary`, { token: viewer.token })).status, 403)
    const queryBody = { filters: [{ columnId: count.key, operator: 'gte', value: 100 }], sort: { columnId: count.key, direction: 'desc' }, limit: 5, summary: true }
    const queryResponse = await api.request(`${path}/query`, { method: 'POST', token: owner.token, body: queryBody })
    assert.equal(queryResponse.status, 200, await queryResponse.clone().text())
    const queried = await queryResponse.json() as { records: { values: Record<string, number> }[]; total: number; summary: { columns: Record<string, { sum: number }> } }
    assert.equal(queried.total, 30)
    assert.deepEqual(queried.records.map(record => record.values[count.key]), [129, 128, 127, 126, 125])
    assert.equal(queried.summary.columns[count.key]!.sum, 3435, 'Filtered HTTP totals include unloaded matches')
    assert.equal((await api.request(`${path}/query`, { method: 'POST', token: viewer.token, body: queryBody })).status, 403)
    assert.deepEqual(exported.records.map(record => record[count.key]), Array.from({ length: 130 }, (_, index) => index), 'Import preserves spreadsheet row order')
    assert.ok(exported.records.some(record => record[active.key] === null))
    assert.ok(exported.records.some(record => record[active.key] === false))
    const copy = await api.request(`${base}/tables/import`, { method: 'POST', token: owner.token, body: { format: 'json', data: JSON.stringify(exported) } })
    assert.equal(copy.status, 201, await copy.clone().text())
    assert.equal((await copy.json() as { imported: number }).imported, 130)
    const invalid = await api.request(`${path}/import`, { method: 'POST', token: owner.token, body: { format: 'csv', data: 'Name,Count,Active\ngood,1,true\nbad,invalid,false' } })
    assert.equal(invalid.status, 400)
    const duplicateTarget = await api.request(`${path}/import`, { method: 'POST', token: owner.token, body: { format: 'csv', data: 'left,right\nfirst,lost', columns: [{ key: 'left', name: 'Name', type: 'text' }, { key: 'right', name: 'Name', type: 'text' }] } })
    assert.equal(duplicateTarget.status, 400, 'An import cannot silently overwrite two source values in one destination column')
    assert.equal((await (await api.request(`${path}/export`, { token: owner.token })).json() as { records: unknown[] }).records.length, 130)
    await post(`${path}/columns`, { name: 'Stage', type: 'select', options: ['Ready'] })
    const csv = await (await api.request(`${path}/export?format=csv`, { token: owner.token })).text()
    assert.ok(csv.startsWith('Name,Count,Active,Stage\r\n')); assert.ok(csv.includes('quoted\nvalue"'))
    const typedCsvCopy = await api.request(`${path}/import`, { method: 'POST', token: owner.token, body: { format: 'csv', data: csv } })
    assert.equal(typedCsvCopy.status, 201, 'Empty select cells round-trip through CSV into a typed Table')
    const csvCopy = await api.request(`${base}/tables/import`, { method: 'POST', token: owner.token, body: { format: 'csv', data: csv } })
    assert.equal(csvCopy.status, 201)
    const { table: copyTable } = await csvCopy.json() as { table: { id: string } }
    assert.equal((await (await api.request(`${base}/tables/${copyTable.id}/export`, { token: owner.token })).json() as { records: unknown[] }).records.length, 130)
  })

  await t.test('live connection HTTP wiring exports source rows and writes only to the linked source', async () => {
    await source.schema.createTable('inventory', table => { table.integer('id').primary(); table.text('description') })
    await source('inventory').insert({ id: 1, description: 'Source row' })
    const connection = await post(`${base}/table-connections`, { name: 'Private source', dialect: 'sqlite', filename: 'live.sqlite' })
    assert.deepEqual(Object.keys(connection).sort(), ['createdAt', 'dialect', 'id', 'name', 'workspaceId'])
    const table = await post(`${base}/tables/connect`, { connectionId: connection.id, name: 'Live inventory', schema: 'main', table: 'inventory' })
    const path = `${base}/tables/${table.id}`
    const exported = await (await api.request(`${path}/export?format=json`, { token: owner.token })).json() as { columns: { key: string; name: string }[]; records: Record<string, unknown>[] }
    const description = exported.columns.find(column => column.name === 'description')!.key
    assert.equal(exported.records[0]![description], 'Source row')
    const { records: [record] } = await (await api.request(`${path}/records`, { token: owner.token })).json() as { records: { id: string; values: Record<string, unknown>; updatedAt: string }[] }
    const patched = await api.request(`${path}/records/${record!.id}`, { token: owner.token, method: 'PATCH', body: { values: { ...record!.values, [description]: 'HTTP write-back' }, expectedUpdatedAt: record!.updatedAt } })
    assert.equal(patched.status, 200, await patched.clone().text())
    assert.equal((await source('inventory').first()).description, 'HTTP write-back')
    assert.equal((await api.request(`${path}/import`, { token: owner.token, method: 'POST', body: { format: 'csv', data: 'description\nnot a source insert' } })).status, 400)
    const workspaceExport = await (await api.request(`${base}/export`, { token: owner.token })).json() as { tableSources: { tableId: string }[]; tableRecords: { tableId: string }[] }
    assert.ok(workspaceExport.tableSources.some(entry => entry.tableId === table.id))
    assert.equal(workspaceExport.tableRecords.some(entry => entry.tableId === table.id), false)
  })

})
