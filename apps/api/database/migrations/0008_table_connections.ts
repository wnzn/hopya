import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('table_connections', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('dialect').notNullable()
      table.text('encrypted').notNullable()
      table.text('createdAt').notNullable()
      table.unique(['workspaceId', 'id'])
    })
    this.schema.createTable('table_links', (table) => {
      table.text('tableId').primary()
      table.text('workspaceId').notNullable()
      table.text('connectionId').notNullable()
      table.text('sourceSchema').notNullable()
      table.text('sourceTable').notNullable()
      table.text('schemaHash').notNullable()
      table.foreign(['workspaceId', 'tableId']).references(['workspaceId', 'id']).inTable('tables').onDelete('CASCADE')
      table.foreign(['workspaceId', 'connectionId']).references(['workspaceId', 'id']).inTable('table_connections').onDelete('CASCADE')
    })
  }

  async down() {
    this.schema.dropTable('table_links')
    this.schema.dropTable('table_connections')
  }
}
