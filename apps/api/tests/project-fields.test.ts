import { after, test } from './japa.js'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import Database from 'better-sqlite3'

const directory = mkdtempSync(join(tmpdir(), 'hopya-project-fields-'))
process.env.DATA_DIR = directory
const { db, service, HttpError } = await import('../app/core.js')
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
function user() {
  const id = randomUUID(); const email = `${id}@example.test`
  db.prepare('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)').run(id, 'Test', email, new Date().toISOString())
  return { id, email }
}
function fixture() {
  const owner = user(); const wid = service.createWorkspace(owner.id, { name: 'Fields' }).id
  const project = service.createNode(owner.id, wid, { name: 'Project', kind: 'project' })
  const list = service.createNode(owner.id, wid, { name: 'List', kind: 'list', parentId: project.id })
  const field = service.createField(owner.id, wid, { name: 'Value', type: 'number' })
  return { owner, wid, project, list, field }
}
const reject = (action: () => unknown, status: number) => assert.throws(action, (error: unknown) => error instanceof HttpError && error.status === status)

test('empty defaults, ordered assignments, unassignment and moves preserve raw values and catalog formula validation', () => {
  const f = fixture(); const { owner: { id: actor }, wid, project, field } = f
  const initial = service.getProjectFields(actor, wid, project.id)
  assert.deepEqual(initial, { projectId: project.id, fieldIds: [], builtInFields: [], statuses: initial.statuses, updatedAt: project.createdAt })
  assert.deepEqual(initial.statuses.map((status) => status.id), ['todo', 'backlog', 'in_progress', 'review', 'done'])
  const formula = service.createField(actor, wid, { name: 'Computed', type: 'formula' })
  const config = service.updateProjectFields(actor, wid, project.id, { fieldIds: [formula.id, field.id], builtInFields: ['description', 'priority'], expectedUpdatedAt: initial.updatedAt })
  assert.deepEqual(config.fieldIds, [formula.id, field.id]); assert.ok(config.updatedAt > initial.updatedAt)
  const task = service.createItem(actor, wid, { nodeId: f.list.id, title: 'Raw', customFields: { [field.id]: 12, [formula.id]: '{{Value}}+1' } })
  service.updateProjectFields(actor, wid, project.id, { fieldIds: [], builtInFields: [] })
  assert.deepEqual(service.getItem(actor, wid, task.id), task)
  const destination = service.createNode(actor, wid, { name: 'Destination', kind: 'project' })
  service.updateNode(actor, wid, f.list.id, { parentId: destination.id })
  assert.deepEqual(service.getItem(actor, wid, task.id), task)
  assert.equal(service.updateItem(actor, wid, task.id, { title: 'Still valid' }).customFields[formula.id], '{{Value}}+1')
  assert.equal(service.listFields(actor, wid).length, 2)
  assert.deepEqual(service.exportWorkspace(actor, wid).projectFields, service.getWorkspace(actor, wid).projectFields)
  assert.deepEqual(service.exportWorkspace(actor, wid).listStatusConfigs, service.getWorkspace(actor, wid).listStatusConfigs)
  assert.deepEqual(service.exportWorkspace(actor, wid).listTagColorConfigs, service.getWorkspace(actor, wid).listTagColorConfigs)
})

test('standalone root lists own fields and keep workflows synchronized across moves and exports', () => {
  const owner = user(); const wid = service.createWorkspace(owner.id, { name: 'Standalone fields' }).id
  const list = service.createNode(owner.id, wid, { name: 'Work Items', kind: 'list', parentId: null })
  const field = service.createField(owner.id, wid, { name: 'Estimate', type: 'number' })
  const initial = service.getProjectFields(owner.id, wid, list.id)
  assert.deepEqual(initial.fieldIds, []); assert.deepEqual(initial.builtInFields, [])
  const configured = service.updateProjectFields(owner.id, wid, list.id, {
    fieldIds: [field.id], builtInFields: ['tags'], dateFormat: 'dd/MM/yyyy', expectedUpdatedAt: initial.updatedAt,
  })
  assert.deepEqual(configured.fieldIds, [field.id]); assert.deepEqual(configured.builtInFields, ['tags'])
  const task = service.createItem(owner.id, wid, { nodeId: list.id, title: 'Scoped', tags: ['root'], customFields: { [field.id]: 3 } })
  const statuses = [{ id: 'todo', name: 'Open', color: '#123456', completed: false }, { id: 'closed', name: 'Closed', color: '#654321', completed: true }]
  service.updateListStatuses(owner.id, wid, list.id, { statuses, expectedUpdatedAt: list.createdAt })
  assert.deepEqual(service.getProjectFields(owner.id, wid, list.id).statuses, statuses)
  assert.deepEqual(service.exportWorkspace(owner.id, wid).projectFields, service.getWorkspace(owner.id, wid).projectFields)
  const project = service.createNode(owner.id, wid, { name: 'Destination', kind: 'project' })
  service.updateNode(owner.id, wid, list.id, { parentId: project.id })
  reject(() => service.getProjectFields(owner.id, wid, list.id), 400)
  service.updateNode(owner.id, wid, list.id, { parentId: null })
  assert.deepEqual(service.getProjectFields(owner.id, wid, list.id).fieldIds, [field.id])
  assert.deepEqual(service.getItem(owner.id, wid, task.id).customFields, { [field.id]: 3 })
  assert.equal(service.updateProjectFields(owner.id, wid, list.id, { dateFormat: null }).dateFormat, undefined)
  reject(() => service.updateProjectFields(owner.id, wid, list.id, { statuses }), 400)
})

test('membership and metadata permissions stay independent of task authorization', () => {
  const f = fixture()
  for (const permissions of [[], ['workspace:manage'], ['items:read'], ['structure:write']] as const) {
    const member = user()
    const role = service.createRole(f.owner.id, f.wid, { name: member.id, permissions })
    service.addMember(f.owner.id, f.wid, { email: member.email, roleId: role.id })
    const canRead = permissions.some((p) => p === 'items:read' || p === 'structure:write')
    assert.equal(service.getWorkspace(member.id, f.wid).projectFields.length, canRead ? 1 : 0)
    assert.equal(service.getWorkspace(member.id, f.wid).listStatusConfigs.length, canRead ? 1 : 0)
    assert.equal(service.getWorkspace(member.id, f.wid).listTagColorConfigs.length, canRead ? 1 : 0)
    if (canRead) {
      assert.equal(service.getProjectFields(member.id, f.wid, f.project.id).projectId, f.project.id)
      assert.deepEqual(service.getListStatuses(member.id, f.wid, f.list.id), { listId: f.list.id, updatedAt: f.list.createdAt, inheritedProjectUpdatedAt: f.project.createdAt })
      assert.deepEqual(service.getListTagColors(member.id, f.wid, f.list.id), { listId: f.list.id, colors: {}, updatedAt: f.list.createdAt })
    } else {
      reject(() => service.getProjectFields(member.id, f.wid, f.project.id), 403)
      reject(() => service.getListStatuses(member.id, f.wid, f.list.id), 403)
      reject(() => service.getListTagColors(member.id, f.wid, f.list.id), 403)
    }
    if (permissions.some((p) => p === 'structure:write')) {
      service.updateProjectFields(member.id, f.wid, f.project.id, { builtInFields: ['tags'] })
      service.updateListStatuses(member.id, f.wid, f.list.id, { statuses: null })
      const colors = service.getListTagColors(member.id, f.wid, f.list.id)
      service.updateListTagColors(member.id, f.wid, f.list.id, { colors: { blocked: '#123456' }, expectedUpdatedAt: colors.updatedAt })
      service.updateField(member.id, f.wid, f.field.id, { name: 'Managed value' })
      reject(() => service.listItems(member.id, f.wid), 403)
    } else {
      reject(() => service.updateProjectFields(member.id, f.wid, f.project.id, { fieldIds: [] }), 403)
      reject(() => service.updateListStatuses(member.id, f.wid, f.list.id, { statuses: null }), 403)
      reject(() => service.updateListTagColors(member.id, f.wid, f.list.id, { colors: {}, expectedUpdatedAt: f.list.createdAt }), 403)
      reject(() => service.updateField(member.id, f.wid, f.field.id, { name: 'Denied' }), 403)
    }
  }
  reject(() => service.getProjectFields(user().id, f.wid, f.project.id), 403)
  reject(() => service.getListStatuses(user().id, f.wid, f.list.id), 403)
  reject(() => service.getListTagColors(user().id, f.wid, f.list.id), 403)
})

test('list tag colors are bounded, list-scoped and revision-checked', () => {
  const f = fixture(); const other = fixture(); const actor = f.owner.id
  const initial = service.getListTagColors(actor, f.wid, f.list.id)
  const updated = service.updateListTagColors(actor, f.wid, f.list.id, { colors: { urgent: '#AA3344', waiting: '#123456' }, expectedUpdatedAt: initial.updatedAt })
  assert.deepEqual(updated.colors, { urgent: '#aa3344', waiting: '#123456' })
  assert.ok(updated.updatedAt > initial.updatedAt)
  reject(() => service.updateListTagColors(actor, f.wid, f.list.id, { colors: {}, expectedUpdatedAt: initial.updatedAt }), 409)
  reject(() => service.getListTagColors(actor, f.wid, f.project.id), 400)
  reject(() => service.getListTagColors(actor, f.wid, other.list.id), 404)
  assert.throws(() => service.updateListTagColors(actor, f.wid, f.list.id, { colors: Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`tag-${index}`, '#123456'])), expectedUpdatedAt: updated.updatedAt }))
  assert.throws(() => service.updateListTagColors(actor, f.wid, f.list.id, { colors: { bad: 'red' }, expectedUpdatedAt: updated.updatedAt }))
})

test('list view settings are per-user, readable by viewers, and enforce workspace and project field scope', () => {
  const f = fixture(); const other = fixture()
  const unassigned = service.createField(f.owner.id, f.wid, { name: 'Catalog only', type: 'text' })
  service.updateProjectFields(f.owner.id, f.wid, f.project.id, { fieldIds: [f.field.id], builtInFields: ['priority'] })
  const viewer = user()
  const viewerRole = service.createRole(f.owner.id, f.wid, { name: `Viewer ${viewer.id}`, permissions: ['items:read'] })
  service.addMember(f.owner.id, f.wid, { email: viewer.email, roleId: viewerRole.id })
  const writeOnly = user()
  const writeRole = service.createRole(f.owner.id, f.wid, { name: `Writer ${writeOnly.id}`, permissions: ['items:write'] })
  service.addMember(f.owner.id, f.wid, { email: writeOnly.email, roleId: writeRole.id })

  const projectDefault = service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id })
  assert.deepEqual(projectDefault, {
    view: 'list', projectId: f.project.id,
    columnOrder: ['title', 'status', 'assigneeId', 'dueDate', 'priority', `custom:${f.field.id}`],
    hiddenColumns: [], sort: null, updatedAt: null,
  })
  const viewerSettings = service.updateListViewSettings(viewer.id, f.wid, {
    projectId: f.project.id, columnOrder: ['title', `custom:${f.field.id}`, 'status'], hiddenColumns: ['status'],
    sort: { column: `custom:${f.field.id}`, direction: 'desc' }, expectedUpdatedAt: null,
  })
  assert.equal(viewerSettings.projectId, f.project.id)
  assert.notEqual(viewerSettings.updatedAt, null)
  assert.equal(service.getListViewSettings(f.owner.id, f.wid, { projectId: f.project.id }).updatedAt, null)
  assert.deepEqual(service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id }), viewerSettings)

  const allSettings = service.updateListViewSettings(viewer.id, f.wid, {
    projectId: null, columnOrder: ['title', `custom:${unassigned.id}`], hiddenColumns: [], sort: null, expectedUpdatedAt: null,
  })
  assert.equal(allSettings.projectId, null)
  assert.equal((db.prepare('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND userId=?').get(f.wid, viewer.id) as { count: number }).count, 2)
  reject(() => service.updateListViewSettings(viewer.id, f.wid, { projectId: f.project.id, columnOrder: ['title', `custom:${unassigned.id}`], hiddenColumns: [], sort: null, expectedUpdatedAt: viewerSettings.updatedAt }), 400)
  reject(() => service.updateListViewSettings(viewer.id, f.wid, { projectId: f.project.id, columnOrder: ['title', `custom:${other.field.id}`], hiddenColumns: [], sort: null, expectedUpdatedAt: viewerSettings.updatedAt }), 400)
  reject(() => service.getListViewSettings(viewer.id, f.wid, { projectId: f.list.id }), 400)
  reject(() => service.getListViewSettings(viewer.id, f.wid, { projectId: other.project.id }), 404)
  for (const actor of [writeOnly.id, user().id]) {
    reject(() => service.getListViewSettings(actor, f.wid), 403)
    reject(() => service.updateListViewSettings(actor, f.wid, { columnOrder: ['title'], hiddenColumns: [], sort: null, expectedUpdatedAt: null }), 403)
  }

  service.updateProjectFields(f.owner.id, f.wid, f.project.id, { fieldIds: [] })
  const reconciledProject = service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id })
  assert.equal(reconciledProject.columnOrder.includes(`custom:${f.field.id}`), false)
  assert.equal(reconciledProject.sort, null)
  service.updateProjectFields(f.owner.id, f.wid, f.project.id, { fieldIds: [f.field.id] })
  assert.equal(service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id }).columnOrder.includes(`custom:${f.field.id}`), false)
  service.deleteField(f.owner.id, f.wid, unassigned.id)
  assert.equal(service.getListViewSettings(viewer.id, f.wid).columnOrder.includes(`custom:${unassigned.id}`), false)
})

test('list view validation, optimistic concurrency, audit rollback and membership cascade are atomic', () => {
  const f = fixture(); const actor = f.owner.id
  const valid = { columnOrder: ['title', 'status'], hiddenColumns: [], sort: { column: 'status', direction: 'asc' }, expectedUpdatedAt: null } as const
  for (const body of [
    {},
    { ...valid, userId: actor },
    { ...valid, columnOrder: ['status'] },
    { ...valid, hiddenColumns: ['title'] },
    { ...valid, hiddenColumns: ['dueDate'] },
    { ...valid, sort: { column: 'dueDate', direction: 'asc' } },
    { ...valid, sort: { column: 'status', direction: 'up' } },
    { ...valid, columnOrder: ['title', 'title'] },
    { ...valid, columnOrder: ['title', 'unknown'] },
    { ...valid, expectedUpdatedAt: undefined },
  ]) assert.throws(() => service.updateListViewSettings(actor, f.wid, body))

  const beforeAudits = db.prepare("SELECT count(*) AS count FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update'").get(f.wid)
  db.exec("CREATE TEMP TRIGGER fail_view_settings_audit BEFORE INSERT ON audit_logs WHEN NEW.action='list.view.settings.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { assert.throws(() => service.updateListViewSettings(actor, f.wid, valid), /audit unavailable/) }
  finally { db.exec('DROP TRIGGER fail_view_settings_audit') }
  assert.equal(service.getListViewSettings(actor, f.wid).updatedAt, null)
  assert.deepEqual(db.prepare("SELECT count(*) AS count FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update'").get(f.wid), beforeAudits)

  const created = service.updateListViewSettings(actor, f.wid, valid)
  reject(() => service.updateListViewSettings(actor, f.wid, { ...valid, expectedUpdatedAt: null }), 409)
  const updated = service.updateListViewSettings(actor, f.wid, { ...valid, hiddenColumns: ['status'], sort: null, expectedUpdatedAt: created.updatedAt })
  reject(() => service.updateListViewSettings(actor, f.wid, { ...valid, expectedUpdatedAt: created.updatedAt }), 409)
  assert.deepEqual(service.getListViewSettings(actor, f.wid), updated)
  assert.equal((db.prepare("SELECT count(*) AS count FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update'").get(f.wid) as { count: number }).count, 2)
  assert.deepEqual(JSON.parse((db.prepare("SELECT details FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update' ORDER BY createdAt DESC LIMIT 1").get(f.wid) as { details: string }).details), { projectScoped: false, columns: 2, hidden: 1, sorted: false })

  const member = user()
  const role = service.createRole(actor, f.wid, { name: member.id, permissions: ['items:read'] })
  service.addMember(actor, f.wid, { email: member.email, roleId: role.id })
  service.updateListViewSettings(member.id, f.wid, valid)
  assert.equal((db.prepare('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND userId=?').get(f.wid, member.id) as { count: number }).count, 1)
  service.deleteMember(actor, f.wid, member.id)
  assert.equal((db.prepare('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND userId=?').get(f.wid, member.id) as { count: number }).count, 0)

  const disposableProject = service.createNode(actor, f.wid, { name: 'Disposable', kind: 'project' })
  service.updateListViewSettings(actor, f.wid, { projectId: disposableProject.id, ...valid })
  service.deleteNode(actor, f.wid, disposableProject.id)
  assert.equal((db.prepare('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND projectId=?').get(f.wid, disposableProject.id) as { count: number }).count, 0)
})

test('create and link are atomic, retain Field shape, and configuration/audit failures roll back', () => {
  const f = fixture(); const actor = f.owner.id
  const before = service.getProjectFields(actor, f.wid, f.project.id)
  for (const projectId of [randomUUID(), f.list.id]) assert.throws(() => service.createField(actor, f.wid, { name: 'Invalid target', type: 'text', projectId }))
  assert.equal(service.listFields(actor, f.wid).length, 1)
  db.exec("CREATE TEMP TRIGGER fail_project_audit BEFORE INSERT ON audit_logs WHEN NEW.action IN ('field.create','project.fields.update') BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try {
    assert.throws(() => service.createField(actor, f.wid, { name: 'Rollback', type: 'text', projectId: f.project.id }), /audit unavailable/)
    assert.throws(() => service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [f.field.id], builtInFields: ['tags'] }), /audit unavailable/)
  } finally { db.exec('DROP TRIGGER fail_project_audit') }
  assert.deepEqual(service.getProjectFields(actor, f.wid, f.project.id), before)
  assert.equal(service.listFields(actor, f.wid).length, 1)
  const auditCount = db.prepare('SELECT count(*) AS n FROM audit_logs').get()
  db.exec("CREATE TEMP TRIGGER fail_outer_audit BEFORE INSERT ON audit_logs WHEN NEW.action='field.create' BEGIN SELECT RAISE(ABORT,'outer audit unavailable'); END")
  try { assert.throws(() => service.createField(actor, f.wid, { name: 'Outer rollback', type: 'text', projectId: f.project.id }), /outer audit unavailable/) }
  finally { db.exec('DROP TRIGGER fail_outer_audit') }
  assert.deepEqual(service.getProjectFields(actor, f.wid, f.project.id), before)
  assert.equal(service.listFields(actor, f.wid).length, 1)
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM audit_logs').get(), auditCount)
  const linked = service.createField(actor, f.wid, { name: 'Linked secret name', type: 'text', projectId: f.project.id })
  assert.deepEqual(Object.keys(linked).sort(), ['id', 'name', 'options', 'type', 'workspaceId'])
  const config = service.getProjectFields(actor, f.wid, f.project.id)
  assert.deepEqual(config.fieldIds, [linked.id]); assert.ok(config.updatedAt > before.updatedAt)
  reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [], expectedUpdatedAt: before.updatedAt }), 409)
  assert.equal(JSON.stringify(db.prepare('SELECT details FROM audit_logs WHERE workspaceId=?').all(f.wid)).includes(linked.name), false)
  assert.throws(() => db.prepare('INSERT INTO project_field_assignments VALUES (?,?,?,?)').run(f.wid, f.project.id, fixture().field.id, 0), /FOREIGN KEY/)
})

test('mixed cleanup scans every row once, preserves untouched versions, updates config revisions and rolls back', () => {
  const f = fixture(); const actor = f.owner.id
  const config = service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [f.field.id] })
  const tasks = Array.from({ length: 450 }, (_, n) => service.createItem(actor, f.wid, { nodeId: f.list.id, title: String(n), customFields: n % 3 === 1 ? { [f.field.id]: n } : {} }))
  db.exec("CREATE TEMP TRIGGER fail_delete_audit BEFORE INSERT ON audit_logs WHEN NEW.action='field.delete' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { assert.throws(() => service.deleteField(actor, f.wid, f.field.id), /audit unavailable/) }
  finally { db.exec('DROP TRIGGER fail_delete_audit') }
  assert.deepEqual(service.getProjectFields(actor, f.wid, f.project.id), config)
  for (const task of tasks) assert.deepEqual(service.getItem(actor, f.wid, task.id), task)
  assert.deepEqual(service.deleteField(actor, f.wid, f.field.id), { success: true })
  for (const task of tasks) {
    const current = service.getItem(actor, f.wid, task.id)
    assert.deepEqual(current.customFields, {})
    if (Object.keys(task.customFields).length) assert.ok(current.updatedAt > task.updatedAt)
    else assert.deepEqual(current, task)
  }
  const current = service.getProjectFields(actor, f.wid, f.project.id)
  assert.deepEqual(current.fieldIds, []); assert.ok(current.updatedAt > config.updatedAt)
  reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [], expectedUpdatedAt: config.updatedAt }), 409)
  assert.deepEqual(JSON.parse((db.prepare("SELECT details FROM audit_logs WHERE workspaceId=? AND action='field.delete'").get(f.wid) as { details: string }).details), { touched: 150 })
})

test('migration backfills only actual old projects, preserves values and enforces workspace foreign keys', () => {
  const old = new Database(join(directory, 'old.sqlite'))
  try {
    old.pragma('foreign_keys = ON')
    for (const name of ['001_core.sql', '002_integrations.sql', '003_item_read_index.sql', '004_field_formula.sql']) old.exec(readFileSync(new URL(`../database/migrations/${name}`, import.meta.url), 'utf8'))
    old.exec("INSERT INTO workspaces VALUES ('w','Old','2026-01-01T00:00:00.000Z'); INSERT INTO nodes VALUES ('p','w','Project','project',NULL,'2026-01-01T00:00:00.000Z'),('l','w','List','list','p','2026-01-01T00:00:00.000Z'); INSERT INTO fields VALUES ('f','w','Field','text','[]'); INSERT INTO items(id,workspaceId,nodeId,title,status,priority,customFields,createdAt,updatedAt) VALUES ('i','w','l','Old','todo','none','{\"f\":\"preserved\"}','old','old')")
    const before = old.prepare('SELECT * FROM items').get()
    old.exec("INSERT INTO workspaces VALUES ('other','Other','2026-01-01T00:00:00.000Z'); INSERT INTO nodes VALUES ('p2','w','Second project','project',NULL,'2026-01-01T00:00:00.000Z'),('empty','other','Empty project','project',NULL,'2026-01-01T00:00:00.000Z')")
    old.transaction(() => old.exec(readFileSync(new URL('../database/migrations/005_project_fields.sql', import.meta.url), 'utf8')))()
    assert.deepEqual(old.prepare('SELECT * FROM items').get(), before)
    assert.deepEqual(old.prepare('SELECT projectId,fieldId FROM project_field_assignments ORDER BY projectId').all(), [{ projectId: 'p', fieldId: 'f' }, { projectId: 'p2', fieldId: 'f' }])
    assert.deepEqual(old.prepare('SELECT projectId FROM project_field_configs ORDER BY projectId').all(), [{ projectId: 'empty' }, { projectId: 'p' }, { projectId: 'p2' }])
    assert.deepEqual(JSON.parse((old.prepare('SELECT builtInFields FROM project_field_configs').get() as { builtInFields: string }).builtInFields), ['priority', 'startDate', 'tags', 'nodeId', 'createdAt', 'updatedAt'])
    assert.deepEqual(old.pragma('foreign_key_check'), [])
  } finally { old.close() }
})

test('real HTTP GET/PATCH and streaming export match the complete service contract', { timeout: 20000 }, async () => {
  const f = fixture(); const actor = f.owner.id
  service.createField(actor, f.wid, { name: 'Linked', type: 'text', projectId: f.project.id })
  const token = randomUUID()
  db.prepare('INSERT INTO tokens(id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)').run(randomUUID(), actor, 'Test', createHash('sha256').update(token).digest('hex'), '2099-01-01T00:00:00.000Z', f.project.createdAt)
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const child = spawn(process.execPath, process.env.HOPYA_TEST_BUILD === 'true' ? ['build/bin/server.js'] : ['--import', 'tsx', 'bin/server.ts'], { cwd: new URL('../', import.meta.url), env: { ...process.env, DATA_DIR: directory, API_PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test', APP_KEY: 'project-fields-test-key-12345678901234567890', APP_URL: 'http://localhost:4321', AI_PROVIDER: '', OIDC_ISSUER: '', STORAGE_DRIVER: 'filesystem', LOG_LEVEL: 'fatal' }, stdio: 'ignore' })
  try {
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let n = 0; n < 100; n++) { try { if ((await fetch(`${base}/health`)).ok) { ready = true; break } } catch {} await new Promise((resolve) => setTimeout(resolve, 100)) }
    assert.ok(ready)
    const path = `${base}/api/v1/workspaces/${f.wid}`
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const endpoint = `${path}/projects/${f.project.id}/fields`
    const listEndpoint = `${path}/lists/${f.list.id}/statuses`
    const viewEndpoint = `${path}/views/list/settings`
    assert.deepEqual(await (await fetch(endpoint, { headers })).json(), service.getProjectFields(actor, f.wid, f.project.id))
    const statuses = [{ id: 'queued', name: 'Queued', color: '#123abc', completed: false }, { id: 'closed', name: 'Closed', color: '#456def', completed: true }]
    const patch = await fetch(endpoint, { headers, method: 'PATCH', body: JSON.stringify({ builtInFields: ['description'], statuses, dateFormat: 'dd/MM/yyyy' }) })
    assert.equal(patch.status, 200)
    const config = await patch.json()
    assert.deepEqual(config, service.getProjectFields(actor, f.wid, f.project.id))
    assert.equal((await fetch(endpoint, { headers, method: 'PATCH', body: JSON.stringify({ fieldIds: [], expectedUpdatedAt: f.project.createdAt }) })).status, 409)
    const inheritedListConfig = service.getListStatuses(actor, f.wid, f.list.id)
    assert.deepEqual(await (await fetch(listEndpoint, { headers })).json(), inheritedListConfig)
    const listPatch = await fetch(listEndpoint, { headers, method: 'PATCH', body: JSON.stringify({ statuses, expectedUpdatedAt: f.list.createdAt, expectedProjectUpdatedAt: inheritedListConfig.inheritedProjectUpdatedAt }) })
    assert.equal(listPatch.status, 200)
    const listConfig = await listPatch.json() as { updatedAt: string }
    assert.equal((await fetch(listEndpoint, { headers, method: 'PATCH', body: JSON.stringify({ statuses: null, expectedUpdatedAt: f.list.createdAt }) })).status, 409)
    const nodePatch = await fetch(`${path}/nodes/${f.project.id}`, { headers, method: 'PATCH', body: JSON.stringify({ description: 'Project notes' }) })
    assert.equal(nodePatch.status, 200)
    assert.equal((await nodePatch.json() as { description: string }).description, 'Project notes')
    const fieldResponse = await fetch(`${path}/fields`, { headers, method: 'POST', body: JSON.stringify({ name: 'HTTP checklist', type: 'checklist', options: ['A', 'B'], projectId: f.project.id }) })
    assert.equal(fieldResponse.status, 201)
    const checklist = await fieldResponse.json() as { id: string }
    const rating = service.createField(actor, f.wid, { name: 'HTTP rating', type: 'rating' })
    const fieldPatch = await fetch(`${path}/fields/${rating.id}`, { headers, method: 'PATCH', body: JSON.stringify({ settings: { maxRating: 10 } }) })
    assert.equal(fieldPatch.status, 200)
    assert.deepEqual((await fieldPatch.json() as { settings: unknown }).settings, { maxRating: 10 })
    const itemResponse = await fetch(`${path}/items`, { headers, method: 'POST', body: JSON.stringify({ nodeId: f.list.id, title: 'HTTP values', customFields: { [checklist.id]: ['B'], [rating.id]: 10 } }) })
    assert.equal(itemResponse.status, 201)
    const item = await itemResponse.json() as { id: string; status: string }
    assert.equal(item.status, 'queued')
    assert.deepEqual((await (await fetch(`${path}/items/page?status=queued`, { headers })).json() as { items: unknown[] }).items, service.listItems(actor, f.wid, { status: 'queued' }))
    const exported = await (await fetch(`${path}/export`, { headers })).json() as Record<string, unknown>
    const expected = service.exportWorkspace(actor, f.wid)
    assert.deepEqual({ ...exported, exportedAt: '' }, { ...expected, exportedAt: '' })
    assert.deepEqual((await (await fetch(path, { headers })).json() as { projectFields: unknown }).projectFields, expected.projectFields)
    assert.deepEqual((await (await fetch(path, { headers })).json() as { listStatusConfigs: unknown }).listStatusConfigs, expected.listStatusConfigs)
    const initialView = await (await fetch(`${viewEndpoint}?projectId=${f.project.id}`, { headers })).json() as { updatedAt: null }
    assert.equal(initialView.updatedAt, null)
    const viewPatch = await fetch(viewEndpoint, { headers, method: 'PATCH', body: JSON.stringify({ projectId: f.project.id, columnOrder: ['title', 'priority'], hiddenColumns: ['priority'], sort: { column: 'title', direction: 'asc' }, expectedUpdatedAt: null }) })
    assert.equal(viewPatch.status, 200)
    const actorView = await viewPatch.json() as { updatedAt: string }
    const viewer = user()
    const viewerRole = service.createRole(actor, f.wid, { name: viewer.id, permissions: ['items:read'] })
    service.addMember(actor, f.wid, { email: viewer.email, roleId: viewerRole.id })
    const viewerToken = randomUUID()
    db.prepare('INSERT INTO tokens(id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)').run(randomUUID(), viewer.id, 'Viewer', createHash('sha256').update(viewerToken).digest('hex'), '2099-01-01T00:00:00.000Z', f.project.createdAt)
    const viewerHeaders = { authorization: `Bearer ${viewerToken}`, 'content-type': 'application/json' }
    assert.equal((await (await fetch(`${viewEndpoint}?projectId=${f.project.id}`, { headers: viewerHeaders })).json() as { updatedAt: null }).updatedAt, null)
    const viewerPatch = await fetch(viewEndpoint, { headers: viewerHeaders, method: 'PATCH', body: JSON.stringify({ projectId: f.project.id, columnOrder: ['title'], hiddenColumns: [], sort: null, expectedUpdatedAt: null }) })
    assert.equal(viewerPatch.status, 200)
    assert.equal((await (await fetch(`${viewEndpoint}?projectId=${f.project.id}`, { headers })).json() as { updatedAt: string }).updatedAt, actorView.updatedAt)
    assert.equal((await fetch(viewEndpoint, { headers: viewerHeaders, method: 'PATCH', body: JSON.stringify({ userId: actor, columnOrder: ['title'], hiddenColumns: [], sort: null, expectedUpdatedAt: null }) })).status, 400)
    assert.ok(listConfig.updatedAt > f.list.createdAt)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited; clearTimeout(timer)
    }
  }
})

test('list overrides control defaults and moves while project changes validate only inheriting lists', () => {
  const f = fixture(); const actor = f.owner.id
  const projectStatuses = [{ id: 'queued', name: 'Queued', color: '#112233', completed: false }, { id: 'closed', name: 'Closed', color: '#445566', completed: true }]
  const overrideStatuses = [{ id: 'local', name: 'Local', color: '#abcdef', completed: false }, projectStatuses[1]!]
  const initial = service.getListStatuses(actor, f.wid, f.list.id)
  service.updateProjectFields(actor, f.wid, f.project.id, { statuses: projectStatuses })
  const auditsAfterProjectChange = db.prepare('SELECT count(*) AS count FROM audit_logs WHERE workspaceId=?').get(f.wid)
  reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: overrideStatuses, expectedUpdatedAt: initial.updatedAt }), 400)
  reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: overrideStatuses, expectedUpdatedAt: initial.updatedAt, expectedProjectUpdatedAt: initial.inheritedProjectUpdatedAt }), 409)
  assert.deepEqual(db.prepare('SELECT count(*) AS count FROM audit_logs WHERE workspaceId=?').get(f.wid), auditsAfterProjectChange)
  const fresh = service.getListStatuses(actor, f.wid, f.list.id)
  assert.equal(fresh.statuses, undefined)
  const inherited = service.createNode(actor, f.wid, { kind: 'list', name: 'Inherited', parentId: f.project.id })
  const inheritedItem = service.createItem(actor, f.wid, { nodeId: inherited.id, title: 'Inherited default' })
  const override = service.updateListStatuses(actor, f.wid, f.list.id, { statuses: overrideStatuses, expectedUpdatedAt: fresh.updatedAt, expectedProjectUpdatedAt: fresh.inheritedProjectUpdatedAt })
  const item = service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Override default' })
  assert.equal(item.status, 'local')
  reject(() => service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Invalid', status: 'queued' }), 400)
  reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: null }), 409)
  reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [projectStatuses[1]!] }), 409)
  service.updateItem(actor, f.wid, inheritedItem.id, { status: 'closed' })
  service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [projectStatuses[1]!] })
  assert.equal(service.getItem(actor, f.wid, item.id).status, 'local')
  service.updateItem(actor, f.wid, item.id, { status: 'closed' })
  const inheritedConfig = service.updateListStatuses(actor, f.wid, f.list.id, { statuses: null, expectedUpdatedAt: override.updatedAt })
  assert.equal(inheritedConfig.statuses, undefined)

  const destination = service.createNode(actor, f.wid, { kind: 'project', name: 'Destination' })
  const destinationStatuses = [{ id: 'target', name: 'Target', color: '#654321', completed: false }]
  service.updateProjectFields(actor, f.wid, destination.id, { statuses: destinationStatuses })
  const folder = service.createNode(actor, f.wid, { kind: 'folder', name: 'Mixed', parentId: f.project.id })
  const movingInherited = service.createNode(actor, f.wid, { kind: 'list', name: 'Moving inherited', parentId: folder.id })
  const movingOverride = service.createNode(actor, f.wid, { kind: 'list', name: 'Moving override', parentId: folder.id })
  const movingOverrideConfig = service.getListStatuses(actor, f.wid, movingOverride.id)
  service.updateListStatuses(actor, f.wid, movingOverride.id, { statuses: overrideStatuses, expectedProjectUpdatedAt: movingOverrideConfig.inheritedProjectUpdatedAt })
  const inheritedMoveTask = service.createItem(actor, f.wid, { nodeId: movingInherited.id, title: 'Move inherited' })
  const overrideMoveTask = service.createItem(actor, f.wid, { nodeId: movingOverride.id, title: 'Move override' })
  reject(() => service.updateNode(actor, f.wid, folder.id, { parentId: destination.id }), 409)
  service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [projectStatuses[1]!, destinationStatuses[0]!] })
  service.updateItem(actor, f.wid, inheritedMoveTask.id, { status: 'target' })
  service.updateNode(actor, f.wid, folder.id, { parentId: destination.id })
  assert.equal(service.getItem(actor, f.wid, overrideMoveTask.id).status, 'local')
  const movedOverrideConfig = service.getListStatuses(actor, f.wid, movingOverride.id)
  assert.deepEqual(movedOverrideConfig.statuses, overrideStatuses)
  assert.equal(movedOverrideConfig.inheritedProjectUpdatedAt, service.getProjectFields(actor, f.wid, destination.id).updatedAt)

  const destinationList = service.createNode(actor, f.wid, { kind: 'list', name: 'Override destination', parentId: destination.id })
  const destinationListConfig = service.getListStatuses(actor, f.wid, destinationList.id)
  service.updateListStatuses(actor, f.wid, destinationList.id, { statuses: [overrideStatuses[0]!], expectedProjectUpdatedAt: destinationListConfig.inheritedProjectUpdatedAt })
  reject(() => service.updateItem(actor, f.wid, inheritedItem.id, { nodeId: destinationList.id }), 400)
  assert.equal(service.updateItem(actor, f.wid, inheritedItem.id, { nodeId: destinationList.id, status: 'local' }).status, 'local')

  const standalone = service.createNode(actor, f.wid, { kind: 'list', name: 'Standalone' })
  const standaloneConfig = service.getListStatuses(actor, f.wid, standalone.id)
  assert.ok(standaloneConfig.statuses?.length)
  assert.equal(standaloneConfig.inheritedProjectUpdatedAt, undefined)
  assert.equal(service.createItem(actor, f.wid, { nodeId: standalone.id, title: 'Standalone default' }).status, standaloneConfig.statuses![0]!.id)
  reject(() => service.updateListStatuses(actor, f.wid, standalone.id, { statuses: null }), 400)
  service.updateNode(actor, f.wid, standalone.id, { parentId: destination.id, expectedParentId: null })
  assert.deepEqual(service.getListStatuses(actor, f.wid, standalone.id).statuses, standaloneConfig.statuses)

  service.updateNode(actor, f.wid, movingInherited.id, { parentId: null, expectedParentId: folder.id })
  const materialized = service.getListStatuses(actor, f.wid, movingInherited.id)
  assert.deepEqual(materialized.statuses, destinationStatuses)
  assert.equal(materialized.inheritedProjectUpdatedAt, undefined)
  assert.equal(service.getItem(actor, f.wid, inheritedMoveTask.id).status, 'target')
  assert.ok(service.exportWorkspace(actor, f.wid).nodes.some(node => node.id === movingInherited.id && node.parentId === null))
})

test('status configuration rejects unsafe and duplicate IDs, invalid colors, bounds and stale writes; audit failures roll back', () => {
  const f = fixture(); const actor = f.owner.id
  const initial = service.getProjectFields(actor, f.wid, f.project.id)
  const status = { id: 'ready', name: 'Ready', color: '#abcdef', completed: false }
  for (const statuses of [[], Array(51).fill(status), [status, status], [{ ...status, id: 'unsafe id' }], [{ ...status, id: 'a'.repeat(65) }], [{ ...status, color: 'red' }], [{ ...status, completed: 'false' }], [{ ...status, name: '' }]]) {
    assert.throws(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses }))
  }
  assert.throws(() => service.updateProjectFields(actor, f.wid, f.project.id, { dateFormat: 'arbitrary' }))
  db.exec("CREATE TEMP TRIGGER fail_status_audit BEFORE INSERT ON audit_logs WHEN NEW.action='project.fields.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { assert.throws(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [status], dateFormat: 'MMM d, yyyy' }), /audit unavailable/) }
  finally { db.exec('DROP TRIGGER fail_status_audit') }
  assert.deepEqual(service.getProjectFields(actor, f.wid, f.project.id), initial)
  const updated = service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [status], dateFormat: 'MMMM d, yyyy', expectedUpdatedAt: initial.updatedAt })
  assert.ok(updated.updatedAt > initial.updatedAt)
  reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses: initial.statuses, expectedUpdatedAt: initial.updatedAt }), 409)
  const listInitial = service.getListStatuses(actor, f.wid, f.list.id)
  db.exec("CREATE TEMP TRIGGER fail_list_status_audit BEFORE INSERT ON audit_logs WHEN NEW.action='list.statuses.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { assert.throws(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: [status], expectedProjectUpdatedAt: listInitial.inheritedProjectUpdatedAt }), /audit unavailable/) }
  finally { db.exec('DROP TRIGGER fail_list_status_audit') }
  assert.deepEqual(service.getListStatuses(actor, f.wid, f.list.id), listInitial)
  const listUpdated = service.updateListStatuses(actor, f.wid, f.list.id, { statuses: [status], expectedUpdatedAt: listInitial.updatedAt, expectedProjectUpdatedAt: listInitial.inheritedProjectUpdatedAt })
  reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: null, expectedUpdatedAt: listInitial.updatedAt }), 409)
  assert.deepEqual(service.getListStatuses(actor, f.wid, f.list.id), listUpdated)
  const empty = service.createNode(actor, f.wid, { name: 'Delete config', kind: 'list', parentId: f.project.id })
  assert.ok(db.prepare('SELECT listId FROM list_status_configs WHERE workspaceId=? AND listId=?').get(f.wid, empty.id))
  service.deleteNode(actor, f.wid, empty.id)
  assert.equal(db.prepare('SELECT listId FROM list_status_configs WHERE workspaceId=? AND listId=?').get(f.wid, empty.id), undefined)
})

test('date formats, datetime, checklist and rating enforce typed values and safe editable settings including retained values', () => {
  const f = fixture(); const actor = f.owner.id
  const date = service.createField(actor, f.wid, { name: 'Date', type: 'date', settings: { dateFormat: 'dd/MM/yyyy' } })
  const datetime = service.createField(actor, f.wid, { name: 'Time', type: 'datetime', settings: { dateFormat: 'MMM d, yyyy' } })
  const checklist = service.createField(actor, f.wid, { name: 'Checks', type: 'checklist', options: ['A', 'B'] })
  const rating = service.createField(actor, f.wid, { name: 'Rating', type: 'rating', settings: { maxRating: 7 } })
  const select = service.createField(actor, f.wid, { name: 'Dropdown', type: 'select', options: ['A', 'B'] })
  const values = { [date.id]: '2026-09-07', [datetime.id]: '2026-09-07T14:30:00+08:00', [checklist.id]: ['B'], [rating.id]: 7, [select.id]: 'A' }
  const task = service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Typed', customFields: values })
  assert.deepEqual(task.customFields, values)
  for (const [field, invalid] of [[datetime, '2026-09-07'], [datetime, '2026-02-30T00:00:00Z'], [checklist, ['A', 'A']], [checklist, ['C']], [checklist, 'A'], [rating, 0], [rating, 8], [rating, 1.5], [rating, '5']] as const) {
    reject(() => service.updateItem(actor, f.wid, task.id, { customFields: { [field.id]: invalid } }), 400)
  }
  reject(() => service.updateField(actor, f.wid, rating.id, { settings: { maxRating: 5 } }), 409)
  reject(() => service.updateField(actor, f.wid, checklist.id, { options: ['A'] }), 409)
  reject(() => service.updateField(actor, f.wid, select.id, { options: ['B'] }), 409)
  assert.deepEqual(service.getItem(actor, f.wid, task.id), task)
  assert.equal(service.updateField(actor, f.wid, date.id, { name: 'Renamed date', settings: { dateFormat: 'MMMM d, yyyy' } }).settings?.dateFormat, 'MMMM d, yyyy')
  assert.deepEqual(service.updateField(actor, f.wid, checklist.id, { options: ['B', 'C'] }).options, ['B', 'C'])
  service.updateItem(actor, f.wid, task.id, { customFields: { [rating.id]: null, [checklist.id]: [] } })
  service.updateField(actor, f.wid, rating.id, { settings: { maxRating: 1 } })
  service.updateField(actor, f.wid, checklist.id, { options: ['C'] })
  for (const input of [{ settings: { dateFormat: 'bad' } }, { settings: { maxRating: 11 } }, { settings: { maxRating: 0 } }, { settings: { maxRating: 1.5 } }, { settings: { other: true } }, { type: 'text' }, {}]) assert.throws(() => service.updateField(actor, f.wid, rating.id, input))
  reject(() => service.updateField(actor, f.wid, rating.id, { settings: { dateFormat: 'yyyy-MM-dd' } }), 400)
  reject(() => service.createField(actor, f.wid, { name: 'Invalid', type: 'date', settings: { maxRating: 5 } }), 400)
  reject(() => service.createField(actor, f.wid, { name: 'Invalid', type: 'checklist', options: [] }), 400)
  reject(() => service.updateField(actor, f.wid, fixture().field.id, { name: 'Foreign' }), 404)
  reject(() => service.updateField(user().id, f.wid, rating.id, { name: 'Denied' }), 403)
  const before = service.listFields(actor, f.wid)
  db.exec("CREATE TEMP TRIGGER fail_settings_audit BEFORE INSERT ON audit_logs WHEN NEW.action='field.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { assert.throws(() => service.updateField(actor, f.wid, rating.id, { name: 'Rollback', settings: { maxRating: 10 } }), /audit unavailable/) }
  finally { db.exec('DROP TRIGGER fail_settings_audit') }
  assert.deepEqual(service.listFields(actor, f.wid), before)
  assert.deepEqual(service.exportWorkspace(actor, f.wid).fields, before)
})

test('field renames protect stored formula references but ignore quoted literals and other workspaces', () => {
  const f = fixture(); const actor = f.owner.id
  service.updateField(actor, f.wid, f.field.id, { name: 'Qty' })
  const formula = service.createField(actor, f.wid, { name: 'Total', type: 'formula' })
  const text = service.createField(actor, f.wid, { name: 'Notes', type: 'text' })
  const task = service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Retained unassigned formula', customFields: { [f.field.id]: 2, [formula.id]: 'CONCAT("{{Qty}}", {{Qty}})' } })
  const before = service.listFields(actor, f.wid)
  const audits = db.prepare('SELECT count(*) AS n FROM audit_logs WHERE workspaceId=?').get(f.wid)
  assert.throws(() => service.updateField(actor, f.wid, f.field.id, { name: 'Quantity' }), (error: unknown) => error instanceof HttpError && error.status === 409 && /formulas.*before renaming/.test(error.message))
  assert.deepEqual(service.listFields(actor, f.wid), before)
  assert.deepEqual(service.getItem(actor, f.wid, task.id), task)
  assert.deepEqual(db.prepare('SELECT count(*) AS n FROM audit_logs WHERE workspaceId=?').get(f.wid), audits)
  assert.equal(service.updateField(actor, f.wid, f.field.id, { name: ' Qty ' }).name, 'Qty')
  const other = fixture()
  service.updateField(other.owner.id, other.wid, other.field.id, { name: 'Qty' })
  const otherFormula = service.createField(other.owner.id, other.wid, { name: 'Total', type: 'formula' })
  service.createItem(other.owner.id, other.wid, { nodeId: other.list.id, title: 'Other workspace', customFields: { [otherFormula.id]: '{{Qty}}*2' } })
  const quoted = service.updateItem(actor, f.wid, task.id, { customFields: { [formula.id]: 'CONCAT("a ""{{Qty}}""", "{{Qty}}")', [text.id]: '{{Qty}}' } })
  assert.equal(service.updateField(actor, f.wid, f.field.id, { name: 'Quantity' }).name, 'Quantity')
  assert.deepEqual(service.getItem(actor, f.wid, task.id), quoted)
})

test('migrations 006 and 007 preserve legacy data and backfill inherited list status rows', () => {
  const old = new Database(join(directory, 'features-old.sqlite'))
  try {
    old.pragma('foreign_keys = ON')
    for (const name of ['001_core.sql', '002_integrations.sql', '003_item_read_index.sql', '004_field_formula.sql', '005_project_fields.sql']) old.exec(readFileSync(new URL(`../database/migrations/${name}`, import.meta.url), 'utf8'))
    old.exec(`INSERT INTO workspaces VALUES ('w','Old','2026-01-01T00:00:00.000Z');
      INSERT INTO nodes VALUES ('p','w','Project','project',NULL,'old'),('l','w','List','list','p','old');
      INSERT INTO fields VALUES ('f','w','Field','text','[]');
      INSERT INTO project_field_configs(workspaceId,projectId,updatedAt) VALUES ('w','p','old');
      INSERT INTO project_field_assignments VALUES ('w','p','f',0);
      INSERT INTO storage_objects VALUES ('object','filesystem','local','old');`)
    for (const status of ['backlog', 'todo', 'in_progress', 'review', 'done']) old.prepare("INSERT INTO items(id,workspaceId,nodeId,title,status,priority,customFields,createdAt,updatedAt) VALUES (?,'w','l','Old',?,'none','{\"f\":\"preserved\"}','old','old')").run(status, status)
    old.exec("INSERT INTO attachments(id,workspaceId,itemId,objectKey,name,contentType,size,createdAt) VALUES ('a','w','todo','object','file','text/plain',1,'old')")
    const tables = ['items', 'attachments', 'storage_objects', 'project_field_assignments']
    const before = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all())
    old.pragma('foreign_keys = OFF')
    old.transaction(() => {
      old.exec(readFileSync(new URL('../database/migrations/006_project_features.sql', import.meta.url), 'utf8'))
      assert.deepEqual(old.pragma('foreign_key_check'), [])
    })()
    old.pragma('foreign_keys = ON')
    assert.deepEqual(tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all()), before)
    const config = old.prepare('SELECT statuses,dateFormat FROM project_field_configs').get() as { statuses: string; dateFormat: null }
    assert.deepEqual(JSON.parse(config.statuses).map((status: { id: string }) => status.id).sort(), ['backlog', 'done', 'in_progress', 'review', 'todo'])
    assert.equal(config.dateFormat, null)
    assert.throws(() => old.exec("UPDATE items SET status='unsafe status'"), /CHECK/)
    assert.throws(() => old.exec("UPDATE nodes SET description='invalid' WHERE id='l'"), /CHECK/)
    assert.throws(() => old.exec("UPDATE project_field_assignments SET fieldId='foreign'"), /FOREIGN KEY/)
    const beforeListStatuses = tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all())
    old.transaction(() => old.exec(readFileSync(new URL('../database/migrations/007_list_status_configs.sql', import.meta.url), 'utf8')))()
    assert.deepEqual(tables.map((table) => old.prepare(`SELECT * FROM ${table}`).all()), beforeListStatuses)
    assert.deepEqual(old.prepare('SELECT listId,statuses,updatedAt FROM list_status_configs').all(), [{ listId: 'l', statuses: null, updatedAt: 'old' }])
    assert.throws(() => old.exec("INSERT INTO list_status_configs VALUES ('other','l',NULL,'old')"), /FOREIGN KEY/)
    old.exec("DELETE FROM items WHERE id='todo'")
    assert.deepEqual(old.prepare('SELECT * FROM attachments').all(), [])
    assert.deepEqual(old.pragma('integrity_check'), [{ integrity_check: 'ok' }])
  } finally { old.close() }
})
