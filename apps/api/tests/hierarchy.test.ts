import { after, test } from './japa.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-hierarchy-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { db, service, HttpError } = await import('../app/core.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

async function user() {
  const id = randomUUID()
  const email = `${id}@example.test`
  await db.run('INSERT INTO users (id,name,email,createdAt) VALUES (?,?,?,?)', id, 'Hierarchy test', email, new Date().toISOString())
  return { id, email }
}
async function fixture() {
  const owner = await user()
  const wid = (await service.createWorkspace(owner.id, { name: 'Move test' })).id
  const source = await service.createNode(owner.id, wid, { name: 'Source', kind: 'project' })
  const target = await service.createNode(owner.id, wid, { name: 'Target', kind: 'project' })
  const folder = await service.createNode(owner.id, wid, { name: 'Folder', kind: 'folder', parentId: source.id })
  const child = await service.createNode(owner.id, wid, { name: 'Child', kind: 'folder', parentId: folder.id })
  const list = await service.createNode(owner.id, wid, { name: 'List', kind: 'list', parentId: child.id })
  const task = await service.createItem(owner.id, wid, { title: 'Preserved task', nodeId: list.id, description: 'Private contents', tags: ['with,comma'], dueDate: '2026-09-25' })
  return { owner, wid, source, target, folder, child, list, task }
}
const reject = (action: () => Promise<unknown>, status: number) => assert.rejects(action, (error: unknown) => error instanceof HttpError && error.status === status)
const countAudits = async () => (await db.get<{ n: number }>('SELECT count(*) AS n FROM audit_logs'))!.n

test('populated folder and list moves preserve every child/task field and audit only safe metadata', async () => {
  const f = await fixture()
  const before = await service.listNodes(f.owner.id, f.wid)
  const moved = await service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: f.target.id, expectedParentId: f.source.id })
  assert.equal(moved.parentId, f.target.id)
  assert.equal(moved.name, f.folder.name)
  assert.equal(moved.createdAt, f.folder.createdAt)
  assert.deepEqual(await service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  for (const node of before.filter((node) => node.id !== f.folder.id)) assert.deepEqual((await service.listNodes(f.owner.id, f.wid)).find((current) => current.id === node.id), node)
  const movedList = await service.updateNode(f.owner.id, f.wid, f.list.id, { name: 'Moved list', parentId: f.source.id, expectedParentId: f.child.id })
  assert.equal(movedList.name, 'Moved list')
  assert.equal(movedList.parentId, f.source.id)
  assert.deepEqual(await service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  assert.equal((await service.exportWorkspace(f.owner.id, f.wid)).nodes.find((node) => node.id === f.list.id)?.parentId, f.source.id)
  const entries = await db.all<{ details: string }>("SELECT details FROM audit_logs WHERE action='node.update'")
  assert.deepEqual(JSON.parse(entries.at(-1)!.details), { fields: ['name', 'parentId'], previousParentId: f.child.id, parentId: f.source.id })
  assert.equal(JSON.stringify(entries).includes('Private contents'), false)
  assert.equal(JSON.stringify(entries).includes('Moved list'), false)
})

test('moves reject self/descendant/list parents, missing parents, cross-workspace IDs and non-root projects without side effects', async () => {
  const f = await fixture(); const other = await fixture()
  const nodes = await service.listNodes(f.owner.id, f.wid)
  const audits = await countAudits()
  for (const parentId of [f.folder.id, f.child.id, f.list.id, null]) await reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Must not persist', parentId }), 400)
  await reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: randomUUID() }), 404)
  await reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: other.target.id }), 404)
  await reject(() => service.updateNode(f.owner.id, f.wid, other.folder.id, { parentId: f.target.id }), 404)
  await reject(() => service.updateNode(f.owner.id, f.wid, f.source.id, { parentId: f.target.id }), 400)
  assert.deepEqual(await service.listNodes(f.owner.id, f.wid), nodes)
  assert.deepEqual(await service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  assert.equal(await countAudits(), audits)
})

test('stale conditional moves fail while rename-only updates preserve the current parent', async () => {
  const f = await fixture()
  await service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: f.target.id, expectedParentId: f.source.id })
  const audits = await countAudits()
  await reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Stale', parentId: f.source.id, expectedParentId: f.source.id }), 409)
  assert.equal(await countAudits(), audits)
  const renamed = await service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Current rename' })
  assert.equal(renamed.parentId, f.target.id)
  assert.equal(renamed.name, 'Current rename')
  assert.deepEqual(await service.getItem(f.owner.id, f.wid, f.task.id), f.task)
})

test('depth validation accounts for the whole moved subtree, permits depth 32 and rejects depth 33', async () => {
  const f = await fixture()
  let parentId = f.target.id
  const parents: string[] = [parentId]
  for (let depth = 1; depth <= 31; depth++) {
    parentId = (await service.createNode(f.owner.id, f.wid, { name: `Depth ${depth}`, kind: 'folder', parentId })).id
    parents.push(parentId)
  }
  const audits = await countAudits()
  // Root at 31 would place the existing child and list at 32 and 33.
  await reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: parents[30] }), 400)
  assert.equal(await countAudits(), audits)
  assert.equal((await service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: parents[29] })).parentId, parents[29])
  assert.deepEqual(await service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  // A leaf list can sit directly at depth 32, but a folder under that list cannot.
  assert.equal((await service.updateNode(f.owner.id, f.wid, f.list.id, { parentId: parents[31] })).parentId, parents[31])
  await reject(() => service.updateNode(f.owner.id, f.wid, f.child.id, { parentId: f.list.id }), 400)
  const deepest = await service.createNode(f.owner.id, f.wid, { name: 'Depth 32', kind: 'folder', parentId: parents[31] })
  await reject(() => service.updateNode(f.owner.id, f.wid, f.list.id, { parentId: deepest.id }), 400)
})

test('structure-only managers can move metadata without task access; viewers and outsiders cannot', async () => {
  const f = await fixture()
  const manager = await user(); const viewer = await user(); const outsider = await user()
  const role = await service.createRole(f.owner.id, f.wid, { name: 'Structure manager', permissions: ['structure:write'] })
  await service.addMember(f.owner.id, f.wid, { email: manager.email, roleId: role.id })
  const viewerRole = (await service.listRoles(f.owner.id, f.wid)).find((role) => role.name === 'Viewer')!
  await service.addMember(f.owner.id, f.wid, { email: viewer.email, roleId: viewerRole.id })
  const audits = await countAudits()
  for (const actor of [viewer, outsider]) await reject(() => service.updateNode(actor.id, f.wid, f.folder.id, { parentId: f.target.id }), 403)
  assert.equal(await countAudits(), audits)
  assert.equal((await service.updateNode(manager.id, f.wid, f.folder.id, { parentId: f.target.id })).parentId, f.target.id)
  await reject(() => service.listItems(manager.id, f.wid), 403)
  await reject(() => service.getItem(manager.id, f.wid, f.task.id), 403)
})

test('node moves and renames roll back together if audit insertion fails', async () => {
  const f = await fixture()
  const before = await service.listNodes(f.owner.id, f.wid)
  const audits = await countAudits()
  await db.run("CREATE TEMP TRIGGER fail_move_audit BEFORE INSERT ON audit_logs WHEN NEW.action='node.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { await assert.rejects(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Rollback', parentId: f.target.id }), /audit unavailable/) }
  finally { await db.run('DROP TRIGGER fail_move_audit') }
  assert.deepEqual(await service.listNodes(f.owner.id, f.wid), before)
  assert.equal(await countAudits(), audits)
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'), [])
})

test('node patch schema rejects empty/condition-only, unknown and malformed mutations', async () => {
  const f = await fixture()
  const audits = await countAudits()
  for (const body of [{}, { expectedParentId: f.source.id }, { parentId: 'not-a-uuid' }, { name: '' }, { kind: 'list', name: 'Changed kind' }, { workspaceId: f.wid, name: 'Scope' }]) {
    await assert.rejects(() => service.updateNode(f.owner.id, f.wid, f.folder.id, body))
  }
  assert.equal(await countAudits(), audits)
  const project = await service.updateNode(f.owner.id, f.wid, f.source.id, { name: 'Root rename', parentId: null, expectedParentId: null })
  assert.equal(project.parentId, null)
})

test('subtasks validate same-workspace parents, block deletion with children, and survive cross-list moves', async () => {
  const f = await fixture(); const other = await fixture()
  const parent = await service.createItem(f.owner.id, f.wid, { title: 'Parent', nodeId: f.list.id })
  assert.equal(parent.parentId, null)
  const child = await service.createItem(f.owner.id, f.wid, { title: 'Child', nodeId: f.list.id, parentId: parent.id })
  assert.equal(child.parentId, parent.id)
  assert.equal((await service.getItem(f.owner.id, f.wid, child.id)).parentId, parent.id)
  const foreign = await service.createItem(other.owner.id, other.wid, { title: 'Foreign', nodeId: other.list.id })
  await reject(() => service.createItem(f.owner.id, f.wid, { title: 'Cross-workspace', nodeId: f.list.id, parentId: foreign.id }), 404)
  await reject(() => service.createItem(f.owner.id, f.wid, { title: 'Missing', nodeId: f.list.id, parentId: randomUUID() }), 404)
  await reject(() => service.updateItem(f.owner.id, f.wid, parent.id, { parentId: parent.id }), 400)
  await reject(() => service.updateItem(f.owner.id, f.wid, parent.id, { parentId: child.id }), 400)
  const grandchild = await service.createItem(f.owner.id, f.wid, { title: 'Grandchild', nodeId: f.list.id, parentId: child.id })
  await reject(() => service.updateItem(f.owner.id, f.wid, parent.id, { parentId: grandchild.id }), 400)
  await reject(() => service.deleteItem(f.owner.id, f.wid, parent.id), 409)
  await reject(() => service.deleteItem(f.owner.id, f.wid, child.id), 409)
  // Moving a subtask across lists is allowed and preserves the parent link.
  const second = await service.createNode(f.owner.id, f.wid, { name: 'Second list', kind: 'list', parentId: f.source.id })
  const moved = await service.updateItem(f.owner.id, f.wid, child.id, { nodeId: second.id })
  assert.equal(moved.nodeId, second.id)
  assert.equal(moved.parentId, parent.id)
  assert.equal((await service.updateItem(f.owner.id, f.wid, child.id, { parentId: null })).parentId, null)
  await service.deleteItem(f.owner.id, f.wid, grandchild.id)
  await service.deleteItem(f.owner.id, f.wid, child.id)
  await service.deleteItem(f.owner.id, f.wid, parent.id)
  await reject(() => service.getItem(f.owner.id, f.wid, parent.id), 404)
})
