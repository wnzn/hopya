import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    const postgres = this.db.dialect.name === 'postgres'
    this.schema.createTable('profile_photos', (table) => {
      table.text('userId').primary().references('id').inTable('users').onDelete('CASCADE')
      table.text('revision').notNullable()
      table.text('contentType').notNullable()
      table.binary('bytes').notNullable()
      table.integer('size').notNullable()
      table.text('updatedAt').notNullable()
      table.check('"size" > 0 AND "size" <= 524288')
      table.check(`${postgres ? 'octet_length' : 'length'}("bytes") = "size"`)
      table.check(`"contentType" IN ('image/png','image/jpeg','image/webp')`)
    })
  }

  async down() { this.schema.dropTable('profile_photos') }
}
