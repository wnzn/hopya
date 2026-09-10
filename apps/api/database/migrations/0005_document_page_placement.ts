import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    const postgres = this.db.dialect.name === 'postgres'
    this.schema.alterTable('document_subpages', (table) => {
      table.text('placement').notNullable().defaultTo('subpage')
    })
    this.defer(async (db) => {
      await db.rawQuery(postgres ? `UPDATE document_subpages AS page SET placement='page' WHERE NOT EXISTS (
        SELECT 1 FROM document_subpages AS parent WHERE parent."workspaceId"=page."workspaceId" AND parent."pageDocumentId"=page."documentId"
      )` : `UPDATE document_subpages AS page SET placement='page' WHERE NOT EXISTS (
        SELECT 1 FROM document_subpages AS parent WHERE parent.workspaceId=page.workspaceId AND parent.pageDocumentId=page.documentId
      )`)
    })
  }

  async down() {
    this.schema.alterTable('document_subpages', (table) => table.dropColumn('placement'))
  }
}
