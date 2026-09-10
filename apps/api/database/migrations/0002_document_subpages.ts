import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('document_subpages', (table) => {
      table.text('workspaceId').notNullable()
      table.text('documentId').notNullable()
      table.text('pageDocumentId').notNullable()
      table.integer('position').notNullable().defaultTo(0)
      table.text('createdAt').notNullable()
      table.primary(['workspaceId', 'documentId', 'pageDocumentId'])
      table.unique(['workspaceId', 'pageDocumentId'])
      table.index(['workspaceId', 'documentId', 'position', 'createdAt', 'pageDocumentId'], 'document_subpages_order')
      table.foreign(['workspaceId', 'documentId'], 'document_subpages_parent_fk').references(['workspaceId', 'id']).inTable('documents').onDelete('CASCADE')
      table.foreign(['workspaceId', 'pageDocumentId'], 'document_subpages_page_fk').references(['workspaceId', 'id']).inTable('documents').onDelete('CASCADE')
    })
  }

  async down() {
    this.schema.dropTable('document_subpages')
  }
}
