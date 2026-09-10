import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    const postgres = this.db.dialect.name === 'postgres'
    if (postgres) {
      this.schema.alterTable('documents', (table) => {
        table.text('createdById').nullable().references('id').inTable('users').onDelete('SET NULL')
        table.text('updatedById').nullable().references('id').inTable('users').onDelete('SET NULL')
      })
    } else {
      // Native ADD COLUMN avoids rebuilding the referenced parent table and cascading its children.
      this.defer(async (db) => {
        await db.rawQuery('ALTER TABLE documents ADD COLUMN "createdById" TEXT REFERENCES users(id) ON DELETE SET NULL')
        await db.rawQuery('ALTER TABLE documents ADD COLUMN "updatedById" TEXT REFERENCES users(id) ON DELETE SET NULL')
      })
    }
    this.defer(async (db) => {
      await db.rawQuery(postgres ? `UPDATE documents AS d SET
        "createdById"=(SELECT "actorId" FROM audit_logs WHERE "workspaceId"=d."workspaceId" AND "resourceId"=d.id AND action IN ('document.create','document.page.create') ORDER BY "createdAt",id LIMIT 1),
        "updatedById"=(SELECT "actorId" FROM audit_logs WHERE "workspaceId"=d."workspaceId" AND "resourceId"=d.id AND action IN ('document.create','document.page.create','document.update') ORDER BY "createdAt" DESC,id DESC LIMIT 1)` : `UPDATE documents AS d SET
        createdById=(SELECT actorId FROM audit_logs WHERE workspaceId=d.workspaceId AND resourceId=d.id AND action IN ('document.create','document.page.create') ORDER BY createdAt,id LIMIT 1),
        updatedById=(SELECT actorId FROM audit_logs WHERE workspaceId=d.workspaceId AND resourceId=d.id AND action IN ('document.create','document.page.create','document.update') ORDER BY createdAt DESC,id DESC LIMIT 1)`)
    })
  }

  async down() {
    if (this.db.dialect.name === 'postgres') {
      this.schema.alterTable('documents', (table) => {
        table.dropColumn('updatedById')
        table.dropColumn('createdById')
      })
    } else {
      this.defer(async (db) => {
        await db.rawQuery('ALTER TABLE documents DROP COLUMN "updatedById"')
        await db.rawQuery('ALTER TABLE documents DROP COLUMN "createdById"')
      })
    }
  }
}
