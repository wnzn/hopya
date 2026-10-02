import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    for (const resource of ['documents', 'tables']) {
      if (this.db.dialect.name === 'postgres') {
        this.schema.alterTable(resource, (table) => {
          table.text('icon').nullable()
          table.text('color').nullable()
        })
      } else {
        // Native additions preserve referenced bodies, pages, comments, columns and records.
        this.defer(async (db) => {
          await db.rawQuery(`ALTER TABLE "${resource}" ADD COLUMN "icon" TEXT`)
          await db.rawQuery(`ALTER TABLE "${resource}" ADD COLUMN "color" TEXT`)
        })
      }
    }
  }

  async down() {
    for (const resource of ['documents', 'tables']) {
      if (this.db.dialect.name === 'postgres') {
        this.schema.alterTable(resource, (table) => {
          table.dropColumn('color')
          table.dropColumn('icon')
        })
      } else {
        this.defer(async (db) => {
          await db.rawQuery(`ALTER TABLE "${resource}" DROP COLUMN "color"`)
          await db.rawQuery(`ALTER TABLE "${resource}" DROP COLUMN "icon"`)
        })
      }
    }
  }
}
