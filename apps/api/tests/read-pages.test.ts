import { after, test } from './japa.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'hopya-pages-'))
process.env.DATA_DIR = directory
const { db, service } = await import('../app/core.js')
const { PAGE_BYTES, RECORD_BYTES, decodeCursor, encodeCursor, itemQuery } = await import('../app/task_reads.js')
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
function fixture(count = 5) {
  const userId = randomUUID()
  db.prepare('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)').run(userId, 'Reader', `${userId}@example.test`, new Date().toISOString())
  const wid = service.createWorkspace(userId, { name: 'Pages' }).id
  const project = service.createNode(userId, wid, { kind: 'project', name: 'Project' })
  const list = service.createNode(userId, wid, { kind: 'list', name: 'List', parentId: project.id })
  for (let n = 0; n < count; n++) service.createItem(userId, wid, { nodeId: list.id, title: `Item ${n}`, description: n % 2 ? 'literal %_\\ match' : '', status: n % 2 ? 'done' : 'todo' })
  db.prepare('UPDATE items SET createdAt=? WHERE workspaceId=?').run('2026-01-01T00:00:00.000Z', wid)
  return { userId, wid, list, project }
}

test('seek pages cover tied timestamps exactly; changing limit and deleting the cursor do not offset subsequent reads', () => {
  const f = fixture(12)
  const expected = service.listItems(f.userId, f.wid)
  const first = service.pageItems(f.userId, f.wid, { limit: '3' })
  assert.deepEqual(first.items, expected.slice(0, 3))
  service.deleteItem(f.userId, f.wid, first.items[2].id)
  const next = service.pageItems(f.userId, f.wid, { limit: 4, cursor: first.nextCursor })
  assert.deepEqual(next.items, expected.slice(3, 7))
  const end = service.pageItems(f.userId, f.wid, { limit: 500, cursor: next.nextCursor })
  assert.deepEqual(end.items, expected.slice(7))
  assert.equal(end.nextCursor, null)
  const query = itemQuery(db, f.wid, {})
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM items WHERE ${query.where} AND (createdAt,id)>(?,?) ORDER BY createdAt,id LIMIT ?`).all(f.wid, expected[0].createdAt, expected[0].id, 3)
  assert.match(JSON.stringify(plan), /items_workspace_archive_read/)
  assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/)
})

test('pages preserve every legacy filter, literal LIKE escapes, and exact-node move behavior', () => {
  const f = fixture(9)
  for (const filters of [{}, { search: '' }, { search: '%_\\' }, { status: 'done' }, { nodeId: f.project.id }, { nodeId: f.list.id, status: 'todo' }, { search: 'Item', status: 'done' }]) {
    const items = []
    let cursor: string | null = null
    do {
      const page = service.pageItems(f.userId, f.wid, { ...filters, limit: 2, ...(cursor ? { cursor } : {}) })
      items.push(...page.items); cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual(items, service.listItems(f.userId, f.wid, filters))
  }
  const destination = service.createNode(f.userId, f.wid, { kind: 'project', name: 'Destination' })
  const before = service.listItems(f.userId, f.wid, { nodeId: f.list.id })
  service.updateNode(f.userId, f.wid, f.list.id, { parentId: destination.id })
  assert.deepEqual(service.pageItems(f.userId, f.wid, { nodeId: f.list.id }).items, before)
  assert.deepEqual(service.pageItems(f.userId, f.wid, { nodeId: destination.id }).items, [])
})

test('strict argument and canonical cursor validation bind workspace and filters, never authorization', () => {
  const f = fixture(); const other = fixture()
  for (const limit of [0, 501, -1, 1.5, true, false, null, [], ['1'], {}, '', '0', '01', ' 1', '1.0', '1e2', '5000']) assert.throws(() => service.pageItems(f.userId, f.wid, { limit }))
  for (const filters of [{ search: ['x'] }, { search: true }, { status: '' }, { nodeId: false }, { offset: 1 }, { cursor: [] }, { cursor: '' }, { cursor: 'x'.repeat(1025) }]) assert.throws(() => service.pageItems(f.userId, f.wid, filters))
  const page = service.pageItems(f.userId, f.wid, { limit: 1 })
  const cursor = page.nextCursor!
  const scope = itemQuery(db, f.wid, {}).scope
  const payload = decodeCursor(cursor, scope)
  for (const malformed of [cursor + '=', '*', Buffer.from(JSON.stringify({ ...payload, x: 1 })).toString('base64url'), Buffer.from(JSON.stringify({ ...payload, v: 2 })).toString('base64url'), Buffer.from(' ' + JSON.stringify(payload)).toString('base64url'), encodeCursor(scope, { ...payload, createdAt: 'not-a-date' })]) assert.throws(() => service.pageItems(f.userId, f.wid, { cursor: malformed }))
  assert.throws(() => service.pageItems(other.userId, other.wid, { cursor }))
  for (const filters of [{ search: '' }, { status: 'todo' }, { nodeId: f.list.id }]) assert.throws(() => service.pageItems(f.userId, f.wid, { ...filters, cursor }))
  assert.throws(() => service.pageItems(f.userId, f.wid, { nodeId: other.list.id }))
  db.prepare("UPDATE roles SET permissions='[]' WHERE workspaceId=?").run(f.wid)
  assert.throws(() => service.pageItems(f.userId, f.wid, { cursor }), /Permission required/)
  db.prepare('DELETE FROM memberships WHERE workspaceId=?').run(f.wid)
  assert.throws(() => service.pageItems(f.userId, f.wid, { cursor }), /Workspace access denied/)
})

test('default/count and encoded byte budgets bound pages without truncating a schema-maximum item', () => {
  const f = fixture(501)
  assert.equal(service.pageItems(f.userId, f.wid).items.length, 200)
  assert.equal(service.pageItems(f.userId, f.wid, { limit: 500 }).items.length, 500)
  db.prepare('UPDATE items SET description=? WHERE workspaceId=?').run('\u0000'.repeat(50000), f.wid)
  const page = service.pageItems(f.userId, f.wid, { limit: 500 })
  assert.ok(page.items.length > 1 && page.items.length < 500)
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= PAGE_BYTES)
  const big = fixture(0)
  const fields: Record<string, string> = {}
  for (let n = 0; n < 100; n++) fields[service.createField(big.userId, big.wid, { name: `Field ${n}`, type: 'text' }).id] = '\u0000'.repeat(10000)
  const item = service.createItem(big.userId, big.wid, { nodeId: big.list.id, title: 'Maximum', description: '\u0000'.repeat(50000), customFields: fields })
  const result = service.pageItems(big.userId, big.wid)
  assert.deepEqual(result.items, [item])
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > PAGE_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify(item)) < RECORD_BYTES)
  db.prepare('UPDATE items SET description=? WHERE id=?').run('x'.repeat(RECORD_BYTES), item.id)
  assert.throws(() => service.pageItems(big.userId, big.wid), /Stored record exceeds read limit/)
})

test('agent context returns only recent 100 lightweight items and first 100 lists, requiring both permissions', () => {
  const f = fixture(110)
  for (let n = 0; n < 103; n++) service.createNode(f.userId, f.wid, { kind: 'list', name: `List ${n}`, parentId: f.project.id })
  const all = service.listItems(f.userId, f.wid)
  const context = service.agentContext(f.userId, f.wid)
  assert.deepEqual(context.items, all.slice(-100).map(({ id, nodeId, title, status, priority, startDate, dueDate }) => ({ id, nodeId, title, status, priority, startDate, dueDate })))
  assert.deepEqual(context.lists, service.listNodes(f.userId, f.wid).filter((node) => node.kind === 'list').slice(0, 100).map(({ id, name }) => ({ id, name })))
  for (const permissions of [['agent:use'], ['items:read'], []]) {
    db.prepare('UPDATE roles SET permissions=? WHERE workspaceId=?').run(JSON.stringify(permissions), f.wid)
    assert.throws(() => service.agentContext(f.userId, f.wid), /Permission required/)
  }
})
