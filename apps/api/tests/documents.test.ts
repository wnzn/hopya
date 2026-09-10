import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-documents-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { db, service, HttpError } = await import('../app/core.js')
const { documentService } = await import('../app/documents.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

const createUser = async () => {
  const id = randomUUID()
  await db.run('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)', id, 'Reader', `${id}@example.test`, new Date().toISOString())
  return id
}
const denied = (operation: () => Promise<unknown>, status = 403) => assert.rejects(operation, (error: unknown) => error instanceof HttpError && error.status === status)

async function fixture() {
  const owner = await createUser()
  const workspace = await service.createWorkspace(owner, { name: 'Documents' })
  const project = await service.createNode(owner, workspace.id, { name: 'Project', kind: 'project' })
  const folder = await service.createNode(owner, workspace.id, { name: 'Folder', kind: 'folder', parentId: project.id })
  const list = await service.createNode(owner, workspace.id, { name: 'List', kind: 'list', parentId: folder.id })
  return { owner, wid: workspace.id, project, folder, list }
}

test('documents use dedicated permissions and preserve linked tasks on deletion', async () => {
  const f = await fixture()
  const reader = await createUser()
  const role = await service.createRole(f.owner, f.wid, { name: 'Document reader', permissions: ['documents:read'] })
  await service.addMember(f.owner, f.wid, { email: `${reader}@example.test`, roleId: role.id })
  const writer = await createUser()
  const writerRole = await service.createRole(f.owner, f.wid, { name: 'Document writer', permissions: ['documents:write'] })
  await service.addMember(f.owner, f.wid, { email: `${writer}@example.test`, roleId: writerRole.id })
  const taskReader = await createUser()
  const taskReaderRole = await service.createRole(f.owner, f.wid, { name: 'Task-only reader', permissions: ['items:read'] })
  await service.addMember(f.owner, f.wid, { email: `${taskReader}@example.test`, roleId: taskReaderRole.id })
  const documentEditor = await createUser()
  const documentEditorRole = await service.createRole(f.owner, f.wid, { name: 'Document-only editor', permissions: ['documents:read', 'documents:write'] })
  await service.addMember(f.owner, f.wid, { email: `${documentEditor}@example.test`, roleId: documentEditorRole.id })
  const document = await documentService.createDocument(f.owner, f.wid, { title: 'Guide', body: 'Read this guide', parentId: f.folder.id })
  const page = await documentService.createSubpage(documentEditor, f.wid, document.id, { title: 'Notes', placement: 'page' })
  const nestedPage = await documentService.createSubpage(documentEditor, f.wid, page.id, { title: 'Details' })
  await denied(() => documentService.createSubpage(documentEditor, f.wid, page.id, { title: 'Invalid root page', placement: 'page' }), 400)
  assert.equal(page.body, '')
  assert.equal(page.updatedByName, 'Reader')
  const subpages = await documentService.listSubpages(reader, f.wid, page.id)
  assert.deepEqual(subpages.documents.map(candidate => [candidate.id, candidate.parentDocumentId, candidate.pagePlacement]), [[page.id, document.id, 'page'], [nestedPage.id, page.id, 'subpage']])
  assert.equal(subpages.total, 2)
  assert.equal(subpages.truncated, false)
  const movedRoot = await documentService.updateDocument(f.owner, f.wid, document.id, { parentId: f.project.id, expectedUpdatedAt: document.updatedAt })
  assert.equal(movedRoot.parentId, f.project.id)
  assert.deepEqual((await documentService.listSubpages(reader, f.wid, page.id)).documents.map(candidate => candidate.parentId), [f.project.id, f.project.id])
  await denied(() => documentService.updateDocument(f.owner, f.wid, page.id, { parentId: f.folder.id, expectedUpdatedAt: page.updatedAt }), 400)
  assert.equal((await documentService.listDocuments(reader, f.wid)).find(candidate => candidate.id === page.id)?.parentDocumentId, document.id)
  assert.deepEqual((await service.getWorkspace(taskReader, f.wid)).documents, [])
  assert.equal((await documentService.getDocument(reader, f.wid, document.id)).body, 'Read this guide')
  await denied(() => documentService.updateDocument(reader, f.wid, document.id, { body: 'No', expectedUpdatedAt: document.updatedAt }))
  await denied(() => documentService.updateDocument(writer, f.wid, document.id, { body: 'No read access', expectedUpdatedAt: document.updatedAt }))
  await denied(() => service.deleteNode(f.owner, f.wid, f.folder.id), 409)
  const task = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Page' })
  await documentService.linkPage(f.owner, f.wid, document.id, { itemId: task.id })
  await denied(() => documentService.unlinkPage(documentEditor, f.wid, document.id, task.id))
  await denied(() => documentService.linkPage(f.owner, f.wid, document.id, { itemId: task.id }), 409)
  const child = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Child page', parentId: task.id })
  await denied(() => service.updateItem(f.owner, f.wid, task.id, { parentId: child.id }), 409)
  const pages = await documentService.listPages(f.owner, f.wid, document.id)
  assert.deepEqual(pages.items.map(item => item.id), [task.id, child.id])
  await service.bulkItems(f.owner, f.wid, { action: 'archive', items: [task, child].map(item => ({ id: item.id, expectedUpdatedAt: item.updatedAt })) })
  assert.deepEqual(await documentService.listPages(f.owner, f.wid, document.id), { items: [], total: 0, truncated: false })
  assert.deepEqual(await documentService.deleteDocument(f.owner, f.wid, document.id), { success: true, unlinkedPages: 1, deletedSubpages: 2 })
  await denied(() => documentService.getDocument(f.owner, f.wid, nestedPage.id), 404)
  assert.ok(await service.getItem(f.owner, f.wid, task.id))
})

test('document and task range comments reject stale text and safely reattach or orphan', async () => {
  const f = await fixture()
  const document = await documentService.createDocument(f.owner, f.wid, { title: 'Review', body: 'Alpha selected Omega' })
  const anchor = { revision: 1, start: 6, end: 14, exact: 'selected', prefix: 'Alpha ', suffix: ' Omega' }
  const comment = await documentService.createComment(f.owner, f.wid, document.id, { body: 'Revise this', anchor })
  assert.equal(comment.anchor?.state, 'attached')
  assert.equal('anchorRevision' in comment, false)
  await denied(() => documentService.createComment(f.owner, f.wid, document.id, { body: 'Stale', anchor: { ...anchor, revision: 2 } }), 409)
  const moved = await documentService.updateDocument(f.owner, f.wid, document.id, { body: 'Before Alpha selected Omega', expectedUpdatedAt: document.updatedAt })
  assert.equal((await documentService.listComments(f.owner, f.wid, document.id))[0].anchor?.start, 13)
  await documentService.updateDocument(f.owner, f.wid, document.id, { body: 'Selection removed', expectedUpdatedAt: moved.updatedAt })
  assert.equal((await documentService.listComments(f.owner, f.wid, document.id))[0].anchor?.state, 'orphaned')

  const task = await service.createItem(f.owner, f.wid, { nodeId: f.list.id, title: 'Task', description: 'One target Two' })
  const taskComment = await service.createComment(f.owner, f.wid, task.id, { body: 'Task note', anchor: { revision: 1, start: 4, end: 10, exact: 'target', prefix: 'One ', suffix: ' Two' } })
  assert.equal(taskComment.anchor?.exact, 'target')
  assert.equal('anchorRevision' in taskComment, false)
  const updated = await service.updateItem(f.owner, f.wid, task.id, { description: 'Zero One target Two' })
  assert.equal(updated.bodyRevision, 2)
  assert.equal((await service.listComments(f.owner, f.wid, task.id))[0].anchor?.start, 9)
})

test('document comments retain replies, reactions, tombstones, and workspace scoping', async () => {
  const f = await fixture()
  const other = await fixture()
  const document = await documentService.createDocument(f.owner, f.wid, { title: 'Discussion' })
  const root = await documentService.createComment(f.owner, f.wid, document.id, { body: 'Root' })
  const reply = await documentService.createComment(f.owner, f.wid, document.id, { body: 'Reply', parentId: root.id })
  assert.equal(reply.parentId, root.id)
  assert.deepEqual(await documentService.updateCommentReaction(f.owner, f.wid, document.id, reply.id, { emoji: '👍', active: true }), { emoji: '👍', active: true, count: 1 })
  await documentService.deleteComment(f.owner, f.wid, document.id, root.id)
  assert.equal((await documentService.listComments(f.owner, f.wid, document.id))[0].body, '')
  await denied(() => documentService.getDocument(other.owner, other.wid, document.id), 404)
})
