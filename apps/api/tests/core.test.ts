import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const directory = mkdtempSync(join(tmpdir(), 'hopya-core-'))
process.env.DATA_DIR = directory
const { db, service, requirePermission, permissions, HttpError } = await import('../app/core.js')
const { hashPassword, verifyPassword } = await import('../app/security.js')
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
const createUser = (isAdmin = false) => {
  const id = randomUUID()
  db.prepare('INSERT INTO users (id,name,email,isAdmin,createdAt) VALUES (?,?,?,?,?)').run(id, 'Test', `${id}@example.test`, Number(isAdmin), new Date().toISOString())
  return id
}
function fixture() {
  const owner = createUser()
  const workspace = service.createWorkspace(owner, { name: 'Workspace' })
  const project = service.createNode(owner, workspace.id, { name: 'Project', kind: 'project' })
  const list = service.createNode(owner, workspace.id, { name: 'List', kind: 'list', parentId: project.id })
  return { owner, wid: workspace.id, project, list }
}
const denied = (operation: () => unknown, status = 403) => assert.throws(operation, (error: unknown) => error instanceof HttpError && error.status === status)
function add(f: ReturnType<typeof fixture>, userId: string, roleId: string) {
  return service.addMember(f.owner, f.wid, { email: `${userId}@example.test`, roleId })
}

test('numbered migrations are recorded and SQLite integrity is enabled', () => {
  assert.ok(db.prepare('SELECT name FROM schema_migrations WHERE name=?').get('001_core.sql'))
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
})
test('scrypt salts are random, password verification is strict, and external users cannot password-login', async () => {
  const password = 'a long password for testing'
  const first = await hashPassword(password)
  assert.notEqual(first, await hashPassword(password))
  assert.ok(!first.includes(password))
  assert.equal(await verifyPassword(password, first), true)
  assert.equal(await verifyPassword('incorrect password', first), false)
  assert.equal(await verifyPassword(password, null), false)
  assert.equal(await verifyPassword(password, 'malformed'), false)
})
test('workspace isolation applies to site admins and disabled users', () => {
  const f = fixture()
  const outsider = createUser(true)
  denied(() => service.getWorkspace(outsider, f.wid))
  denied(() => service.listItems(outsider, f.wid))
  denied(() => service.exportWorkspace(outsider, f.wid))
  assert.deepEqual(service.listWorkspaces(outsider), [])
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.owner)
  denied(() => requirePermission(f.owner, f.wid, 'items:read'))
})
test('only owners can delete a workspace and its relational contents with an atomic audit', () => {
  const f = fixture()
  const manager = createUser()
  const siteAdmin = createUser(true)
  const managerRole = service.createRole(f.owner, f.wid, { name: 'Workspace manager', permissions: ['workspace:manage'] })
  add(f, manager, managerRole.id)
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Delete with workspace' })
  const objectKey = `${f.wid}/attachment`
  db.prepare('INSERT INTO storage_objects(objectKey,driver,location,createdAt) VALUES (?,?,?,?)').run(objectKey, 'filesystem', objectKey, new Date().toISOString())
  db.prepare('INSERT INTO attachments(id,workspaceId,itemId,objectKey,name,contentType,size,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), f.wid, item.id, objectKey, 'private.txt', 'text/plain', 7, f.owner, new Date().toISOString())
  denied(() => service.deleteWorkspace(manager, f.wid))
  denied(() => service.deleteWorkspace(siteAdmin, f.wid))
  db.exec("CREATE TRIGGER fail_workspace_delete_audit BEFORE INSERT ON audit_logs WHEN NEW.action='workspace.delete' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  try { assert.throws(() => service.deleteWorkspace(f.owner, f.wid)) }
  finally { db.exec('DROP TRIGGER fail_workspace_delete_audit') }
  assert.ok(db.prepare('SELECT id FROM workspaces WHERE id=?').get(f.wid))
  assert.ok(db.prepare('SELECT id FROM items WHERE id=?').get(item.id))
  assert.deepEqual(service.deleteWorkspace(f.owner, f.wid), { success: true })
  assert.equal(db.prepare('SELECT id FROM workspaces WHERE id=?').get(f.wid), undefined)
  for (const table of ['memberships', 'roles', 'nodes', 'items', 'fields', 'attachments']) {
    assert.equal((db.prepare(`SELECT count(*) AS count FROM ${table} WHERE workspaceId=?`).get(f.wid) as { count: number }).count, 0)
  }
  assert.ok(db.prepare('SELECT objectKey FROM storage_objects WHERE objectKey=?').get(objectKey))
  const auditRow = db.prepare("SELECT details FROM audit_logs WHERE workspaceId=? AND action='workspace.delete'").get(f.wid) as { details: string }
  assert.deepEqual(JSON.parse(auditRow.details), { members: 2, nodes: 2, items: 1, attachments: 1 })
})
test('task CRUD preserves omitted values, filters literal search, and validates dates and references', () => {
  const f = fixture(); const other = fixture()
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: '100% work_', description: 'Details', tags: [' urgent ', 'urgent'], startDate: '2024-02-29', dueDate: '2024-03-01' })
  assert.deepEqual(item.tags, ['urgent'])
  assert.equal(item.status, 'todo')
  const updated = service.updateItem(f.owner, f.wid, item.id, { priority: 'high' })
  assert.equal(updated.description, 'Details')
  assert.equal(updated.startDate, '2024-02-29')
  assert.equal(service.listItems(f.owner, f.wid, { search: '% work_' }).length, 1)
  assert.equal(service.listItems(f.owner, f.wid, { search: "' OR 1=1 --" }).length, 0)
  assert.equal(service.listItems(f.owner, f.wid, { status: 'done' }).length, 0)
  assert.throws(() => service.updateItem(f.owner, f.wid, item.id, { dueDate: '2025-02-29' }))
  denied(() => service.updateItem(f.owner, f.wid, item.id, { dueDate: '2024-01-01' }), 400)
  denied(() => service.updateItem(f.owner, f.wid, item.id, { nodeId: other.list.id }), 404)
  denied(() => service.updateItem(f.owner, f.wid, item.id, { assigneeId: other.owner }), 400)
  denied(() => service.createItem(f.owner, f.wid, { nodeId: f.project.id, title: 'Not a list' }), 400)
  denied(() => service.getItem(other.owner, other.wid, item.id), 404)
  assert.throws(() => service.updateItem(f.owner, f.wid, item.id, { workspaceId: other.wid }))
  service.deleteItem(f.owner, f.wid, item.id)
  denied(() => service.getItem(f.owner, f.wid, item.id), 404)
})
test('task description markdown normalizes line endings and strips control characters verbatim', () => {
  const f = fixture()
  const markdown = '# Heading\n**bold** and *italic*\n- item one\n- item two\n[link](https://example.com)\n  padded spaces  '
  assert.equal(service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Markdown', description: markdown }).description, markdown)
  assert.equal(service.getItem(f.owner, f.wid, service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'CRLF', description: 'a\r\nb\rc' }).id).description, 'a\nb\nc')
  assert.equal(service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Controls', description: 'a\u0000b\u0001c\u0007d\u0008e\tf\ng' }).description, 'abcde\tf\ng')
  assert.equal(service.updateItem(f.owner, f.wid, service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Patch', description: 'x' }).id, { description: 'p\r\nq\u0001r' }).description, 'p\nqr')
  assert.throws(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Too long', description: 'x'.repeat(50001) }))
  assert.throws(() => service.updateItem(f.owner, f.wid, service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Patch long' }).id, { description: 'x'.repeat(50001) }))
})
test('assignments and validated task/comment mentions create private workspace notifications', () => {
  const f = fixture()
  const recipient = createUser()
  const role = service.createRole(f.owner, f.wid, { name: 'Contributor', permissions: ['items:read', 'items:write'] })
  add(f, recipient, role.id)
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Notify me', assigneeId: recipient,
    description: `Hello [@Test](/app?workspace=${f.wid}&mentionUser=${recipient})` })
  let notices = service.listNotifications(recipient, f.wid)
  assert.deepEqual(notices.map(row => row.type).sort(), ['assignment', 'mention'])
  assert.equal(service.unreadNotificationCount(recipient, f.wid).unread, 2)
  service.updateItem(f.owner, f.wid, item.id, { description: item.description })
  assert.equal(service.listNotifications(recipient, f.wid).length, 2, 'unchanged mentions must not notify again')
  const comment = service.createComment(f.owner, f.wid, item.id, { body: `Please review [@Test](/app?workspace=${f.wid}&mentionUser=${recipient})` })
  notices = service.listNotifications(recipient, f.wid)
  assert.equal(notices.length, 3)
  assert.equal(notices[0].commentId, comment.id)
  const read = service.updateNotification(recipient, f.wid, notices[0].id, { read: true })
  assert.ok(read.readAt)
  assert.equal(service.unreadNotificationCount(recipient, f.wid).unread, 2)
  assert.equal(service.updateNotification(recipient, f.wid, notices[0].id, { read: false }).readAt, null)
  assert.deepEqual(service.deleteNotification(recipient, f.wid, notices[0].id), { success: true })
  assert.equal(service.listNotifications(recipient, f.wid).length, 2)
  const other = fixture()
  denied(() => service.listNotifications(recipient, other.wid))
  denied(() => service.createComment(f.owner, f.wid, item.id, { body: `Forged [@Other](/app?workspace=${f.wid}&mentionUser=${other.owner})` }), 400)
})
test('comment authors and delegated comment managers can delete while ordinary readers cannot', () => {
  const f = fixture()
  assert.ok(service.getWorkspace(f.owner, f.wid).role.permissions.includes('comments:manage'))
  const author = createUser(), reader = createUser(), moderator = createUser()
  const contributor = service.createRole(f.owner, f.wid, { name: 'Commenter', permissions: ['items:read', 'items:write'] })
  const manager = service.createRole(f.owner, f.wid, { name: 'Moderator', permissions: ['items:read', 'comments:manage'] })
  add(f, author, contributor.id); add(f, reader, contributor.id); add(f, moderator, manager.id)
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Discussion' })
  const own = service.createComment(author, f.wid, item.id, { body: 'Author comment' })
  denied(() => service.deleteComment(reader, f.wid, item.id, own.id))
  assert.deepEqual(service.deleteComment(author, f.wid, item.id, own.id), { success: true })
  assert.equal(service.listComments(reader, f.wid, item.id)[0].body, '')
  denied(() => service.deleteComment(author, f.wid, item.id, own.id))
  service.deleteComment(moderator, f.wid, item.id, own.id)
  assert.equal(service.listComments(reader, f.wid, item.id).length, 0)
  const moderated = service.createComment(author, f.wid, item.id, { body: 'Moderated comment' })
  service.deleteComment(moderator, f.wid, item.id, moderated.id)
  assert.ok(service.listComments(reader, f.wid, item.id)[0].deletedAt)
  const other = fixture()
  denied(() => service.deleteComment(moderator, f.wid, other.list.id, moderated.id), 404)
})
test('comment replies stay on one task with bounded depth and reactions are unique per member', () => {
  const f = fixture()
  const author = createUser()
  const contributor = service.createRole(f.owner, f.wid, { name: 'Discussion contributor', permissions: ['items:read', 'items:write'] })
  add(f, author, contributor.id)
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Threaded discussion' })
  const otherItem = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Other discussion' })
  const root = service.createComment(f.owner, f.wid, item.id, { body: 'Root' })
  const reply = service.createComment(author, f.wid, item.id, { body: 'Reply', parentId: root.id })
  assert.equal(reply.parentId, root.id)
  service.deleteComment(f.owner, f.wid, item.id, root.id)
  service.deleteComment(f.owner, f.wid, item.id, root.id)
  assert.equal(service.listComments(author, f.wid, item.id)[0].parentId, null, 'purging a tombstone keeps its replies as roots')
  denied(() => service.createComment(author, f.wid, otherItem.id, { body: 'Cross-task reply', parentId: root.id }), 404)
  assert.deepEqual(service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: '👍', active: true }), { emoji: '👍', active: true, count: 1 })
  service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: '👍', active: true })
  service.updateCommentReaction(f.owner, f.wid, item.id, reply.id, { emoji: '👍', active: true })
  let listed = service.listComments(author, f.wid, item.id)
  assert.deepEqual(listed[0].reactions, [{ emoji: '👍', count: 2, reactedByMe: true }])
  service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: '👍', active: false })
  listed = service.listComments(author, f.wid, item.id)
  assert.deepEqual(listed[0].reactions, [{ emoji: '👍', count: 1, reactedByMe: false }])
  assert.throws(() => service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: 'not-an-emoji', active: true }))
  let parent = reply
  for (let depth = 1; depth < 32; depth++) parent = service.createComment(author, f.wid, item.id, { body: `Depth ${depth + 1}`, parentId: parent.id })
  denied(() => service.createComment(author, f.wid, item.id, { body: 'Too deep', parentId: parent.id }), 400)
})
test('item updates require both read and write, including empty or conditional patches', () => {
  for (const permission of ['items:read', 'items:write'] as const) {
    const f = fixture()
    const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Private task', description: 'Private description' })
    const member = createUser()
    const role = service.createRole(f.owner, f.wid, { name: permission, permissions: [permission] })
    add(f, member, role.id)
    const auditBefore = db.prepare('SELECT * FROM audit_logs WHERE workspaceId=?').all(f.wid)
    for (const input of [{}, { status: 'done' }, { expectedUpdatedAt: item.updatedAt }, { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }]) {
      denied(() => service.updateItem(member, f.wid, item.id, input))
    }
    assert.deepEqual(service.getItem(f.owner, f.wid, item.id), item)
    assert.deepEqual(db.prepare('SELECT * FROM audit_logs WHERE workspaceId=?').all(f.wid), auditBefore)
    if (permission === 'items:write') denied(() => service.getItem(member, f.wid, item.id))
    else assert.deepEqual(service.getItem(member, f.wid, item.id), item)
    service.updateRole(f.owner, f.wid, role.id, { permissions: ['items:read', 'items:write'] })
    assert.equal(service.updateItem(member, f.wid, item.id, { status: 'done' }).status, 'done')
  }
})
test('conditional updates reject stale versions without mutation and advance monotonically with a frozen clock', (t) => {
  const f = fixture()
  const initial = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Versioned', description: 'Keep me' })
  const clock = t.mock.method(Date, 'now', () => Date.parse(initial.updatedAt))
  let current = initial
  for (let index = 1; index <= 3; index++) {
    const next = service.updateItem(f.owner, f.wid, initial.id, { title: `Revision ${index}`, expectedUpdatedAt: current.updatedAt })
    assert.equal(Date.parse(next.updatedAt), Date.parse(initial.updatedAt) + index)
    assert.equal(next.description, 'Keep me')
    assert.equal(Object.hasOwn(next, 'expectedUpdatedAt'), false)
    current = next
  }
  const auditBefore = db.prepare('SELECT * FROM audit_logs WHERE workspaceId=?').all(f.wid)
  for (const input of [{ title: 'Lost update', expectedUpdatedAt: initial.updatedAt }, { expectedUpdatedAt: initial.updatedAt }, { expectedUpdatedAt: current.updatedAt.replace('Z', '+00:00') }]) {
    denied(() => service.updateItem(f.owner, f.wid, initial.id, input), 409)
  }
  assert.deepEqual(service.getItem(f.owner, f.wid, initial.id), current)
  assert.deepEqual(db.prepare('SELECT * FROM audit_logs WHERE workspaceId=?').all(f.wid), auditBefore)
  const details = (db.prepare("SELECT details FROM audit_logs WHERE resourceId=? AND action='item.update'").all(initial.id) as { details: string }[]).map((row) => JSON.parse(row.details))
  assert.deepEqual(details, Array.from({ length: 3 }, () => ({ fields: ['title'] })))
  clock.mock.mockImplementation(() => Date.parse(initial.updatedAt) - 1000)
  const legacy = service.updateItem(f.owner, f.wid, initial.id, { title: 'Unconditional last writer' })
  assert.equal(Date.parse(legacy.updatedAt), Date.parse(current.updatedAt) + 1)
  assert.equal(legacy.title, 'Unconditional last writer')
})
test('bulk archive and delete are atomic, versioned, workspace-scoped, and preserve task trees', () => {
  const f = fixture(); const other = fixture()
  const parent = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Parent' })
  const child = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Child', parentId: parent.id })
  denied(() => service.bulkItems(f.owner, f.wid, { action: 'archive', items: [{ id: parent.id, expectedUpdatedAt: parent.updatedAt }] }), 409)
  denied(() => service.bulkItems(f.owner, f.wid, { action: 'archive', items: [
    { id: parent.id, expectedUpdatedAt: parent.updatedAt },
    { id: other.list.id, expectedUpdatedAt: child.updatedAt },
  ] }), 404)
  assert.equal(service.listItems(f.owner, f.wid).length, 2)
  const archived = service.bulkItems(f.owner, f.wid, { action: 'archive', items: [
    { id: parent.id, expectedUpdatedAt: parent.updatedAt },
    { id: child.id, expectedUpdatedAt: child.updatedAt },
  ] })
  assert.deepEqual(archived, { action: 'archive', affected: 2 })
  assert.deepEqual(service.listItems(f.owner, f.wid), [])
  const included = service.listItems(f.owner, f.wid, { archived: 'include' })
  assert.equal(included.length, 2)
  assert.ok(included.every(item => item.archivedAt !== null && Date.parse(item.updatedAt) > Date.parse(parent.updatedAt)))
  denied(() => service.bulkItems(f.owner, f.wid, { action: 'delete', items: included.map(item => ({ id: item.id, expectedUpdatedAt: parent.updatedAt })) }), 409)
  assert.equal(service.listItems(f.owner, f.wid, { archived: 'only' }).length, 2)
  assert.deepEqual(service.bulkItems(f.owner, f.wid, { action: 'delete', items: included.map(item => ({ id: item.id, expectedUpdatedAt: item.updatedAt })) }), { action: 'delete', affected: 2 })
  assert.deepEqual(service.listItems(f.owner, f.wid, { archived: 'include' }), [])
  const audits = db.prepare("SELECT action,details FROM audit_logs WHERE workspaceId=? AND action LIKE 'item.bulk.%' ORDER BY createdAt").all(f.wid) as { action: string; details: string }[]
  assert.deepEqual(audits.map(row => ({ action: row.action, details: JSON.parse(row.details) })), [
    { action: 'item.bulk.archive', details: { count: 2 } },
    { action: 'item.bulk.delete', details: { count: 2 } },
  ])
})
test('field and membership cleanup advance item versions and invalidate stale editors', (t) => {
  const f = fixture(); const member = createUser()
  add(f, member, service.listRoles(f.owner, f.wid).find((role) => role.name === 'Viewer')!.id)
  const field = service.createField(f.owner, f.wid, { name: 'Removed', type: 'text' })
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Cleanup', assigneeId: member, customFields: { [field.id]: 'value' } })
  t.mock.method(Date, 'now', () => Date.parse(item.updatedAt))
  service.deleteField(f.owner, f.wid, field.id)
  const afterField = service.getItem(f.owner, f.wid, item.id)
  assert.equal(Date.parse(afterField.updatedAt), Date.parse(item.updatedAt) + 1)
  service.deleteMember(f.owner, f.wid, member)
  const afterMember = service.getItem(f.owner, f.wid, item.id)
  assert.equal(Date.parse(afterMember.updatedAt), Date.parse(afterField.updatedAt) + 1)
  denied(() => service.updateItem(f.owner, f.wid, item.id, { expectedUpdatedAt: afterField.updatedAt, assigneeId: member }), 409)
})
test('custom role managers cannot grant, modify, or remove stronger roles or owner memberships', () => {
  const f = fixture(); const manager = createUser(); const candidate = createUser()
  const role = service.createRole(f.owner, f.wid, { name: 'Delegated', permissions: ['items:read', 'roles:manage', 'members:manage'] })
  add(f, manager, role.id)
  const ownerRole = service.listRoles(f.owner, f.wid).find((role) => role.isOwner)!
  const memberRole = service.listRoles(f.owner, f.wid).find((role) => role.name === 'Member')!
  denied(() => service.updateRole(manager, f.wid, role.id, { permissions: [...permissions] }))
  denied(() => service.createRole(manager, f.wid, { name: 'Escalated', permissions: ['items:write'] }))
  denied(() => service.updateRole(manager, f.wid, memberRole.id, { permissions: [] }))
  denied(() => service.deleteRole(manager, f.wid, memberRole.id))
  denied(() => service.addMember(manager, f.wid, { email: `${candidate}@example.test`, roleId: ownerRole.id }))
  denied(() => service.updateMember(manager, f.wid, manager, { roleId: ownerRole.id }))
  denied(() => service.deleteMember(manager, f.wid, f.owner))
  const delegated = service.createRole(manager, f.wid, { name: 'Read only', permissions: ['items:read'] })
  assert.deepEqual(delegated.permissions, ['items:read'])
})
test('Owner role is immutable and last owner protection permits explicit succession', () => {
  const f = fixture(); const successor = createUser()
  const roles = service.listRoles(f.owner, f.wid)
  const ownerRole = roles.find((role) => role.isOwner)!
  const viewerRole = roles.find((role) => role.name === 'Viewer')!
  denied(() => service.updateRole(f.owner, f.wid, ownerRole.id, { name: 'Changed' }))
  denied(() => service.deleteRole(f.owner, f.wid, ownerRole.id))
  denied(() => service.deleteMember(f.owner, f.wid, f.owner), 409)
  denied(() => service.updateMember(f.owner, f.wid, f.owner, { roleId: viewerRole.id }), 409)
  add(f, successor, ownerRole.id)
  service.updateMember(f.owner, f.wid, f.owner, { roleId: viewerRole.id })
  assert.equal(requirePermission(successor, f.wid, 'workspace:manage').isOwner, true)
  denied(() => requirePermission(f.owner, f.wid, 'workspace:manage'))
})
test('member removal clears assignments and roles cannot be deleted while assigned', () => {
  const f = fixture(); const member = createUser()
  const role = service.createRole(f.owner, f.wid, { name: 'Assigned', permissions: ['items:read'] })
  add(f, member, role.id)
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Assigned', assigneeId: member })
  denied(() => service.deleteRole(f.owner, f.wid, role.id), 409)
  service.deleteMember(f.owner, f.wid, member)
  assert.equal(service.getItem(f.owner, f.wid, item.id).assigneeId, null)
  service.deleteRole(f.owner, f.wid, role.id)
})
test('removing an already disabled owner does not mistake the remaining active owner for the target', () => {
  const f = fixture(); const disabled = createUser()
  const ownerRole = service.listRoles(f.owner, f.wid).find((role) => role.isOwner)!
  add(f, disabled, ownerRole.id)
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(disabled)
  service.deleteMember(f.owner, f.wid, disabled)
  assert.equal(requirePermission(f.owner, f.wid, 'workspace:manage').isOwner, true)
})
test('mutations roll back when audit insertion fails, and audit omits task contents', () => {
  const f = fixture()
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test audit failure'); END")
  try { assert.throws(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Secret title', description: 'Secret prompt' })) }
  finally { db.exec('DROP TRIGGER fail_audit') }
  assert.equal(service.listItems(f.owner, f.wid).length, 0)
  const item = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Secret title', description: 'Secret prompt' })
  service.updateItem(f.owner, f.wid, item.id, { description: 'Private content' })
  const serialized = JSON.stringify(db.prepare('SELECT * FROM audit_logs WHERE workspaceId=?').all(f.wid))
  for (const value of ['Secret title', 'Secret prompt', 'Private content']) assert.equal(serialized.includes(value), false)
})

test('task checklists round-trip with id normalization and enforce entry bounds', () => {
  const f = fixture()
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const kept = randomUUID()
  const created = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Checklist task',
    checklist: [{ text: '  First  ' }, { id: 'not-a-uuid', text: 'Second', done: true }, { id: kept, text: 'Third' }] })
  assert.equal(created.checklist.length, 3)
  assert.equal(created.checklist[0].text, 'First')
  assert.equal(created.checklist[0].done, false)
  assert.ok(uuid.test(created.checklist[0].id), 'missing ids are generated')
  assert.ok(uuid.test(created.checklist[1].id), 'invalid ids are regenerated')
  assert.equal(created.checklist[2].id, kept)
  assert.deepEqual(service.getItem(f.owner, f.wid, created.id).checklist, created.checklist)
  const updated = service.updateItem(f.owner, f.wid, created.id, { checklist: [{ id: created.checklist[0].id, text: 'First', done: true }] })
  assert.deepEqual(updated.checklist, [{ id: created.checklist[0].id, text: 'First', done: true }])
  assert.deepEqual(service.exportWorkspace(f.owner, f.wid).items.find((entry) => entry.id === created.id)?.checklist, updated.checklist)
  // Structural caps reject at the schema boundary; content rules map to 400.
  assert.throws(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Too many', checklist: Array.from({ length: 101 }, (_, index) => ({ text: `Entry ${index}` })) }))
  assert.throws(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Huge', checklist: [{ text: 'x'.repeat(401) }] }))
  denied(() => service.updateItem(f.owner, f.wid, created.id, { checklist: [{ text: '' }] }), 400)
  denied(() => service.updateItem(f.owner, f.wid, created.id, { checklist: [{ text: '   ' }] }), 400)
  denied(() => service.updateItem(f.owner, f.wid, created.id, { checklist: [{ text: 'x'.repeat(201) }] }), 400)
  const plain = service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Plain' })
  assert.deepEqual(plain.checklist, [])
  assert.equal(plain.parentId, null)
})
