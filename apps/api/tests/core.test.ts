import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-core-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { db, service, requirePermission, permissions, HttpError } = await import('../app/core.js')
const { hashPassword, verifyPassword } = await import('../app/security.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })
const createUser = async (isAdmin = false) => {
  const id = randomUUID()
  await db.run('INSERT INTO users (id,name,email,isAdmin,createdAt) VALUES (?,?,?,?,?)', id, 'Test', `${id}@example.test`, Number(isAdmin), new Date().toISOString())
  return id
}
async function fixture() {
  const owner = await createUser()
  const workspace = await service.createWorkspace(owner, { name: 'Workspace' })
  const project = await service.createNode(owner, workspace.id, { name: 'Project', kind: 'project' })
  const list = await service.createNode(owner, workspace.id, { name: 'List', kind: 'list', parentId: project.id })
  return { owner, wid: workspace.id, project, list }
}
const denied = (operation: () => Promise<unknown>, status = 403) => assert.rejects(operation, (error: unknown) => error instanceof HttpError && error.status === status)
function add(f: Awaited<ReturnType<typeof fixture>>, userId: string, roleId: string) {
  return service.addMember(f.owner, f.wid, { email: `${userId}@example.test`, roleId })
}

test('the Lucid baseline migration is recorded and SQLite integrity is enabled', async () => {
  assert.ok(await db.get('SELECT name FROM adonis_schema WHERE name=?', 'database/migrations/0000_baseline'))
  assert.equal((await db.get<{ value: number }>('SELECT foreign_keys AS value FROM pragma_foreign_keys'))?.value, 1)
  assert.equal((await db.get<{ value: string }>('SELECT journal_mode AS value FROM pragma_journal_mode'))?.value, 'wal')
  assert.equal((await db.get<{ value: string }>('SELECT integrity_check AS value FROM pragma_integrity_check'))?.value, 'ok')
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
test('workspace isolation applies to site admins and disabled users', async () => {
  const f = await fixture()
  const outsider = await createUser(true)
  await denied(() => service.getWorkspace(outsider, f.wid))
  await denied(() => service.listItems(outsider, f.wid))
  await denied(() => service.exportWorkspace(outsider, f.wid))
  assert.deepEqual(await service.listWorkspaces(outsider), [])
  await db.run('UPDATE users SET disabled=1 WHERE id=?', f.owner)
  await denied(() => requirePermission(f.owner, f.wid, 'items:read'))
})
test('only owners can delete a workspace and its relational contents with an atomic audit', async () => {
  const f = await fixture()
  const manager = await createUser()
  const siteAdmin = await createUser(true)
  const managerRole = await service.createRole(f.owner, f.wid, { name: 'Workspace manager', permissions: ['workspace:manage'] })
  await add(f, manager, managerRole.id)
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Delete with workspace' })
  const objectKey = `${f.wid}/attachment`
  await db.transaction(async (database) => {
    await database.run('INSERT INTO storage_objects(objectKey,driver,location,createdAt) VALUES (?,?,?,?)', objectKey, 'filesystem', objectKey, new Date().toISOString())
    await database.run('INSERT INTO attachments(id,workspaceId,itemId,objectKey,name,contentType,size,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      randomUUID(), f.wid, item.id, objectKey, 'private.txt', 'text/plain', 7, f.owner, new Date().toISOString())
  })
  await denied(() => service.deleteWorkspace(manager, f.wid))
  await denied(() => service.deleteWorkspace(siteAdmin, f.wid))
  await db.run("CREATE TRIGGER fail_workspace_delete_audit BEFORE INSERT ON audit_logs WHEN NEW.action='workspace.delete' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  try { await assert.rejects(() => service.deleteWorkspace(f.owner, f.wid)) }
  finally { await db.run('DROP TRIGGER fail_workspace_delete_audit') }
  assert.ok(await db.get('SELECT id FROM workspaces WHERE id=?', f.wid))
  assert.ok(await db.get('SELECT id FROM items WHERE id=?', item.id))
  assert.deepEqual(await service.deleteWorkspace(f.owner, f.wid), { success: true })
  assert.equal(await db.get('SELECT id FROM workspaces WHERE id=?', f.wid), undefined)
  for (const table of ['memberships', 'roles', 'nodes', 'items', 'fields', 'attachments']) {
    assert.equal((await db.get<{ count: number }>(`SELECT count(*) AS count FROM ${table} WHERE workspaceId=?`, f.wid))?.count, 0)
  }
  assert.ok(await db.get('SELECT objectKey FROM storage_objects WHERE objectKey=?', objectKey))
  const auditRow = await db.get<{ details: string }>("SELECT details FROM audit_logs WHERE workspaceId=? AND action='workspace.delete'", f.wid)
  assert.ok(auditRow)
  assert.deepEqual(JSON.parse(auditRow.details), { members: 2, nodes: 2, documents: 0, items: 1, attachments: 1 })
})
test('task CRUD preserves omitted values, filters literal search, and validates dates and references', async () => {
  const f = await fixture(); const other = await fixture()
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: '100% work_', description: 'Details', tags: [' urgent ', 'urgent'], startDate: '2024-02-29', dueDate: '2024-03-01' })
  assert.deepEqual(item.tags, ['urgent'])
  assert.equal(item.status, 'todo')
  const updated = await service.updateItem(f.owner, f.wid, item.id, { priority: 'high' })
  assert.equal(updated.description, 'Details')
  assert.equal(updated.startDate, '2024-02-29')
  assert.equal((await service.listItems(f.owner, f.wid, { search: '% work_' })).length, 1)
  assert.equal((await service.listItems(f.owner, f.wid, { search: "' OR 1=1 --" })).length, 0)
  assert.equal((await service.listItems(f.owner, f.wid, { status: 'done' })).length, 0)
  await assert.rejects(() => service.updateItem(f.owner, f.wid, item.id, { dueDate: '2025-02-29' }))
  await denied(() => service.updateItem(f.owner, f.wid, item.id, { dueDate: '2024-01-01' }), 400)
  await denied(() => service.updateItem(f.owner, f.wid, item.id, { nodeId: other.list.id }), 404)
  await denied(() => service.updateItem(f.owner, f.wid, item.id, { assigneeId: other.owner }), 400)
  await denied(() => service.createItem(f.owner, f.wid, { nodeId: f.project.id, title: 'Not a list' }), 400)
  await denied(() => service.getItem(other.owner, other.wid, item.id), 404)
  await assert.rejects(() => service.updateItem(f.owner, f.wid, item.id, { workspaceId: other.wid }))
  await service.deleteItem(f.owner, f.wid, item.id)
  await denied(() => service.getItem(f.owner, f.wid, item.id), 404)
})
test('task description markdown normalizes line endings and strips control characters verbatim', async () => {
  const f = await fixture()
  const markdown = '# Heading\n**bold** and *italic*\n- item one\n- item two\n[link](https://example.com)\n  padded spaces  '
  assert.equal((await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Markdown', description: markdown })).description, markdown)
  const crlf = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'CRLF', description: 'a\r\nb\rc' })
  assert.equal((await service.getItem(f.owner, f.wid, crlf.id)).description, 'a\nb\nc')
  assert.equal((await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Controls', description: 'a\u0000b\u0001c\u0007d\u0008e\tf\ng' })).description, 'abcde\tf\ng')
  const patch = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Patch', description: 'x' })
  assert.equal((await service.updateItem(f.owner, f.wid, patch.id, { description: 'p\r\nq\u0001r' })).description, 'p\nqr')
  await assert.rejects(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Too long', description: 'x'.repeat(50001) }))
  const patchLong = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Patch long' })
  await assert.rejects(() => service.updateItem(f.owner, f.wid, patchLong.id, { description: 'x'.repeat(50001) }))
})
test('assignments and validated task/comment mentions create private workspace notifications', async () => {
  const f = await fixture()
  const recipient = await createUser()
  const role = await service.createRole(f.owner, f.wid, { name: 'Contributor', permissions: ['items:read', 'items:write'] })
  await add(f, recipient, role.id)
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Notify me', assigneeId: recipient,
    description: `Hello [@Test](/app?workspace=${f.wid}&mentionUser=${recipient})` })
  let notices = await service.listNotifications(recipient, f.wid)
  assert.deepEqual(notices.map(row => row.type).sort(), ['assignment', 'mention'])
  assert.equal((await service.unreadNotificationCount(recipient, f.wid)).unread, 2)
  await service.updateItem(f.owner, f.wid, item.id, { description: item.description })
  assert.equal((await service.listNotifications(recipient, f.wid)).length, 2, 'unchanged mentions must not notify again')
  const comment = await service.createComment(f.owner, f.wid, item.id, { body: `Please review [@Test](/app?workspace=${f.wid}&mentionUser=${recipient})` })
  notices = await service.listNotifications(recipient, f.wid)
  assert.equal(notices.length, 3)
  assert.equal(notices[0].commentId, comment.id)
  const read = await service.updateNotification(recipient, f.wid, notices[0].id, { read: true })
  assert.ok(read.readAt)
  assert.equal((await service.unreadNotificationCount(recipient, f.wid)).unread, 2)
  assert.equal((await service.updateNotification(recipient, f.wid, notices[0].id, { read: false })).readAt, null)
  assert.deepEqual(await service.deleteNotification(recipient, f.wid, notices[0].id), { success: true })
  assert.equal((await service.listNotifications(recipient, f.wid)).length, 2)
  const other = await fixture()
  await denied(() => service.listNotifications(recipient, other.wid))
  await denied(() => service.createComment(f.owner, f.wid, item.id, { body: `Forged [@Other](/app?workspace=${f.wid}&mentionUser=${other.owner})` }), 400)
})
test('comment authors and delegated comment managers can delete while ordinary readers cannot', async () => {
  const f = await fixture()
  assert.ok((await service.getWorkspace(f.owner, f.wid)).role.permissions.includes('comments:manage'))
  const author = await createUser(), reader = await createUser(), moderator = await createUser()
  const contributor = await service.createRole(f.owner, f.wid, { name: 'Commenter', permissions: ['items:read', 'items:write', 'comments:create'] })
  const manager = await service.createRole(f.owner, f.wid, { name: 'Moderator', permissions: ['items:read', 'comments:manage'] })
  await add(f, author, contributor.id); await add(f, reader, contributor.id); await add(f, moderator, manager.id)
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Discussion' })
  const own = await service.createComment(author, f.wid, item.id, { body: 'Author comment' })
  await denied(() => service.deleteComment(reader, f.wid, item.id, own.id))
  assert.deepEqual(await service.deleteComment(author, f.wid, item.id, own.id), { success: true })
  assert.equal((await service.listComments(reader, f.wid, item.id))[0].body, '')
  await denied(() => service.deleteComment(author, f.wid, item.id, own.id))
  await service.deleteComment(moderator, f.wid, item.id, own.id)
  assert.equal((await service.listComments(reader, f.wid, item.id)).length, 0)
  const moderated = await service.createComment(author, f.wid, item.id, { body: 'Moderated comment' })
  await service.deleteComment(moderator, f.wid, item.id, moderated.id)
  assert.ok((await service.listComments(reader, f.wid, item.id))[0].deletedAt)
  const other = await fixture()
  await denied(() => service.deleteComment(moderator, f.wid, other.list.id, moderated.id), 404)
})
test('comment replies stay on one task with bounded depth and reactions are unique per member', async () => {
  const f = await fixture()
  const author = await createUser()
  const contributor = await service.createRole(f.owner, f.wid, { name: 'Discussion contributor', permissions: ['items:read', 'items:write', 'comments:create'] })
  await add(f, author, contributor.id)
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Threaded discussion' })
  const otherItem = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Other discussion' })
  const root = await service.createComment(f.owner, f.wid, item.id, { body: 'Root' })
  const reply = await service.createComment(author, f.wid, item.id, { body: 'Reply', parentId: root.id })
  assert.equal(reply.parentId, root.id)
  await service.deleteComment(f.owner, f.wid, item.id, root.id)
  await service.deleteComment(f.owner, f.wid, item.id, root.id)
  assert.equal((await service.listComments(author, f.wid, item.id))[0].parentId, null, 'purging a tombstone keeps its replies as roots')
  await denied(() => service.createComment(author, f.wid, otherItem.id, { body: 'Cross-task reply', parentId: root.id }), 404)
  assert.deepEqual(await service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: '👍', active: true }), { emoji: '👍', active: true, count: 1 })
  await service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: '👍', active: true })
  await service.updateCommentReaction(f.owner, f.wid, item.id, reply.id, { emoji: '👍', active: true })
  let listed = await service.listComments(author, f.wid, item.id)
  assert.deepEqual(listed[0].reactions, [{ emoji: '👍', count: 2, reactedByMe: true }])
  await service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: '👍', active: false })
  listed = await service.listComments(author, f.wid, item.id)
  assert.deepEqual(listed[0].reactions, [{ emoji: '👍', count: 1, reactedByMe: false }])
  await assert.rejects(() => service.updateCommentReaction(author, f.wid, item.id, reply.id, { emoji: 'not-an-emoji', active: true }))
  let parent = reply
  for (let depth = 1; depth < 32; depth++) parent = await service.createComment(author, f.wid, item.id, { body: `Depth ${depth + 1}`, parentId: parent.id })
  await denied(() => service.createComment(author, f.wid, item.id, { body: 'Too deep', parentId: parent.id }), 400)
})
test('item updates require both read and write, including empty or conditional patches', async () => {
  for (const permission of ['items:read', 'items:write'] as const) {
    const f = await fixture()
    const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Private task', description: 'Private description' })
    const member = await createUser()
    const role = await service.createRole(f.owner, f.wid, { name: permission, permissions: [permission] })
    await add(f, member, role.id)
    const auditBefore = await db.all('SELECT * FROM audit_logs WHERE workspaceId=?', f.wid)
    for (const input of [{}, { status: 'done' }, { expectedUpdatedAt: item.updatedAt }, { expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }]) {
      await denied(() => service.updateItem(member, f.wid, item.id, input))
    }
    assert.deepEqual(await service.getItem(f.owner, f.wid, item.id), item)
    assert.deepEqual(await db.all('SELECT * FROM audit_logs WHERE workspaceId=?', f.wid), auditBefore)
    if (permission === 'items:write') await denied(() => service.getItem(member, f.wid, item.id))
    else assert.deepEqual(await service.getItem(member, f.wid, item.id), item)
    await service.updateRole(f.owner, f.wid, role.id, { permissions: ['items:read', 'items:write'] })
    assert.equal((await service.updateItem(member, f.wid, item.id, { status: 'done' })).status, 'done')
  }
})
test('conditional updates reject stale versions without mutation and advance monotonically with a frozen clock', async (t) => {
  const f = await fixture()
  const initial = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Versioned', description: 'Keep me' })
  const clock = t.mock.method(Date, 'now', () => Date.parse(initial.updatedAt))
  let current = initial
  for (let index = 1; index <= 3; index++) {
    const next = await service.updateItem(f.owner, f.wid, initial.id, { title: `Revision ${index}`, expectedUpdatedAt: current.updatedAt })
    assert.equal(Date.parse(next.updatedAt), Date.parse(initial.updatedAt) + index)
    assert.equal(next.description, 'Keep me')
    assert.equal(Object.hasOwn(next, 'expectedUpdatedAt'), false)
    current = next
  }
  const auditBefore = await db.all('SELECT * FROM audit_logs WHERE workspaceId=?', f.wid)
  for (const input of [{ title: 'Lost update', expectedUpdatedAt: initial.updatedAt }, { expectedUpdatedAt: initial.updatedAt }, { expectedUpdatedAt: current.updatedAt.replace('Z', '+00:00') }]) {
    await denied(() => service.updateItem(f.owner, f.wid, initial.id, input), 409)
  }
  assert.deepEqual(await service.getItem(f.owner, f.wid, initial.id), current)
  assert.deepEqual(await db.all('SELECT * FROM audit_logs WHERE workspaceId=?', f.wid), auditBefore)
  const details = (await db.all<{ details: string }>("SELECT details FROM audit_logs WHERE resourceId=? AND action='item.update'", initial.id)).map((row) => JSON.parse(row.details))
  assert.deepEqual(details, Array.from({ length: 3 }, () => ({ fields: ['title'] })))
  clock.mock.mockImplementation(() => Date.parse(initial.updatedAt) - 1000)
  const legacy = await service.updateItem(f.owner, f.wid, initial.id, { title: 'Unconditional last writer' })
  assert.equal(Date.parse(legacy.updatedAt), Date.parse(current.updatedAt) + 1)
  assert.equal(legacy.title, 'Unconditional last writer')
})
test('bulk archive and delete are atomic, versioned, workspace-scoped, and preserve task trees', async () => {
  const f = await fixture(); const other = await fixture()
  const parent = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Parent' })
  const child = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Child', parentId: parent.id })
  await denied(() => service.bulkItems(f.owner, f.wid, { action: 'archive', items: [{ id: parent.id, expectedUpdatedAt: parent.updatedAt }] }), 409)
  await denied(() => service.bulkItems(f.owner, f.wid, { action: 'archive', items: [
    { id: parent.id, expectedUpdatedAt: parent.updatedAt },
    { id: other.list.id, expectedUpdatedAt: child.updatedAt },
  ] }), 404)
  assert.equal((await service.listItems(f.owner, f.wid)).length, 2)
  const archived = await service.bulkItems(f.owner, f.wid, { action: 'archive', items: [
    { id: parent.id, expectedUpdatedAt: parent.updatedAt },
    { id: child.id, expectedUpdatedAt: child.updatedAt },
  ] })
  assert.deepEqual(archived, { action: 'archive', affected: 2 })
  assert.deepEqual(await service.listItems(f.owner, f.wid), [])
  const included = await service.listItems(f.owner, f.wid, { archived: 'include' })
  assert.equal(included.length, 2)
  assert.ok(included.every(item => item.archivedAt !== null && Date.parse(item.updatedAt) > Date.parse(parent.updatedAt)))
  await denied(() => service.bulkItems(f.owner, f.wid, { action: 'delete', items: included.map(item => ({ id: item.id, expectedUpdatedAt: parent.updatedAt })) }), 409)
  assert.equal((await service.listItems(f.owner, f.wid, { archived: 'only' })).length, 2)
  assert.deepEqual(await service.bulkItems(f.owner, f.wid, { action: 'delete', items: included.map(item => ({ id: item.id, expectedUpdatedAt: item.updatedAt })) }), { action: 'delete', affected: 2 })
  assert.deepEqual(await service.listItems(f.owner, f.wid, { archived: 'include' }), [])
  const audits = await db.all<{ action: string; details: string }>("SELECT action,details FROM audit_logs WHERE workspaceId=? AND action LIKE 'item.bulk.%' ORDER BY createdAt", f.wid)
  assert.deepEqual(audits.map(row => ({ action: row.action, details: JSON.parse(row.details) })), [
    { action: 'item.bulk.archive', details: { count: 2 } },
    { action: 'item.bulk.delete', details: { count: 2 } },
  ])
})
test('field and membership cleanup advance item versions and invalidate stale editors', async (t) => {
  const f = await fixture(); const member = await createUser()
  await add(f, member, (await service.listRoles(f.owner, f.wid)).find((role) => role.name === 'Viewer')!.id)
  const field = await service.createField(f.owner, f.wid, { name: 'Removed', type: 'text' })
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Cleanup', assigneeId: member, customFields: { [field.id]: 'value' } })
  t.mock.method(Date, 'now', () => Date.parse(item.updatedAt))
  await service.deleteField(f.owner, f.wid, field.id)
  const afterField = await service.getItem(f.owner, f.wid, item.id)
  assert.equal(Date.parse(afterField.updatedAt), Date.parse(item.updatedAt) + 1)
  await service.deleteMember(f.owner, f.wid, member)
  const afterMember = await service.getItem(f.owner, f.wid, item.id)
  assert.equal(Date.parse(afterMember.updatedAt), Date.parse(afterField.updatedAt) + 1)
  await denied(() => service.updateItem(f.owner, f.wid, item.id, { expectedUpdatedAt: afterField.updatedAt, assigneeId: member }), 409)
})
test('custom role managers cannot grant, modify, or remove stronger roles or owner memberships', async () => {
  const f = await fixture(); const manager = await createUser(); const candidate = await createUser()
  const role = await service.createRole(f.owner, f.wid, { name: 'Delegated', permissions: ['items:read', 'roles:manage', 'members:manage'] })
  await add(f, manager, role.id)
  const roles = await service.listRoles(f.owner, f.wid)
  const ownerRole = roles.find((role) => role.isOwner)!
  const memberRole = roles.find((role) => role.name === 'Member')!
  await denied(() => service.updateRole(manager, f.wid, role.id, { permissions: [...permissions] }))
  await denied(() => service.createRole(manager, f.wid, { name: 'Escalated', permissions: ['items:write'] }))
  await denied(() => service.updateRole(manager, f.wid, memberRole.id, { permissions: [] }))
  await denied(() => service.deleteRole(manager, f.wid, memberRole.id))
  await denied(() => service.addMember(manager, f.wid, { email: `${candidate}@example.test`, roleId: ownerRole.id }))
  await denied(() => service.updateMember(manager, f.wid, manager, { roleId: ownerRole.id }))
  await denied(() => service.deleteMember(manager, f.wid, f.owner))
  const delegated = await service.createRole(manager, f.wid, { name: 'Read only', permissions: ['items:read'] })
  assert.deepEqual(delegated.permissions, ['items:read'])
})
test('Owner role is immutable and last owner protection permits explicit succession', async () => {
  const f = await fixture(); const successor = await createUser()
  const roles = await service.listRoles(f.owner, f.wid)
  const ownerRole = roles.find((role) => role.isOwner)!
  const viewerRole = roles.find((role) => role.name === 'Viewer')!
  await denied(() => service.updateRole(f.owner, f.wid, ownerRole.id, { name: 'Changed' }))
  await denied(() => service.deleteRole(f.owner, f.wid, ownerRole.id))
  await denied(() => service.deleteMember(f.owner, f.wid, f.owner), 409)
  await denied(() => service.updateMember(f.owner, f.wid, f.owner, { roleId: viewerRole.id }), 409)
  await add(f, successor, ownerRole.id)
  await service.updateMember(f.owner, f.wid, f.owner, { roleId: viewerRole.id })
  assert.equal((await requirePermission(successor, f.wid, 'workspace:manage')).isOwner, true)
  await denied(() => requirePermission(f.owner, f.wid, 'workspace:manage'))
})
test('member removal clears assignments and roles cannot be deleted while assigned', async () => {
  const f = await fixture(); const member = await createUser()
  const role = await service.createRole(f.owner, f.wid, { name: 'Assigned', permissions: ['items:read'] })
  await add(f, member, role.id)
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Assigned', assigneeId: member })
  await denied(() => service.deleteRole(f.owner, f.wid, role.id), 409)
  await service.deleteMember(f.owner, f.wid, member)
  assert.equal((await service.getItem(f.owner, f.wid, item.id)).assigneeId, null)
  await service.deleteRole(f.owner, f.wid, role.id)
})
test('removing an already disabled owner does not mistake the remaining active owner for the target', async () => {
  const f = await fixture(); const disabled = await createUser()
  const ownerRole = (await service.listRoles(f.owner, f.wid)).find((role) => role.isOwner)!
  await add(f, disabled, ownerRole.id)
  await db.run('UPDATE users SET disabled=1 WHERE id=?', disabled)
  await service.deleteMember(f.owner, f.wid, disabled)
  assert.equal((await requirePermission(f.owner, f.wid, 'workspace:manage')).isOwner, true)
})
test('mutations roll back when audit insertion fails, and audit omits task contents', async () => {
  const f = await fixture()
  await db.run("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'test audit failure'); END")
  try { await assert.rejects(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Secret title', description: 'Secret prompt' })) }
  finally { await db.run('DROP TRIGGER fail_audit') }
  assert.equal((await service.listItems(f.owner, f.wid)).length, 0)
  const item = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Secret title', description: 'Secret prompt' })
  await service.updateItem(f.owner, f.wid, item.id, { description: 'Private content' })
  const serialized = JSON.stringify(await db.all('SELECT * FROM audit_logs WHERE workspaceId=?', f.wid))
  for (const value of ['Secret title', 'Secret prompt', 'Private content']) assert.equal(serialized.includes(value), false)
})

test('task checklists round-trip with id normalization and enforce entry bounds', async () => {
  const f = await fixture()
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const kept = randomUUID()
  const created = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Checklist task',
    checklist: [{ text: '  First  ' }, { id: 'not-a-uuid', text: 'Second', done: true }, { id: kept, text: 'Third' }] })
  assert.equal(created.checklist.length, 3)
  assert.equal(created.checklist[0].text, 'First')
  assert.equal(created.checklist[0].done, false)
  assert.ok(uuid.test(created.checklist[0].id), 'missing ids are generated')
  assert.ok(uuid.test(created.checklist[1].id), 'invalid ids are regenerated')
  assert.equal(created.checklist[2].id, kept)
  assert.deepEqual((await service.getItem(f.owner, f.wid, created.id)).checklist, created.checklist)
  const updated = await service.updateItem(f.owner, f.wid, created.id, { checklist: [{ id: created.checklist[0].id, text: 'First', done: true }] })
  assert.deepEqual(updated.checklist, [{ id: created.checklist[0].id, text: 'First', done: true }])
  assert.deepEqual((await service.exportWorkspace(f.owner, f.wid)).items.find((entry) => entry.id === created.id)?.checklist, updated.checklist)
  // Structural caps reject at the schema boundary; content rules map to 400.
  await assert.rejects(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Too many', checklist: Array.from({ length: 101 }, (_, index) => ({ text: `Entry ${index}` })) }))
  await assert.rejects(() => service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Huge', checklist: [{ text: 'x'.repeat(401) }] }))
  await denied(() => service.updateItem(f.owner, f.wid, created.id, { checklist: [{ text: '' }] }), 400)
  await denied(() => service.updateItem(f.owner, f.wid, created.id, { checklist: [{ text: '   ' }] }), 400)
  await denied(() => service.updateItem(f.owner, f.wid, created.id, { checklist: [{ text: 'x'.repeat(201) }] }), 400)
  const plain = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Plain' })
  assert.deepEqual(plain.checklist, [])
  assert.equal(plain.parentId, null)
})
