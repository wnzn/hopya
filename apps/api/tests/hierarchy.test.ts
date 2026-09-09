import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-hierarchy-'))
process.env.DATA_DIR = directory
migrateDatabase()
const { db, service, HttpError } = await import('../app/core.js')
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

function user() {
  const id = randomUUID()
  const email = `${id}@example.test`
  db.prepare('INSERT INTO users (id,name,email,createdAt) VALUES (?,?,?,?)').run(id, 'Hierarchy test', email, new Date().toISOString())
  return { id, email }
}
function fixture() {
  const owner = user()
  const wid = service.createWorkspace(owner.id, { name: 'Move test' }).id
  const source = service.createNode(owner.id, wid, { name: 'Source', kind: 'project' })
  const target = service.createNode(owner.id, wid, { name: 'Target', kind: 'project' })
  const folder = service.createNode(owner.id, wid, { name: 'Folder', kind: 'folder', parentId: source.id })
  const child = service.createNode(owner.id, wid, { name: 'Child', kind: 'folder', parentId: folder.id })
  const list = service.createNode(owner.id, wid, { name: 'List', kind: 'list', parentId: child.id })
  const task = service.createItem(owner.id, wid, { title: 'Preserved task', nodeId: list.id, description: 'Private contents', tags: ['with,comma'], dueDate: '2026-09-25' })
  return { owner, wid, source, target, folder, child, list, task }
}
const reject = (action: () => unknown, status: number) => assert.throws(action, (error: unknown) => error instanceof HttpError && error.status === status)
const countAudits = () => (db.prepare('SELECT count(*) AS n FROM audit_logs').get() as { n: number }).n

test('populated folder and list moves preserve every child/task field and audit only safe metadata', () => {
  const f = fixture()
  const before = service.listNodes(f.owner.id, f.wid)
  const moved = service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: f.target.id, expectedParentId: f.source.id })
  assert.equal(moved.parentId, f.target.id)
  assert.equal(moved.name, f.folder.name)
  assert.equal(moved.createdAt, f.folder.createdAt)
  assert.deepEqual(service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  for (const node of before.filter((node) => node.id !== f.folder.id)) assert.deepEqual(service.listNodes(f.owner.id, f.wid).find((current) => current.id === node.id), node)
  const movedList = service.updateNode(f.owner.id, f.wid, f.list.id, { name: 'Moved list', parentId: f.source.id, expectedParentId: f.child.id })
  assert.equal(movedList.name, 'Moved list')
  assert.equal(movedList.parentId, f.source.id)
  assert.deepEqual(service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  assert.equal(service.exportWorkspace(f.owner.id, f.wid).nodes.find((node) => node.id === f.list.id)?.parentId, f.source.id)
  const entries = db.prepare("SELECT details FROM audit_logs WHERE action='node.update'").all() as { details: string }[]
  assert.deepEqual(JSON.parse(entries.at(-1)!.details), { fields: ['name', 'parentId'], previousParentId: f.child.id, parentId: f.source.id })
  assert.equal(JSON.stringify(entries).includes('Private contents'), false)
  assert.equal(JSON.stringify(entries).includes('Moved list'), false)
})

test('moves reject self/descendant/list parents, missing parents, cross-workspace IDs and non-root projects without side effects', () => {
  const f = fixture(); const other = fixture()
  const nodes = service.listNodes(f.owner.id, f.wid)
  const audits = countAudits()
  for (const parentId of [f.folder.id, f.child.id, f.list.id, null]) reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Must not persist', parentId }), 400)
  reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: randomUUID() }), 404)
  reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: other.target.id }), 404)
  reject(() => service.updateNode(f.owner.id, f.wid, other.folder.id, { parentId: f.target.id }), 404)
  reject(() => service.updateNode(f.owner.id, f.wid, f.source.id, { parentId: f.target.id }), 400)
  assert.deepEqual(service.listNodes(f.owner.id, f.wid), nodes)
  assert.deepEqual(service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  assert.equal(countAudits(), audits)
})

test('stale conditional moves fail while rename-only updates preserve the current parent', () => {
  const f = fixture()
  service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: f.target.id, expectedParentId: f.source.id })
  const audits = countAudits()
  reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Stale', parentId: f.source.id, expectedParentId: f.source.id }), 409)
  assert.equal(countAudits(), audits)
  const renamed = service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Current rename' })
  assert.equal(renamed.parentId, f.target.id)
  assert.equal(renamed.name, 'Current rename')
  assert.deepEqual(service.getItem(f.owner.id, f.wid, f.task.id), f.task)
})

test('depth validation accounts for the whole moved subtree, permits depth 32 and rejects depth 33', () => {
  const f = fixture()
  let parentId = f.target.id
  const parents: string[] = [parentId]
  for (let depth = 1; depth <= 31; depth++) {
    parentId = service.createNode(f.owner.id, f.wid, { name: `Depth ${depth}`, kind: 'folder', parentId }).id
    parents.push(parentId)
  }
  const audits = countAudits()
  // Root at 31 would place the existing child and list at 32 and 33.
  reject(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: parents[30] }), 400)
  assert.equal(countAudits(), audits)
  assert.equal(service.updateNode(f.owner.id, f.wid, f.folder.id, { parentId: parents[29] }).parentId, parents[29])
  assert.deepEqual(service.getItem(f.owner.id, f.wid, f.task.id), f.task)
  // A leaf list can sit directly at depth 32, but a folder under that list cannot.
  assert.equal(service.updateNode(f.owner.id, f.wid, f.list.id, { parentId: parents[31] }).parentId, parents[31])
  reject(() => service.updateNode(f.owner.id, f.wid, f.child.id, { parentId: f.list.id }), 400)
  const deepest = service.createNode(f.owner.id, f.wid, { name: 'Depth 32', kind: 'folder', parentId: parents[31] })
  reject(() => service.updateNode(f.owner.id, f.wid, f.list.id, { parentId: deepest.id }), 400)
})

test('structure-only managers can move metadata without task access; viewers and outsiders cannot', () => {
  const f = fixture()
  const manager = user(); const viewer = user(); const outsider = user()
  const role = service.createRole(f.owner.id, f.wid, { name: 'Structure manager', permissions: ['structure:write'] })
  service.addMember(f.owner.id, f.wid, { email: manager.email, roleId: role.id })
  const viewerRole = service.listRoles(f.owner.id, f.wid).find((role) => role.name === 'Viewer')!
  service.addMember(f.owner.id, f.wid, { email: viewer.email, roleId: viewerRole.id })
  const audits = countAudits()
  for (const actor of [viewer, outsider]) reject(() => service.updateNode(actor.id, f.wid, f.folder.id, { parentId: f.target.id }), 403)
  assert.equal(countAudits(), audits)
  assert.equal(service.updateNode(manager.id, f.wid, f.folder.id, { parentId: f.target.id }).parentId, f.target.id)
  reject(() => service.listItems(manager.id, f.wid), 403)
  reject(() => service.getItem(manager.id, f.wid, f.task.id), 403)
})

test('node moves and renames roll back together if audit insertion fails', () => {
  const f = fixture()
  const before = service.listNodes(f.owner.id, f.wid)
  const audits = countAudits()
  db.exec("CREATE TEMP TRIGGER fail_move_audit BEFORE INSERT ON audit_logs WHEN NEW.action='node.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { assert.throws(() => service.updateNode(f.owner.id, f.wid, f.folder.id, { name: 'Rollback', parentId: f.target.id }), /audit unavailable/) }
  finally { db.exec('DROP TRIGGER fail_move_audit') }
  assert.deepEqual(service.listNodes(f.owner.id, f.wid), before)
  assert.equal(countAudits(), audits)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
})

test('node patch schema rejects empty/condition-only, unknown and malformed mutations', () => {
  const f = fixture()
  const audits = countAudits()
  for (const body of [{}, { expectedParentId: f.source.id }, { parentId: 'not-a-uuid' }, { name: '' }, { kind: 'list', name: 'Changed kind' }, { workspaceId: f.wid, name: 'Scope' }]) {
    assert.throws(() => service.updateNode(f.owner.id, f.wid, f.folder.id, body))
  }
  assert.equal(countAudits(), audits)
  const project = service.updateNode(f.owner.id, f.wid, f.source.id, { name: 'Root rename', parentId: null, expectedParentId: null })
  assert.equal(project.parentId, null)
})

test('subtasks validate same-workspace parents, block deletion with children, and survive cross-list moves', () => {
  const f = fixture(); const other = fixture()
  const parent = service.createItem(f.owner.id, f.wid, { title: 'Parent', nodeId: f.list.id })
  assert.equal(parent.parentId, null)
  const child = service.createItem(f.owner.id, f.wid, { title: 'Child', nodeId: f.list.id, parentId: parent.id })
  assert.equal(child.parentId, parent.id)
  assert.equal(service.getItem(f.owner.id, f.wid, child.id).parentId, parent.id)
  const foreign = service.createItem(other.owner.id, other.wid, { title: 'Foreign', nodeId: other.list.id })
  reject(() => service.createItem(f.owner.id, f.wid, { title: 'Cross-workspace', nodeId: f.list.id, parentId: foreign.id }), 404)
  reject(() => service.createItem(f.owner.id, f.wid, { title: 'Missing', nodeId: f.list.id, parentId: randomUUID() }), 404)
  reject(() => service.updateItem(f.owner.id, f.wid, parent.id, { parentId: parent.id }), 400)
  reject(() => service.updateItem(f.owner.id, f.wid, parent.id, { parentId: child.id }), 400)
  const grandchild = service.createItem(f.owner.id, f.wid, { title: 'Grandchild', nodeId: f.list.id, parentId: child.id })
  reject(() => service.updateItem(f.owner.id, f.wid, parent.id, { parentId: grandchild.id }), 400)
  reject(() => service.deleteItem(f.owner.id, f.wid, parent.id), 409)
  reject(() => service.deleteItem(f.owner.id, f.wid, child.id), 409)
  // Moving a subtask across lists is allowed and preserves the parent link.
  const second = service.createNode(f.owner.id, f.wid, { name: 'Second list', kind: 'list', parentId: f.source.id })
  const moved = service.updateItem(f.owner.id, f.wid, child.id, { nodeId: second.id })
  assert.equal(moved.nodeId, second.id)
  assert.equal(moved.parentId, parent.id)
  assert.equal(service.updateItem(f.owner.id, f.wid, child.id, { parentId: null }).parentId, null)
  service.deleteItem(f.owner.id, f.wid, grandchild.id)
  service.deleteItem(f.owner.id, f.wid, child.id)
  service.deleteItem(f.owner.id, f.wid, parent.id)
  reject(() => service.getItem(f.owner.id, f.wid, parent.id), 404)
})
