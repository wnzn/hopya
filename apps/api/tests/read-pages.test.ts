import { after, test } from './japa.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-pages-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { db, service } = await import('../app/core.js')
const { PAGE_BYTES, RECORD_BYTES, decodeCursor, encodeCursor, itemQuery } = await import('../app/task_reads.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })
async function fixture(count = 5) {
  const userId = randomUUID()
  await db.run('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)', userId, 'Reader', `${userId}@example.test`, new Date().toISOString())
  const wid = (await service.createWorkspace(userId, { name: 'Pages' })).id
  const project = await service.createNode(userId, wid, { kind: 'project', name: 'Project' })
  const list = await service.createNode(userId, wid, { kind: 'list', name: 'List', parentId: project.id })
  for (let n = 0; n < count; n++) await service.createItem(userId, wid, { nodeId: list.id, title: `Item ${n}`, description: n % 2 ? 'literal %_\\ match' : '', status: n % 2 ? 'done' : 'todo' })
  await db.run('UPDATE items SET createdAt=? WHERE workspaceId=?', '2026-01-01T00:00:00.000Z', wid)
  return { userId, wid, list, project }
}

test('seek pages cover tied timestamps exactly; changing limit and deleting the cursor do not offset subsequent reads', async () => {
  const f = await fixture(12)
  const expected = await service.listItems(f.userId, f.wid)
  const first = await service.pageItems(f.userId, f.wid, { limit: '3' })
  assert.deepEqual(first.items, expected.slice(0, 3))
  await service.deleteItem(f.userId, f.wid, first.items[2].id)
  const next = await service.pageItems(f.userId, f.wid, { limit: 4, cursor: first.nextCursor })
  assert.deepEqual(next.items, expected.slice(3, 7))
  const end = await service.pageItems(f.userId, f.wid, { limit: 500, cursor: next.nextCursor })
  assert.deepEqual(end.items, expected.slice(7))
  assert.equal(end.nextCursor, null)
  const query = await itemQuery(db, f.wid, {})
  const plan = await db.all(`EXPLAIN QUERY PLAN SELECT id FROM items WHERE ${query.where} AND (createdAt,id)>(?,?) ORDER BY createdAt,id LIMIT ?`, ...query.values, expected[0].createdAt, expected[0].id, 3)
  assert.match(JSON.stringify(plan), /items_workspace_archive_read/)
  assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/)
})

test('pages preserve every legacy filter, literal LIKE escapes, and exact-node move behavior', async () => {
  const f = await fixture(9)
  for (const filters of [{}, { search: '' }, { search: '%_\\' }, { status: 'done' }, { nodeId: f.project.id }, { nodeId: f.list.id, status: 'todo' }, { search: 'Item', status: 'done' }]) {
    const items = []
    let cursor: string | null = null
    do {
      const page = await service.pageItems(f.userId, f.wid, { ...filters, limit: 2, ...(cursor ? { cursor } : {}) })
      items.push(...page.items); cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(items, await service.listItems(f.userId, f.wid, filters))
  }
  const destination = await service.createNode(f.userId, f.wid, { kind: 'project', name: 'Destination' })
  const before = await service.listItems(f.userId, f.wid, { nodeId: f.list.id })
  await service.updateNode(f.userId, f.wid, f.list.id, { parentId: destination.id })
  assert.deepEqual((await service.pageItems(f.userId, f.wid, { nodeId: f.list.id })).items, before)
  assert.deepEqual((await service.pageItems(f.userId, f.wid, { nodeId: destination.id })).items, [])
})

test('strict argument and canonical cursor validation bind workspace and filters, never authorization', async () => {
  const f = await fixture(); const other = await fixture()
  for (const limit of [0, 501, -1, 1.5, true, false, null, [], ['1'], {}, '', '0', '01', ' 1', '1.0', '1e2', '5000']) await assert.rejects(() => service.pageItems(f.userId, f.wid, { limit }))
  for (const filters of [{ search: ['x'] }, { search: true }, { status: '' }, { nodeId: false }, { offset: 1 }, { cursor: [] }, { cursor: '' }, { cursor: 'x'.repeat(1025) }]) await assert.rejects(() => service.pageItems(f.userId, f.wid, filters))
  const page = await service.pageItems(f.userId, f.wid, { limit: 1 })
  const cursor = page.nextCursor!
  const scope = (await itemQuery(db, f.wid, {})).scope
  const payload = decodeCursor(cursor, scope)
  for (const malformed of [cursor + '=', '*', Buffer.from(JSON.stringify({ ...payload, x: 1 })).toString('base64url'), Buffer.from(JSON.stringify({ ...payload, v: 2 })).toString('base64url'), Buffer.from(' ' + JSON.stringify(payload)).toString('base64url'), encodeCursor(scope, { ...payload, createdAt: 'not-a-date' })]) await assert.rejects(() => service.pageItems(f.userId, f.wid, { cursor: malformed }))
  await assert.rejects(() => service.pageItems(other.userId, other.wid, { cursor }))
  for (const filters of [{ search: '' }, { status: 'todo' }, { nodeId: f.list.id }]) await assert.rejects(() => service.pageItems(f.userId, f.wid, { ...filters, cursor }))
  await assert.rejects(() => service.pageItems(f.userId, f.wid, { nodeId: other.list.id }))
  await db.run("UPDATE roles SET permissions='[]' WHERE workspaceId=?", f.wid)
  await assert.rejects(() => service.pageItems(f.userId, f.wid, { cursor }), /Permission required/)
  await db.run('DELETE FROM memberships WHERE workspaceId=?', f.wid)
  await assert.rejects(() => service.pageItems(f.userId, f.wid, { cursor }), /Workspace access denied/)
})

test('default/count and encoded byte budgets bound pages without truncating a schema-maximum item', async () => {
  const f = await fixture(501)
  assert.equal((await service.pageItems(f.userId, f.wid)).items.length, 200)
  assert.equal((await service.pageItems(f.userId, f.wid, { limit: 500 })).items.length, 500)
  await db.run('UPDATE items SET description=? WHERE workspaceId=?', '\u0000'.repeat(50000), f.wid)
  const page = await service.pageItems(f.userId, f.wid, { limit: 500 })
  assert.ok(page.items.length > 1 && page.items.length < 500)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= PAGE_BYTES)
  const big = await fixture(0)
  const fields: Record<string, string> = {}
  for (let n = 0; n < 100; n++) fields[(await service.createField(big.userId, big.wid, { name: `Field ${n}`, type: 'text' })).id] = '\u754c'.repeat(10000)
  const item = await service.createItem(big.userId, big.wid, { nodeId: big.list.id, title: 'Maximum', description: '\u0000'.repeat(50000), customFields: fields })
  const result = await service.pageItems(big.userId, big.wid)
  assert.deepEqual(result.items, [item])
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify(item)) < RECORD_BYTES)
  await db.run('PRAGMA ignore_check_constraints = ON')
  try {
    await db.run('UPDATE items SET description=? WHERE id=?', 'x'.repeat(RECORD_BYTES), item.id)
    await assert.rejects(() => service.pageItems(big.userId, big.wid), /Stored record exceeds read limit/)
  } finally {
    await db.run('PRAGMA ignore_check_constraints = OFF')
  }
})

test('agent context returns only recent 100 lightweight items and first 100 lists, requiring both permissions', async () => {
  const f = await fixture(110)
  for (let n = 0; n < 103; n++) await service.createNode(f.userId, f.wid, { kind: 'list', name: `List ${n}`, parentId: f.project.id })
  const all = await service.listItems(f.userId, f.wid)
  const context = await service.agentContext(f.userId, f.wid)
  assert.deepEqual(context.items, all.slice(-100).map(({ id, nodeId, title, status, priority, startDate, dueDate }) => ({ id, nodeId, title, status, priority, startDate, dueDate })))
  assert.deepEqual(context.lists, (await service.listNodes(f.userId, f.wid)).filter((node) => node.kind === 'list').slice(0, 100).map(({ id, name }) => ({ id, name })))
  for (const permissions of [['agent:use'], ['items:read'], []]) {
    await db.run('UPDATE roles SET permissions=? WHERE workspaceId=?', JSON.stringify(permissions), f.wid)
    await assert.rejects(() => service.agentContext(f.userId, f.wid), /Permission required/)
  }
})
