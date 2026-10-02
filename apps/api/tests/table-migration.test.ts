import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-table-migration-'))
process.env.DATA_DIR = directory
await migrateDatabase()
const { default: lucidDb } = await import('@adonisjs/lucid/services/db')
const { default: TablesMigration } = await import('../database/migrations/0007_tables.js')
const { db, service } = await import('../app/core.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

test('table migration preserves roles and grants permissions from existing task access', async () => {
  const owner = randomUUID()
  await db.run('INSERT INTO users(id,name,email,createdAt) VALUES (?,?,?,?)', owner, 'Owner', `${owner}@example.test`, new Date().toISOString())
  const workspace = await service.createWorkspace(owner, { name: 'Upgrade roles' })
  const readWrite = await service.createRole(owner, workspace.id, { name: 'Editors', permissions: ['items:read', 'items:write'] })
  const documentsOnly = await service.createRole(owner, workspace.id, { name: 'Documents', permissions: ['documents:read'] })
  const beforeMemberships = Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM memberships WHERE workspaceId=?', workspace.id))!.count)

  const existingRoles = await db.all<{ id: string; permissions: string }>('SELECT id,permissions FROM roles WHERE workspaceId=?', workspace.id)
  for (const role of existingRoles) {
    const permissions = (JSON.parse(role.permissions) as string[]).filter((permission) => !permission.startsWith('tables:'))
    await db.run('UPDATE roles SET permissions=? WHERE id=?', JSON.stringify(permissions), role.id)
  }
  await db.run('DROP TABLE table_links')
  await db.run('DROP TABLE table_connections')
  await db.run('DROP TABLE table_records')
  await db.run('DROP TABLE table_columns')
  await db.run('DROP TABLE tables')

  const client = lucidDb.connection()
  await new TablesMigration(client, 'database/migrations/0007_tables').execUp()

  const roles = await db.all<{ id: string; permissions: string; isOwner: number }>('SELECT id,permissions,isOwner FROM roles WHERE workspaceId=?', workspace.id)
  const ownerPermissions = JSON.parse(roles.find((role) => Boolean(role.isOwner))!.permissions) as string[]
  const editorPermissions = JSON.parse(roles.find((role) => role.id === readWrite.id)!.permissions) as string[]
  const documentPermissions = JSON.parse(roles.find((role) => role.id === documentsOnly.id)!.permissions) as string[]
  assert.ok(['tables:read', 'tables:write', 'tables:delete'].every((permission) => ownerPermissions.includes(permission)))
  assert.ok(editorPermissions.includes('tables:read'))
  assert.ok(editorPermissions.includes('tables:write'))
  assert.equal(editorPermissions.includes('tables:delete'), false)
  assert.equal(documentPermissions.some((permission) => permission.startsWith('tables:')), false)
  assert.equal(new Set(ownerPermissions).size, ownerPermissions.length)
  assert.equal(Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM memberships WHERE workspaceId=?', workspace.id))!.count), beforeMemberships)
})
