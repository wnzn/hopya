import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-document-migration-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { default: lucidDb } = await import('@adonisjs/lucid/services/db')
const { default: DocumentAttributionMigration } = await import('../database/migrations/0003_document_attribution.js')
const { default: RestoreDocumentSubpagesMigration } = await import('../database/migrations/0004_restore_document_subpages.js')
const { default: DocumentPagePlacementMigration } = await import('../database/migrations/0005_document_page_placement.js')
const { default: NodeAppearanceMigration } = await import('../database/migrations/0006_node_appearance.js')
const { default: ResourceAppearanceMigration } = await import('../database/migrations/0009_resource_appearance.js')
const { db, service } = await import('../app/core.js')
const { documentService } = await import('../app/documents.js')
const { tableService } = await import('../app/tables.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

test('additive upgrades preserve referenced contents and convert legacy node appearance', async () => {
  const owner = randomUUID()
  await db.run('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)', owner, 'Owner', `${owner}@example.test`, new Date().toISOString())
  const workspace = await service.createWorkspace(owner, { name: 'Migration safety' })
  const project = await service.createNode(owner, workspace.id, { name: 'Project', kind: 'project' })
  const list = await service.createNode(owner, workspace.id, { name: 'List', kind: 'list', parentId: project.id })
  const task = await service.createItem(owner, workspace.id, { nodeId: list.id, title: 'Task page' })
  const document = await documentService.createDocument(owner, workspace.id, { title: 'Document' })
  const subpage = await documentService.createSubpage(owner, workspace.id, document.id, { title: 'Subpage' })
  await documentService.linkPage(owner, workspace.id, document.id, { itemId: task.id })
  const comment = await documentService.createComment(owner, workspace.id, document.id, { body: 'Keep me' })
  await documentService.updateCommentReaction(owner, workspace.id, document.id, comment.id, { emoji: '👍', active: true })
  const table = await tableService.createTable(owner, workspace.id, { name: 'Keep this Table', parentId: project.id })
  const column = await tableService.createColumn(owner, workspace.id, table.id, { name: 'Value', type: 'text' })
  const record = await tableService.createRecord(owner, workspace.id, table.id, { values: { [column.id]: 'Keep this record' } })

  const client = lucidDb.connection()
  for (const resource of ['documents', 'tables']) {
    await client.rawQuery(`ALTER TABLE "${resource}" DROP COLUMN "color"`)
    await client.rawQuery(`ALTER TABLE "${resource}" DROP COLUMN "icon"`)
  }
  await new ResourceAppearanceMigration(client, 'database/migrations/0009_resource_appearance').execUp()
  assert.equal((await documentService.getDocument(owner, workspace.id, document.id)).icon, null)
  assert.equal((await tableService.getTable(owner, workspace.id, table.id)).color, null)
  assert.deepEqual(await tableService.getRecord(owner, workspace.id, table.id, record.id), record)
  assert.deepEqual((await tableService.listColumns(owner, workspace.id, table.id)).map(value => value.id), [column.id])
  await client.rawQuery('ALTER TABLE documents DROP COLUMN "updatedById"')
  await client.rawQuery('ALTER TABLE documents DROP COLUMN "createdById"')
  await new DocumentAttributionMigration(client, 'database/migrations/0003_document_attribution').execUp()

  assert.equal(Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM document_subpages WHERE workspaceId=?', workspace.id))!.count), 1)
  assert.equal(Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM document_pages WHERE workspaceId=?', workspace.id))!.count), 1)
  assert.equal(Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM document_comments WHERE workspaceId=?', workspace.id))!.count), 1)
  assert.equal(Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM document_comment_reactions WHERE workspaceId=?', workspace.id))!.count), 1)
  assert.equal((await db.get<{ createdById: string; updatedById: string }>('SELECT createdById,updatedById FROM documents WHERE id=?', document.id))!.createdById, owner)
  assert.equal((await db.get<{ createdById: string }>('SELECT createdById FROM documents WHERE id=?', subpage.id))!.createdById, owner)

  await client.rawQuery('ALTER TABLE document_subpages DROP COLUMN placement')
  await db.run('DELETE FROM document_subpages WHERE workspaceId=?', workspace.id)
  await new RestoreDocumentSubpagesMigration(client, 'database/migrations/0004_restore_document_subpages').execUp()
  assert.equal(Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM document_subpages WHERE workspaceId=?', workspace.id))!.count), 1)
  await new DocumentPagePlacementMigration(client, 'database/migrations/0005_document_page_placement').execUp()
  assert.equal((await db.get<{ placement: string }>('SELECT placement FROM document_subpages WHERE pageDocumentId=?', subpage.id))!.placement, 'page')

  await db.run("UPDATE nodes SET icon='bookmark',color='violet' WHERE workspaceId=? AND id=?", workspace.id, project.id)
  await client.rawQuery('ALTER TABLE nodes DROP COLUMN "appearanceColor"')
  await client.rawQuery('ALTER TABLE nodes DROP COLUMN "appearanceIcon"')
  await new NodeAppearanceMigration(client, 'database/migrations/0006_node_appearance').execUp()
  const migrated = (await service.listNodes(owner, workspace.id)).find((node) => node.id === project.id)!
  assert.equal(migrated.name, 'Project')
  assert.equal(migrated.icon, 'bookmark')
  assert.equal(migrated.color, '#7652a8')
  assert.equal((await service.getItem(owner, workspace.id, task.id)).title, 'Task page')
  const cleared = await service.updateNode(owner, workspace.id, project.id, { icon: null, color: null })
  assert.equal(cleared.icon, null)
  assert.equal(cleared.color, null)
  assert.deepEqual(await db.get('SELECT icon,color FROM nodes WHERE id=?', project.id), { icon: 'bookmark', color: 'violet' })
})
