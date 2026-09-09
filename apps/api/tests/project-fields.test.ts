import { after, test } from './japa.js'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-project-fields-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { db, service, HttpError } = await import('../app/core.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })
async function user() {
  const id = randomUUID(); const email = `${id}@example.test`
  await db.run('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)', id, 'Test', email, new Date().toISOString())
  return { id, email }
}
async function fixture() {
  const owner = await user(); const wid = (await service.createWorkspace(owner.id, { name: 'Fields' })).id
  const project = await service.createNode(owner.id, wid, { name: 'Project', kind: 'project' })
  const list = await service.createNode(owner.id, wid, { name: 'List', kind: 'list', parentId: project.id })
  const field = await service.createField(owner.id, wid, { name: 'Value', type: 'number' })
  return { owner, wid, project, list, field }
}
const reject = (action: () => Promise<unknown>, status: number) => assert.rejects(action, (error: unknown) => error instanceof HttpError && error.status === status)

test('empty defaults, ordered assignments, unassignment and moves preserve raw values and catalog formula validation', async () => {
  const f = await fixture(); const { owner: { id: actor }, wid, project, field } = f
  const initial = await service.getProjectFields(actor, wid, project.id)
  assert.deepEqual(initial, { projectId: project.id, fieldIds: [], builtInFields: [], statuses: initial.statuses, updatedAt: project.createdAt })
  assert.deepEqual(initial.statuses.map((status) => status.id), ['todo', 'backlog', 'in_progress', 'review', 'done'])
  const formula = await service.createField(actor, wid, { name: 'Computed', type: 'formula' })
  const config = await service.updateProjectFields(actor, wid, project.id, { fieldIds: [formula.id, field.id], builtInFields: ['description', 'priority'], expectedUpdatedAt: initial.updatedAt })
  assert.deepEqual(config.fieldIds, [formula.id, field.id]); assert.ok(config.updatedAt > initial.updatedAt)
  const task = await service.createItem(actor, wid, { nodeId: f.list.id, title: 'Raw', customFields: { [field.id]: 12, [formula.id]: '{{Value}}+1' } })
  await service.updateProjectFields(actor, wid, project.id, { fieldIds: [], builtInFields: [] })
  assert.deepEqual(await service.getItem(actor, wid, task.id), task)
  const destination = await service.createNode(actor, wid, { name: 'Destination', kind: 'project' })
  await service.updateNode(actor, wid, f.list.id, { parentId: destination.id })
  assert.deepEqual(await service.getItem(actor, wid, task.id), task)
  assert.equal((await service.updateItem(actor, wid, task.id, { title: 'Still valid' })).customFields[formula.id], '{{Value}}+1')
  assert.equal((await service.listFields(actor, wid)).length, 2)
  assert.deepEqual((await service.exportWorkspace(actor, wid)).projectFields, (await service.getWorkspace(actor, wid)).projectFields)
  assert.deepEqual((await service.exportWorkspace(actor, wid)).listStatusConfigs, (await service.getWorkspace(actor, wid)).listStatusConfigs)
  assert.deepEqual((await service.exportWorkspace(actor, wid)).listTagColorConfigs, (await service.getWorkspace(actor, wid)).listTagColorConfigs)
})

test('standalone root lists own fields and keep workflows synchronized across moves and exports', async () => {
  const owner = await user(); const wid = (await service.createWorkspace(owner.id, { name: 'Standalone fields' })).id
  const list = await service.createNode(owner.id, wid, { name: 'Work Items', kind: 'list', parentId: null })
  const field = await service.createField(owner.id, wid, { name: 'Estimate', type: 'number' })
  const initial = await service.getProjectFields(owner.id, wid, list.id)
  assert.deepEqual(initial.fieldIds, []); assert.deepEqual(initial.builtInFields, [])
  const configured = await service.updateProjectFields(owner.id, wid, list.id, {
    fieldIds: [field.id], builtInFields: ['tags'], dateFormat: 'dd/MM/yyyy', expectedUpdatedAt: initial.updatedAt,
  })
  assert.deepEqual(configured.fieldIds, [field.id]); assert.deepEqual(configured.builtInFields, ['tags'])
  const task = await service.createItem(owner.id, wid, { nodeId: list.id, title: 'Scoped', tags: ['root'], customFields: { [field.id]: 3 } })
  const statuses = [{ id: 'todo', name: 'Open', color: '#123456', completed: false }, { id: 'closed', name: 'Closed', color: '#654321', completed: true }]
  await service.updateListStatuses(owner.id, wid, list.id, { statuses, expectedUpdatedAt: list.createdAt })
  assert.deepEqual((await service.getProjectFields(owner.id, wid, list.id)).statuses, statuses)
  assert.deepEqual((await service.exportWorkspace(owner.id, wid)).projectFields, (await service.getWorkspace(owner.id, wid)).projectFields)
  const project = await service.createNode(owner.id, wid, { name: 'Destination', kind: 'project' })
  await service.updateNode(owner.id, wid, list.id, { parentId: project.id })
  await reject(() => service.getProjectFields(owner.id, wid, list.id), 400)
  await service.updateNode(owner.id, wid, list.id, { parentId: null })
  assert.deepEqual((await service.getProjectFields(owner.id, wid, list.id)).fieldIds, [field.id])
  assert.deepEqual((await service.getItem(owner.id, wid, task.id)).customFields, { [field.id]: 3 })
  assert.equal((await service.updateProjectFields(owner.id, wid, list.id, { dateFormat: null })).dateFormat, undefined)
  await reject(() => service.updateProjectFields(owner.id, wid, list.id, { statuses }), 400)
})

test('membership and metadata permissions stay independent of task authorization', async () => {
  const f = await fixture()
  for (const permissions of [[], ['workspace:manage'], ['items:read'], ['structure:write']] as const) {
    const member = await user()
    const role = await service.createRole(f.owner.id, f.wid, { name: member.id, permissions })
    await service.addMember(f.owner.id, f.wid, { email: member.email, roleId: role.id })
    const canRead = permissions.some((p) => p === 'items:read' || p === 'structure:write')
    assert.equal((await service.getWorkspace(member.id, f.wid)).projectFields.length, canRead ? 1 : 0)
    assert.equal((await service.getWorkspace(member.id, f.wid)).listStatusConfigs.length, canRead ? 1 : 0)
    assert.equal((await service.getWorkspace(member.id, f.wid)).listTagColorConfigs.length, canRead ? 1 : 0)
    if (canRead) {
      assert.equal((await service.getProjectFields(member.id, f.wid, f.project.id)).projectId, f.project.id)
      assert.deepEqual(await service.getListStatuses(member.id, f.wid, f.list.id), { listId: f.list.id, updatedAt: f.list.createdAt, inheritedProjectUpdatedAt: f.project.createdAt })
      assert.deepEqual(await service.getListTagColors(member.id, f.wid, f.list.id), { listId: f.list.id, colors: {}, updatedAt: f.list.createdAt })
    } else {
      await reject(() => service.getProjectFields(member.id, f.wid, f.project.id), 403)
      await reject(() => service.getListStatuses(member.id, f.wid, f.list.id), 403)
      await reject(() => service.getListTagColors(member.id, f.wid, f.list.id), 403)
    }
    if (permissions.some((p) => p === 'structure:write')) {
      await service.updateProjectFields(member.id, f.wid, f.project.id, { builtInFields: ['tags'] })
      await service.updateListStatuses(member.id, f.wid, f.list.id, { statuses: null })
      const colors = await service.getListTagColors(member.id, f.wid, f.list.id)
      await service.updateListTagColors(member.id, f.wid, f.list.id, { colors: { blocked: '#123456' }, expectedUpdatedAt: colors.updatedAt })
      await service.updateField(member.id, f.wid, f.field.id, { name: 'Managed value' })
      await reject(() => service.listItems(member.id, f.wid), 403)
    } else {
      await reject(() => service.updateProjectFields(member.id, f.wid, f.project.id, { fieldIds: [] }), 403)
      await reject(() => service.updateListStatuses(member.id, f.wid, f.list.id, { statuses: null }), 403)
      await reject(() => service.updateListTagColors(member.id, f.wid, f.list.id, { colors: {}, expectedUpdatedAt: f.list.createdAt }), 403)
      await reject(() => service.updateField(member.id, f.wid, f.field.id, { name: 'Denied' }), 403)
    }
  }
  const outsider = await user()
  await reject(() => service.getProjectFields(outsider.id, f.wid, f.project.id), 403)
  await reject(() => service.getListStatuses(outsider.id, f.wid, f.list.id), 403)
  await reject(() => service.getListTagColors(outsider.id, f.wid, f.list.id), 403)
})

test('list tag colors are bounded, list-scoped and revision-checked', async () => {
  const f = await fixture(); const other = await fixture(); const actor = f.owner.id
  const initial = await service.getListTagColors(actor, f.wid, f.list.id)
  const updated = await service.updateListTagColors(actor, f.wid, f.list.id, { colors: { urgent: '#AA3344', waiting: '#123456' }, expectedUpdatedAt: initial.updatedAt })
  assert.deepEqual(updated.colors, { urgent: '#aa3344', waiting: '#123456' })
  assert.ok(updated.updatedAt > initial.updatedAt)
  await reject(() => service.updateListTagColors(actor, f.wid, f.list.id, { colors: {}, expectedUpdatedAt: initial.updatedAt }), 409)
  await reject(() => service.getListTagColors(actor, f.wid, f.project.id), 400)
  await reject(() => service.getListTagColors(actor, f.wid, other.list.id), 404)
  await assert.rejects(() => service.updateListTagColors(actor, f.wid, f.list.id, { colors: Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`tag-${index}`, '#123456'])), expectedUpdatedAt: updated.updatedAt }))
  await assert.rejects(() => service.updateListTagColors(actor, f.wid, f.list.id, { colors: { bad: 'red' }, expectedUpdatedAt: updated.updatedAt }))
})

test('list view settings are per-user, readable by viewers, and enforce workspace and project field scope', async () => {
  const f = await fixture(); const other = await fixture()
  const unassigned = await service.createField(f.owner.id, f.wid, { name: 'Catalog only', type: 'text' })
  await service.updateProjectFields(f.owner.id, f.wid, f.project.id, { fieldIds: [f.field.id], builtInFields: ['priority'] })
  const viewer = await user()
  const viewerRole = await service.createRole(f.owner.id, f.wid, { name: `Viewer ${viewer.id}`, permissions: ['items:read'] })
  await service.addMember(f.owner.id, f.wid, { email: viewer.email, roleId: viewerRole.id })
  const writeOnly = await user()
  const writeRole = await service.createRole(f.owner.id, f.wid, { name: `Writer ${writeOnly.id}`, permissions: ['items:write'] })
  await service.addMember(f.owner.id, f.wid, { email: writeOnly.email, roleId: writeRole.id })

  const projectDefault = await service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id })
  assert.deepEqual(projectDefault, {
    view: 'list', projectId: f.project.id,
    columnOrder: ['title', 'status', 'assigneeId', 'dueDate', 'priority', `custom:${f.field.id}`],
    hiddenColumns: [], sort: null, updatedAt: null,
  })
  const viewerSettings = await service.updateListViewSettings(viewer.id, f.wid, {
    projectId: f.project.id, columnOrder: ['title', `custom:${f.field.id}`, 'status'], hiddenColumns: ['status'],
    sort: { column: `custom:${f.field.id}`, direction: 'desc' }, expectedUpdatedAt: null,
  })
  assert.equal(viewerSettings.projectId, f.project.id)
  assert.notEqual(viewerSettings.updatedAt, null)
  assert.equal((await service.getListViewSettings(f.owner.id, f.wid, { projectId: f.project.id })).updatedAt, null)
  assert.deepEqual(await service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id }), viewerSettings)

  const allSettings = await service.updateListViewSettings(viewer.id, f.wid, {
    projectId: null, columnOrder: ['title', `custom:${unassigned.id}`], hiddenColumns: [], sort: null, expectedUpdatedAt: null,
  })
  assert.equal(allSettings.projectId, null)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND userId=?', f.wid, viewer.id))?.count, 2)
  await reject(() => service.updateListViewSettings(viewer.id, f.wid, { projectId: f.project.id, columnOrder: ['title', `custom:${unassigned.id}`], hiddenColumns: [], sort: null, expectedUpdatedAt: viewerSettings.updatedAt }), 400)
  await reject(() => service.updateListViewSettings(viewer.id, f.wid, { projectId: f.project.id, columnOrder: ['title', `custom:${other.field.id}`], hiddenColumns: [], sort: null, expectedUpdatedAt: viewerSettings.updatedAt }), 400)
  await reject(() => service.getListViewSettings(viewer.id, f.wid, { projectId: f.list.id }), 400)
  await reject(() => service.getListViewSettings(viewer.id, f.wid, { projectId: other.project.id }), 404)
  const outsider = await user()
  for (const actor of [writeOnly.id, outsider.id]) {
    await reject(() => service.getListViewSettings(actor, f.wid), 403)
    await reject(() => service.updateListViewSettings(actor, f.wid, { columnOrder: ['title'], hiddenColumns: [], sort: null, expectedUpdatedAt: null }), 403)
  }

  await service.updateProjectFields(f.owner.id, f.wid, f.project.id, { fieldIds: [] })
  const reconciledProject = await service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id })
  assert.equal(reconciledProject.columnOrder.includes(`custom:${f.field.id}`), false)
  assert.equal(reconciledProject.sort, null)
  await service.updateProjectFields(f.owner.id, f.wid, f.project.id, { fieldIds: [f.field.id] })
  assert.equal((await service.getListViewSettings(viewer.id, f.wid, { projectId: f.project.id })).columnOrder.includes(`custom:${f.field.id}`), false)
  await service.deleteField(f.owner.id, f.wid, unassigned.id)
  assert.equal((await service.getListViewSettings(viewer.id, f.wid)).columnOrder.includes(`custom:${unassigned.id}`), false)
})

test('list view validation, optimistic concurrency, audit rollback and membership cascade are atomic', async () => {
  const f = await fixture(); const actor = f.owner.id
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
  ]) await assert.rejects(() => service.updateListViewSettings(actor, f.wid, body))

  const beforeAudits = await db.get("SELECT count(*) AS count FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update'", f.wid)
  await db.run("CREATE TEMP TRIGGER fail_view_settings_audit BEFORE INSERT ON audit_logs WHEN NEW.action='list.view.settings.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { await assert.rejects(() => service.updateListViewSettings(actor, f.wid, valid), /audit unavailable/) }
  finally { await db.run('DROP TRIGGER fail_view_settings_audit') }
  assert.equal((await service.getListViewSettings(actor, f.wid)).updatedAt, null)
  assert.deepEqual(await db.get("SELECT count(*) AS count FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update'", f.wid), beforeAudits)

  const created = await service.updateListViewSettings(actor, f.wid, valid)
  await reject(() => service.updateListViewSettings(actor, f.wid, { ...valid, expectedUpdatedAt: null }), 409)
  const updated = await service.updateListViewSettings(actor, f.wid, { ...valid, hiddenColumns: ['status'], sort: null, expectedUpdatedAt: created.updatedAt })
  await reject(() => service.updateListViewSettings(actor, f.wid, { ...valid, expectedUpdatedAt: created.updatedAt }), 409)
  assert.deepEqual(await service.getListViewSettings(actor, f.wid), updated)
  assert.equal((await db.get<{ count: number }>("SELECT count(*) AS count FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update'", f.wid))?.count, 2)
  const lastAudit = await db.get<{ details: string }>("SELECT details FROM audit_logs WHERE workspaceId=? AND action='list.view.settings.update' ORDER BY createdAt DESC LIMIT 1", f.wid)
  assert.deepEqual(JSON.parse(lastAudit!.details), { projectScoped: false, columns: 2, hidden: 1, sorted: false })

  const member = await user()
  const role = await service.createRole(actor, f.wid, { name: member.id, permissions: ['items:read'] })
  await service.addMember(actor, f.wid, { email: member.email, roleId: role.id })
  await service.updateListViewSettings(member.id, f.wid, valid)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND userId=?', f.wid, member.id))?.count, 1)
  await service.deleteMember(actor, f.wid, member.id)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND userId=?', f.wid, member.id))?.count, 0)

  const disposableProject = await service.createNode(actor, f.wid, { name: 'Disposable', kind: 'project' })
  await service.updateListViewSettings(actor, f.wid, { projectId: disposableProject.id, ...valid })
  await service.deleteNode(actor, f.wid, disposableProject.id)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM list_view_settings WHERE workspaceId=? AND projectId=?', f.wid, disposableProject.id))?.count, 0)
})

test('create and link are atomic, retain Field shape, and configuration/audit failures roll back', async () => {
  const f = await fixture(); const actor = f.owner.id
  const before = await service.getProjectFields(actor, f.wid, f.project.id)
  for (const projectId of [randomUUID(), f.list.id]) await assert.rejects(() => service.createField(actor, f.wid, { name: 'Invalid target', type: 'text', projectId }))
  assert.equal((await service.listFields(actor, f.wid)).length, 1)
  await db.run("CREATE TEMP TRIGGER fail_project_audit BEFORE INSERT ON audit_logs WHEN NEW.action IN ('field.create','project.fields.update') BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try {
    await assert.rejects(() => service.createField(actor, f.wid, { name: 'Rollback', type: 'text', projectId: f.project.id }), /audit unavailable/)
    await assert.rejects(() => service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [f.field.id], builtInFields: ['tags'] }), /audit unavailable/)
  } finally { await db.run('DROP TRIGGER fail_project_audit') }
  assert.deepEqual(await service.getProjectFields(actor, f.wid, f.project.id), before)
  assert.equal((await service.listFields(actor, f.wid)).length, 1)
  const auditCount = await db.get('SELECT count(*) AS n FROM audit_logs')
  await db.run("CREATE TEMP TRIGGER fail_outer_audit BEFORE INSERT ON audit_logs WHEN NEW.action='field.create' BEGIN SELECT RAISE(ABORT,'outer audit unavailable'); END")
  try { await assert.rejects(() => service.createField(actor, f.wid, { name: 'Outer rollback', type: 'text', projectId: f.project.id }), /outer audit unavailable/) }
  finally { await db.run('DROP TRIGGER fail_outer_audit') }
  assert.deepEqual(await service.getProjectFields(actor, f.wid, f.project.id), before)
  assert.equal((await service.listFields(actor, f.wid)).length, 1)
  assert.deepEqual(await db.get('SELECT count(*) AS n FROM audit_logs'), auditCount)
  const linked = await service.createField(actor, f.wid, { name: 'Linked secret name', type: 'text', projectId: f.project.id })
  assert.deepEqual(Object.keys(linked).sort(), ['id', 'name', 'options', 'type', 'workspaceId'])
  const config = await service.getProjectFields(actor, f.wid, f.project.id)
  assert.deepEqual(config.fieldIds, [linked.id]); assert.ok(config.updatedAt > before.updatedAt)
  await reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [], expectedUpdatedAt: before.updatedAt }), 409)
  assert.equal(JSON.stringify(await db.all('SELECT details FROM audit_logs WHERE workspaceId=?', f.wid)).includes(linked.name), false)
  const foreign = await fixture()
  await assert.rejects(() => db.run('INSERT INTO project_field_assignments VALUES (?,?,?,?)', f.wid, f.project.id, foreign.field.id, 0), /FOREIGN KEY/)
})

test('mixed cleanup scans every row once, preserves untouched versions, updates config revisions and rolls back', async () => {
  const f = await fixture(); const actor = f.owner.id
  const config = await service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [f.field.id] })
  const tasks = []
  for (let n = 0; n < 450; n++) tasks.push(await service.createItem(actor, f.wid, { nodeId: f.list.id, title: String(n), customFields: n % 3 === 1 ? { [f.field.id]: n } : {} }))
  await db.run("CREATE TEMP TRIGGER fail_delete_audit BEFORE INSERT ON audit_logs WHEN NEW.action='field.delete' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { await assert.rejects(() => service.deleteField(actor, f.wid, f.field.id), /audit unavailable/) }
  finally { await db.run('DROP TRIGGER fail_delete_audit') }
  assert.deepEqual(await service.getProjectFields(actor, f.wid, f.project.id), config)
  for (const task of tasks) assert.deepEqual(await service.getItem(actor, f.wid, task.id), task)
  assert.deepEqual(await service.deleteField(actor, f.wid, f.field.id), { success: true })
  for (const task of tasks) {
    const current = await service.getItem(actor, f.wid, task.id)
    assert.deepEqual(current.customFields, {})
    if (Object.keys(task.customFields).length) assert.ok(current.updatedAt > task.updatedAt)
    else assert.deepEqual(current, task)
  }
  const current = await service.getProjectFields(actor, f.wid, f.project.id)
  assert.deepEqual(current.fieldIds, []); assert.ok(current.updatedAt > config.updatedAt)
  await reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [], expectedUpdatedAt: config.updatedAt }), 409)
  const audit = await db.get<{ details: string }>("SELECT details FROM audit_logs WHERE workspaceId=? AND action='field.delete'", f.wid)
  assert.deepEqual(JSON.parse(audit!.details), { touched: 150 })
})

test('current schema preserves field values and enforces workspace-scoped configuration foreign keys', async () => {
  const f = await fixture(); const other = await fixture()
  await service.updateProjectFields(f.owner.id, f.wid, f.project.id, { fieldIds: [f.field.id] })
  const item = await service.createItem(f.owner.id, f.wid, { nodeId: f.list.id, title: 'Preserved', customFields: { [f.field.id]: 1 } })
  const before = await db.get('SELECT * FROM items WHERE id=?', item.id)
  await db.transaction(async (transaction) => {
    await transaction.run('UPDATE project_field_configs SET builtInFields=builtInFields WHERE workspaceId=? AND projectId=?', f.wid, f.project.id)
  })
  assert.deepEqual(await db.get('SELECT * FROM items WHERE id=?', item.id), before)
  await assert.rejects(() => db.run('INSERT INTO project_field_assignments(workspaceId,projectId,fieldId,position) VALUES (?,?,?,?)', f.wid, f.project.id, other.field.id, 1), /FOREIGN KEY/)
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'), [])
})

const runHttpTest = async () => {
  const f = await fixture(); const actor = f.owner.id
  await service.createField(actor, f.wid, { name: 'Linked', type: 'text', projectId: f.project.id })
  const initialConfig = await service.getProjectFields(actor, f.wid, f.project.id)
  const inheritedListConfig = await service.getListStatuses(actor, f.wid, f.list.id)
  const rating = await service.createField(actor, f.wid, { name: 'HTTP rating', type: 'rating' })
  const token = randomUUID()
  await db.run('INSERT INTO tokens(id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)', randomUUID(), actor, 'Test', createHash('sha256').update(token).digest('hex'), '2099-01-01T00:00:00.000Z', f.project.createdAt)
  const viewer = await user()
  const viewerRole = await service.createRole(actor, f.wid, { name: viewer.id, permissions: ['items:read'] })
  await service.addMember(actor, f.wid, { email: viewer.email, roleId: viewerRole.id })
  const viewerToken = randomUUID()
  await db.run('INSERT INTO tokens(id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)', randomUUID(), viewer.id, 'Viewer', createHash('sha256').update(viewerToken).digest('hex'), '2099-01-01T00:00:00.000Z', f.project.createdAt)
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening')
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  await closeDatabase()
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
    assert.deepEqual(await (await fetch(endpoint, { headers })).json(), initialConfig)
    const statuses = [{ id: 'queued', name: 'Queued', color: '#123abc', completed: false }, { id: 'closed', name: 'Closed', color: '#456def', completed: true }]
    const patch = await fetch(endpoint, { headers, method: 'PATCH', body: JSON.stringify({ builtInFields: ['description'], statuses, dateFormat: 'dd/MM/yyyy' }) })
    assert.equal(patch.status, 200)
    const config = await patch.json()
    assert.deepEqual(config, await (await fetch(endpoint, { headers })).json())
    assert.equal((await fetch(endpoint, { headers, method: 'PATCH', body: JSON.stringify({ fieldIds: [], expectedUpdatedAt: f.project.createdAt }) })).status, 409)
    const currentInheritedListConfig = await (await fetch(listEndpoint, { headers })).json() as typeof inheritedListConfig
    assert.deepEqual({ ...currentInheritedListConfig, inheritedProjectUpdatedAt: inheritedListConfig.inheritedProjectUpdatedAt }, inheritedListConfig)
    const listPatch = await fetch(listEndpoint, { headers, method: 'PATCH', body: JSON.stringify({ statuses, expectedUpdatedAt: f.list.createdAt, expectedProjectUpdatedAt: currentInheritedListConfig.inheritedProjectUpdatedAt }) })
    assert.equal(listPatch.status, 200)
    const listConfig = await listPatch.json() as { updatedAt: string }
    assert.equal((await fetch(listEndpoint, { headers, method: 'PATCH', body: JSON.stringify({ statuses: null, expectedUpdatedAt: f.list.createdAt }) })).status, 409)
    const nodePatch = await fetch(`${path}/nodes/${f.project.id}`, { headers, method: 'PATCH', body: JSON.stringify({ description: 'Project notes' }) })
    assert.equal(nodePatch.status, 200)
    assert.equal((await nodePatch.json() as { description: string }).description, 'Project notes')
    const fieldResponse = await fetch(`${path}/fields`, { headers, method: 'POST', body: JSON.stringify({ name: 'HTTP checklist', type: 'checklist', options: ['A', 'B'], projectId: f.project.id }) })
    assert.equal(fieldResponse.status, 201)
    const checklist = await fieldResponse.json() as { id: string }
    const fieldPatch = await fetch(`${path}/fields/${rating.id}`, { headers, method: 'PATCH', body: JSON.stringify({ settings: { maxRating: 10 } }) })
    assert.equal(fieldPatch.status, 200)
    assert.deepEqual((await fieldPatch.json() as { settings: unknown }).settings, { maxRating: 10 })
    const itemResponse = await fetch(`${path}/items`, { headers, method: 'POST', body: JSON.stringify({ nodeId: f.list.id, title: 'HTTP values', customFields: { [checklist.id]: ['B'], [rating.id]: 10 } }) })
    assert.equal(itemResponse.status, 201)
    const item = await itemResponse.json() as { id: string; status: string }
    assert.equal(item.status, 'queued')
    const queuedPage = await (await fetch(`${path}/items/page?status=queued`, { headers })).json() as { items: Array<{ id: string }> }
    assert.deepEqual(queuedPage.items.map(({ id }) => id), [item.id])
    const exported = await fetch(`${path}/export`, { headers, method: 'HEAD' })
    assert.equal(exported.status, 200)
    assert.match(exported.headers.get('content-type') ?? '', /application\/json/)
    const workspace = await (await fetch(path, { headers })).json() as { projectFields: unknown; listStatusConfigs: unknown }
    assert.ok(Array.isArray(workspace.projectFields))
    assert.ok(Array.isArray(workspace.listStatusConfigs))
    const initialView = await (await fetch(`${viewEndpoint}?projectId=${f.project.id}`, { headers })).json() as { updatedAt: null }
    assert.equal(initialView.updatedAt, null)
    const viewPatch = await fetch(viewEndpoint, { headers, method: 'PATCH', body: JSON.stringify({ projectId: f.project.id, columnOrder: ['title', 'priority'], hiddenColumns: ['priority'], sort: { column: 'title', direction: 'asc' }, expectedUpdatedAt: null }) })
    assert.equal(viewPatch.status, 200)
    const actorView = await viewPatch.json() as { updatedAt: string }
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
}

test('list overrides control defaults and moves while project changes validate only inheriting lists', async () => {
  const f = await fixture(); const actor = f.owner.id
  const projectStatuses = [{ id: 'queued', name: 'Queued', color: '#112233', completed: false }, { id: 'closed', name: 'Closed', color: '#445566', completed: true }]
  const overrideStatuses = [{ id: 'local', name: 'Local', color: '#abcdef', completed: false }, projectStatuses[1]!]
  const initial = await service.getListStatuses(actor, f.wid, f.list.id)
  await service.updateProjectFields(actor, f.wid, f.project.id, { statuses: projectStatuses })
  const auditsAfterProjectChange = await db.get('SELECT count(*) AS count FROM audit_logs WHERE workspaceId=?', f.wid)
  await reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: overrideStatuses, expectedUpdatedAt: initial.updatedAt }), 400)
  await reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: overrideStatuses, expectedUpdatedAt: initial.updatedAt, expectedProjectUpdatedAt: initial.inheritedProjectUpdatedAt }), 409)
  assert.deepEqual(await db.get('SELECT count(*) AS count FROM audit_logs WHERE workspaceId=?', f.wid), auditsAfterProjectChange)
  const fresh = await service.getListStatuses(actor, f.wid, f.list.id)
  assert.equal(fresh.statuses, undefined)
  const inherited = await service.createNode(actor, f.wid, { kind: 'list', name: 'Inherited', parentId: f.project.id })
  const inheritedItem = await service.createItem(actor, f.wid, { nodeId: inherited.id, title: 'Inherited default' })
  const override = await service.updateListStatuses(actor, f.wid, f.list.id, { statuses: overrideStatuses, expectedUpdatedAt: fresh.updatedAt, expectedProjectUpdatedAt: fresh.inheritedProjectUpdatedAt })
  const item = await service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Override default' })
  assert.equal(item.status, 'local')
  await reject(() => service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Invalid', status: 'queued' }), 400)
  await reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: null }), 409)
  await reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [projectStatuses[1]!] }), 409)
  await service.updateItem(actor, f.wid, inheritedItem.id, { status: 'closed' })
  await service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [projectStatuses[1]!] })
  assert.equal((await service.getItem(actor, f.wid, item.id)).status, 'local')
  await service.updateItem(actor, f.wid, item.id, { status: 'closed' })
  const inheritedConfig = await service.updateListStatuses(actor, f.wid, f.list.id, { statuses: null, expectedUpdatedAt: override.updatedAt })
  assert.equal(inheritedConfig.statuses, undefined)

  const destination = await service.createNode(actor, f.wid, { kind: 'project', name: 'Destination' })
  const destinationStatuses = [{ id: 'target', name: 'Target', color: '#654321', completed: false }]
  await service.updateProjectFields(actor, f.wid, destination.id, { statuses: destinationStatuses })
  const folder = await service.createNode(actor, f.wid, { kind: 'folder', name: 'Mixed', parentId: f.project.id })
  const movingInherited = await service.createNode(actor, f.wid, { kind: 'list', name: 'Moving inherited', parentId: folder.id })
  const movingOverride = await service.createNode(actor, f.wid, { kind: 'list', name: 'Moving override', parentId: folder.id })
  const movingOverrideConfig = await service.getListStatuses(actor, f.wid, movingOverride.id)
  await service.updateListStatuses(actor, f.wid, movingOverride.id, { statuses: overrideStatuses, expectedProjectUpdatedAt: movingOverrideConfig.inheritedProjectUpdatedAt })
  const inheritedMoveTask = await service.createItem(actor, f.wid, { nodeId: movingInherited.id, title: 'Move inherited' })
  const overrideMoveTask = await service.createItem(actor, f.wid, { nodeId: movingOverride.id, title: 'Move override' })
  await reject(() => service.updateNode(actor, f.wid, folder.id, { parentId: destination.id }), 409)
  await service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [projectStatuses[1]!, destinationStatuses[0]!] })
  await service.updateItem(actor, f.wid, inheritedMoveTask.id, { status: 'target' })
  await service.updateNode(actor, f.wid, folder.id, { parentId: destination.id })
  assert.equal((await service.getItem(actor, f.wid, overrideMoveTask.id)).status, 'local')
  const movedOverrideConfig = await service.getListStatuses(actor, f.wid, movingOverride.id)
  assert.deepEqual(movedOverrideConfig.statuses, overrideStatuses)
  assert.equal(movedOverrideConfig.inheritedProjectUpdatedAt, (await service.getProjectFields(actor, f.wid, destination.id)).updatedAt)

  const destinationList = await service.createNode(actor, f.wid, { kind: 'list', name: 'Override destination', parentId: destination.id })
  const destinationListConfig = await service.getListStatuses(actor, f.wid, destinationList.id)
  await service.updateListStatuses(actor, f.wid, destinationList.id, { statuses: [overrideStatuses[0]!], expectedProjectUpdatedAt: destinationListConfig.inheritedProjectUpdatedAt })
  await reject(() => service.updateItem(actor, f.wid, inheritedItem.id, { nodeId: destinationList.id }), 400)
  assert.equal((await service.updateItem(actor, f.wid, inheritedItem.id, { nodeId: destinationList.id, status: 'local' })).status, 'local')

  const standalone = await service.createNode(actor, f.wid, { kind: 'list', name: 'Standalone' })
  const standaloneConfig = await service.getListStatuses(actor, f.wid, standalone.id)
  assert.ok(standaloneConfig.statuses?.length)
  assert.equal(standaloneConfig.inheritedProjectUpdatedAt, undefined)
  assert.equal((await service.createItem(actor, f.wid, { nodeId: standalone.id, title: 'Standalone default' })).status, standaloneConfig.statuses![0]!.id)
  await reject(() => service.updateListStatuses(actor, f.wid, standalone.id, { statuses: null }), 400)
  await service.updateNode(actor, f.wid, standalone.id, { parentId: destination.id, expectedParentId: null })
  assert.deepEqual((await service.getListStatuses(actor, f.wid, standalone.id)).statuses, standaloneConfig.statuses)

  await service.updateNode(actor, f.wid, movingInherited.id, { parentId: null, expectedParentId: folder.id })
  const materialized = await service.getListStatuses(actor, f.wid, movingInherited.id)
  assert.deepEqual(materialized.statuses, destinationStatuses)
  assert.equal(materialized.inheritedProjectUpdatedAt, undefined)
  assert.equal((await service.getItem(actor, f.wid, inheritedMoveTask.id)).status, 'target')
  assert.ok((await service.exportWorkspace(actor, f.wid)).nodes.some(node => node.id === movingInherited.id && node.parentId === null))
})

test('status configuration rejects unsafe and duplicate IDs, invalid colors, bounds and stale writes; audit failures roll back', async () => {
  const f = await fixture(); const actor = f.owner.id
  const initial = await service.getProjectFields(actor, f.wid, f.project.id)
  const status = { id: 'ready', name: 'Ready', color: '#abcdef', completed: false }
  for (const statuses of [[], Array(51).fill(status), [status, status], [{ ...status, id: 'unsafe id' }], [{ ...status, id: 'a'.repeat(65) }], [{ ...status, color: 'red' }], [{ ...status, completed: 'false' }], [{ ...status, name: '' }]]) {
    await assert.rejects(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses }))
  }
  await assert.rejects(() => service.updateProjectFields(actor, f.wid, f.project.id, { dateFormat: 'arbitrary' }))
  await db.run("CREATE TEMP TRIGGER fail_status_audit BEFORE INSERT ON audit_logs WHEN NEW.action='project.fields.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { await assert.rejects(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [status], dateFormat: 'MMM d, yyyy' }), /audit unavailable/) }
  finally { await db.run('DROP TRIGGER fail_status_audit') }
  assert.deepEqual(await service.getProjectFields(actor, f.wid, f.project.id), initial)
  const updated = await service.updateProjectFields(actor, f.wid, f.project.id, { statuses: [status], dateFormat: 'MMMM d, yyyy', expectedUpdatedAt: initial.updatedAt })
  assert.ok(updated.updatedAt > initial.updatedAt)
  await reject(() => service.updateProjectFields(actor, f.wid, f.project.id, { statuses: initial.statuses, expectedUpdatedAt: initial.updatedAt }), 409)
  const listInitial = await service.getListStatuses(actor, f.wid, f.list.id)
  await db.run("CREATE TEMP TRIGGER fail_list_status_audit BEFORE INSERT ON audit_logs WHEN NEW.action='list.statuses.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { await assert.rejects(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: [status], expectedProjectUpdatedAt: listInitial.inheritedProjectUpdatedAt }), /audit unavailable/) }
  finally { await db.run('DROP TRIGGER fail_list_status_audit') }
  assert.deepEqual(await service.getListStatuses(actor, f.wid, f.list.id), listInitial)
  const listUpdated = await service.updateListStatuses(actor, f.wid, f.list.id, { statuses: [status], expectedUpdatedAt: listInitial.updatedAt, expectedProjectUpdatedAt: listInitial.inheritedProjectUpdatedAt })
  await reject(() => service.updateListStatuses(actor, f.wid, f.list.id, { statuses: null, expectedUpdatedAt: listInitial.updatedAt }), 409)
  assert.deepEqual(await service.getListStatuses(actor, f.wid, f.list.id), listUpdated)
  const empty = await service.createNode(actor, f.wid, { name: 'Delete config', kind: 'list', parentId: f.project.id })
  assert.ok(await db.get('SELECT listId FROM list_status_configs WHERE workspaceId=? AND listId=?', f.wid, empty.id))
  await service.deleteNode(actor, f.wid, empty.id)
  assert.equal(await db.get('SELECT listId FROM list_status_configs WHERE workspaceId=? AND listId=?', f.wid, empty.id), undefined)
})

test('date formats, datetime, checklist and rating enforce typed values and safe editable settings including retained values', async () => {
  const f = await fixture(); const actor = f.owner.id
  const date = await service.createField(actor, f.wid, { name: 'Date', type: 'date', settings: { dateFormat: 'dd/MM/yyyy' } })
  const datetime = await service.createField(actor, f.wid, { name: 'Time', type: 'datetime', settings: { dateFormat: 'MMM d, yyyy' } })
  const checklist = await service.createField(actor, f.wid, { name: 'Checks', type: 'checklist', options: ['A', 'B'] })
  const rating = await service.createField(actor, f.wid, { name: 'Rating', type: 'rating', settings: { maxRating: 7 } })
  const select = await service.createField(actor, f.wid, { name: 'Dropdown', type: 'select', options: ['A', 'B'] })
  const values = { [date.id]: '2026-09-07', [datetime.id]: '2026-09-07T14:30:00+08:00', [checklist.id]: ['B'], [rating.id]: 7, [select.id]: 'A' }
  const task = await service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Typed', customFields: values })
  assert.deepEqual(task.customFields, values)
  for (const [field, invalid] of [[datetime, '2026-09-07'], [datetime, '2026-02-30T00:00:00Z'], [checklist, ['A', 'A']], [checklist, ['C']], [checklist, 'A'], [rating, 0], [rating, 8], [rating, 1.5], [rating, '5']] as const) {
    await reject(() => service.updateItem(actor, f.wid, task.id, { customFields: { [field.id]: invalid } }), 400)
  }
  await reject(() => service.updateField(actor, f.wid, rating.id, { settings: { maxRating: 5 } }), 409)
  await reject(() => service.updateField(actor, f.wid, checklist.id, { options: ['A'] }), 409)
  await reject(() => service.updateField(actor, f.wid, select.id, { options: ['B'] }), 409)
  assert.deepEqual(await service.getItem(actor, f.wid, task.id), task)
  assert.equal((await service.updateField(actor, f.wid, date.id, { name: 'Renamed date', settings: { dateFormat: 'MMMM d, yyyy' } })).settings?.dateFormat, 'MMMM d, yyyy')
  assert.deepEqual((await service.updateField(actor, f.wid, checklist.id, { options: ['B', 'C'] })).options, ['B', 'C'])
  await service.updateItem(actor, f.wid, task.id, { customFields: { [rating.id]: null, [checklist.id]: [] } })
  await service.updateField(actor, f.wid, rating.id, { settings: { maxRating: 1 } })
  await service.updateField(actor, f.wid, checklist.id, { options: ['C'] })
  for (const input of [{ settings: { dateFormat: 'bad' } }, { settings: { maxRating: 11 } }, { settings: { maxRating: 0 } }, { settings: { maxRating: 1.5 } }, { settings: { other: true } }, { type: 'text' }, {}]) await assert.rejects(() => service.updateField(actor, f.wid, rating.id, input))
  await reject(() => service.updateField(actor, f.wid, rating.id, { settings: { dateFormat: 'yyyy-MM-dd' } }), 400)
  await reject(() => service.createField(actor, f.wid, { name: 'Invalid', type: 'date', settings: { maxRating: 5 } }), 400)
  await reject(() => service.createField(actor, f.wid, { name: 'Invalid', type: 'checklist', options: [] }), 400)
  const foreign = await fixture(); const outsider = await user()
  await reject(() => service.updateField(actor, f.wid, foreign.field.id, { name: 'Foreign' }), 404)
  await reject(() => service.updateField(outsider.id, f.wid, rating.id, { name: 'Denied' }), 403)
  const before = await service.listFields(actor, f.wid)
  await db.run("CREATE TEMP TRIGGER fail_settings_audit BEFORE INSERT ON audit_logs WHEN NEW.action='field.update' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  try { await assert.rejects(() => service.updateField(actor, f.wid, rating.id, { name: 'Rollback', settings: { maxRating: 10 } }), /audit unavailable/) }
  finally { await db.run('DROP TRIGGER fail_settings_audit') }
  assert.deepEqual(await service.listFields(actor, f.wid), before)
  assert.deepEqual((await service.exportWorkspace(actor, f.wid)).fields, before)
})

test('field renames protect stored formula references but ignore quoted literals and other workspaces', async () => {
  const f = await fixture(); const actor = f.owner.id
  await service.updateField(actor, f.wid, f.field.id, { name: 'Qty' })
  const formula = await service.createField(actor, f.wid, { name: 'Total', type: 'formula' })
  const text = await service.createField(actor, f.wid, { name: 'Notes', type: 'text' })
  const task = await service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Retained unassigned formula', customFields: { [f.field.id]: 2, [formula.id]: 'CONCAT("{{Qty}}", {{Qty}})' } })
  const before = await service.listFields(actor, f.wid)
  const audits = await db.get('SELECT count(*) AS n FROM audit_logs WHERE workspaceId=?', f.wid)
  await assert.rejects(() => service.updateField(actor, f.wid, f.field.id, { name: 'Quantity' }), (error: unknown) => error instanceof HttpError && error.status === 409 && /formulas.*before renaming/.test(error.message))
  assert.deepEqual(await service.listFields(actor, f.wid), before)
  assert.deepEqual(await service.getItem(actor, f.wid, task.id), task)
  assert.deepEqual(await db.get('SELECT count(*) AS n FROM audit_logs WHERE workspaceId=?', f.wid), audits)
  assert.equal((await service.updateField(actor, f.wid, f.field.id, { name: ' Qty ' })).name, 'Qty')
  const other = await fixture()
  await service.updateField(other.owner.id, other.wid, other.field.id, { name: 'Qty' })
  const otherFormula = await service.createField(other.owner.id, other.wid, { name: 'Total', type: 'formula' })
  await service.createItem(other.owner.id, other.wid, { nodeId: other.list.id, title: 'Other workspace', customFields: { [otherFormula.id]: '{{Qty}}*2' } })
  const quoted = await service.updateItem(actor, f.wid, task.id, { customFields: { [formula.id]: 'CONCAT("a ""{{Qty}}""", "{{Qty}}")', [text.id]: '{{Qty}}' } })
  assert.equal((await service.updateField(actor, f.wid, f.field.id, { name: 'Quantity' })).name, 'Quantity')
  assert.deepEqual(await service.getItem(actor, f.wid, task.id), quoted)
})

test('current project features preserve data and enforce status, hierarchy, cascade and integrity constraints', async () => {
  const f = await fixture(); const actor = f.owner.id
  await service.updateProjectFields(actor, f.wid, f.project.id, { fieldIds: [f.field.id] })
  const item = await service.createItem(actor, f.wid, { nodeId: f.list.id, title: 'Preserved', customFields: { [f.field.id]: 1 } })
  const objectKey = `${f.wid}/object`
  await db.run('INSERT INTO storage_objects(objectKey,driver,location,createdAt) VALUES (?,?,?,?)', objectKey, 'filesystem', objectKey, 'old')
  await db.run('INSERT INTO attachments(id,workspaceId,itemId,objectKey,name,contentType,size,createdAt) VALUES (?,?,?,?,?,?,?,?)', randomUUID(), f.wid, item.id, objectKey, 'file', 'text/plain', 1, 'old')
  const before = await Promise.all([
    db.all('SELECT * FROM items WHERE workspaceId=?', f.wid),
    db.all('SELECT * FROM attachments WHERE workspaceId=?', f.wid),
    db.all('SELECT * FROM storage_objects WHERE objectKey=?', objectKey),
    db.all('SELECT * FROM project_field_assignments WHERE workspaceId=?', f.wid),
  ])
  assert.deepEqual(await Promise.all([
    db.all('SELECT * FROM items WHERE workspaceId=?', f.wid),
    db.all('SELECT * FROM attachments WHERE workspaceId=?', f.wid),
    db.all('SELECT * FROM storage_objects WHERE objectKey=?', objectKey),
    db.all('SELECT * FROM project_field_assignments WHERE workspaceId=?', f.wid),
  ]), before)
  await assert.rejects(() => db.run("UPDATE items SET status='unsafe status' WHERE id=?", item.id), /CHECK/)
  await assert.rejects(() => db.run("UPDATE nodes SET description='invalid' WHERE id=?", f.list.id), /CHECK/)
  await assert.rejects(() => db.run("UPDATE project_field_assignments SET fieldId='foreign' WHERE workspaceId=?", f.wid), /FOREIGN KEY/)
  await assert.rejects(() => db.run("INSERT INTO list_status_configs(workspaceId,listId,statuses,updatedAt) VALUES ('other',?,NULL,'old')", f.list.id), /FOREIGN KEY/)
  await db.run('DELETE FROM items WHERE id=?', item.id)
  assert.deepEqual(await db.all('SELECT * FROM attachments WHERE itemId=?', item.id), [])
  assert.deepEqual(await db.all('PRAGMA foreign_key_check'), [])
  assert.deepEqual(await db.all('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
})

test('real HTTP GET/PATCH and export endpoint match the service contract', { timeout: 20000 }, runHttpTest)
