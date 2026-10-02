import { BaseSchema } from '@adonisjs/lucid/schema'

const tablePermissions = ['tables:read', 'tables:write', 'tables:delete']

const resultRows = <Row>(result: unknown): Row[] => Array.isArray(result)
  ? result as Row[]
  : (result as { rows?: Row[] }).rows ?? []

export default class extends BaseSchema {
  async up() {
    const pg = this.db.dialect.name === 'postgres'

    this.schema.createTable('tables', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('parentId').nullable()
      table.text('name').notNullable()
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'parentId', 'createdAt', 'id'], 'tables_workspace_parent')
      table.foreign(['workspaceId', 'parentId'], 'tables_parent_fk').references(['workspaceId', 'id']).inTable('nodes').onDelete('CASCADE')
      table.check(pg ? 'length(trim("name")) BETWEEN 1 AND 120' : 'length(trim(name)) BETWEEN 1 AND 120', [], 'tables_name_check')
    })

    this.schema.createTable('table_columns', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('tableId').notNullable()
      table.text('name').notNullable()
      table.text('type').notNullable()
      table.text('options').notNullable().defaultTo('[]')
      table.integer('position').notNullable()
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.unique(['workspaceId', 'tableId', 'id'])
      table.index(['workspaceId', 'tableId', 'position', 'id'], 'table_columns_order')
      table.foreign(['workspaceId', 'tableId'], 'table_columns_table_fk').references(['workspaceId', 'id']).inTable('tables').onDelete('CASCADE')
      table.check(pg ? 'length(trim("name")) BETWEEN 1 AND 120' : 'length(trim(name)) BETWEEN 1 AND 120', [], 'table_columns_name_check')
      table.check(pg ? '"type" IN (\'text\',\'number\',\'date\',\'datetime\',\'checkbox\',\'select\')' : "type IN ('text','number','date','datetime','checkbox','select')", [], 'table_columns_type_check')
      table.check(pg ? '"position" >= 0' : 'position >= 0', [], 'table_columns_position_check')
      table.check(pg
        ? 'jsonb_typeof("options"::jsonb) = \'array\' AND (("type" = \'select\' AND jsonb_array_length("options"::jsonb) BETWEEN 1 AND 100) OR ("type" <> \'select\' AND jsonb_array_length("options"::jsonb) = 0))'
        : "json_valid(options) AND json_type(options) = 'array' AND ((type = 'select' AND json_array_length(options) BETWEEN 1 AND 100) OR (type <> 'select' AND json_array_length(options) = 0))",
      [], 'table_columns_options_check')
    })

    this.schema.createTable('table_records', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('tableId').notNullable()
      table.text('data').notNullable().defaultTo('{}')
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.unique(['workspaceId', 'tableId', 'id'])
      table.index(['workspaceId', 'tableId', 'createdAt', 'id'], 'table_records_order')
      table.foreign(['workspaceId', 'tableId'], 'table_records_table_fk').references(['workspaceId', 'id']).inTable('tables').onDelete('CASCADE')
      table.check(pg
        ? 'jsonb_typeof("data"::jsonb) = \'object\' AND octet_length("data") <= 307200'
        : "json_valid(data) AND json_type(data) = 'object' AND length(CAST(data AS BLOB)) <= 262144",
      [], 'table_records_data_check')
    })

    this.defer(async (database) => {
      const roles = resultRows<{ id: string; permissions: string; isOwner: number }>(await database.rawQuery('SELECT id,permissions,"isOwner" FROM roles'))
      for (const role of roles) {
        const permissions = JSON.parse(role.permissions) as string[]
        const additions = [
          ...(role.isOwner || permissions.includes('items:read') ? ['tables:read'] : []),
          ...(role.isOwner || permissions.includes('items:write') ? ['tables:write'] : []),
          ...(role.isOwner || permissions.includes('items:delete') ? ['tables:delete'] : []),
        ]
        const migrated = [...new Set([...permissions, ...additions])]
        await database.rawQuery('UPDATE roles SET permissions=? WHERE id=?', [JSON.stringify(migrated), role.id])
      }
    })
  }

  async down() {
    this.schema.dropTable('table_records')
    this.schema.dropTable('table_columns')
    this.schema.dropTable('tables')
    this.defer(async (database) => {
      const roles = resultRows<{ id: string; permissions: string }>(await database.rawQuery('SELECT id,permissions FROM roles'))
      for (const role of roles) {
        const permissions = (JSON.parse(role.permissions) as string[]).filter((permission) => !tablePermissions.includes(permission))
        await database.rawQuery('UPDATE roles SET permissions=? WHERE id=?', [JSON.stringify(permissions), role.id])
      }
    })
  }
}
