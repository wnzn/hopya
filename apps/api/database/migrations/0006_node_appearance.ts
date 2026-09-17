import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    const postgres = this.db.dialect.name === 'postgres'
    if (postgres) {
      this.schema.alterTable('nodes', (table) => {
        table.text('appearanceIcon').nullable()
        table.text('appearanceColor').nullable()
      })
    } else {
      // Native additions avoid rebuilding the referenced nodes table and cascading its contents.
      this.defer(async (db) => {
        await db.rawQuery('ALTER TABLE nodes ADD COLUMN "appearanceIcon" TEXT')
        await db.rawQuery('ALTER TABLE nodes ADD COLUMN "appearanceColor" TEXT')
      })
    }
    this.defer(async (db) => {
      await db.rawQuery(postgres ? `UPDATE nodes SET
        "appearanceIcon"=icon,
        "appearanceColor"=CASE color
          WHEN 'slate' THEN '#64748b' WHEN 'orange' THEN '#c45d0a'
          WHEN 'amber' THEN '#9a7411' WHEN 'green' THEN '#4d7a47'
          WHEN 'teal' THEN '#17776f' WHEN 'blue' THEN '#2563a6'
          WHEN 'violet' THEN '#7652a8' WHEN 'rose' THEN '#a5415b'
          ELSE NULL END` : `UPDATE nodes SET
        appearanceIcon=icon,
        appearanceColor=CASE color
          WHEN 'slate' THEN '#64748b' WHEN 'orange' THEN '#c45d0a'
          WHEN 'amber' THEN '#9a7411' WHEN 'green' THEN '#4d7a47'
          WHEN 'teal' THEN '#17776f' WHEN 'blue' THEN '#2563a6'
          WHEN 'violet' THEN '#7652a8' WHEN 'rose' THEN '#a5415b'
          ELSE NULL END`)
    })
  }

  async down() {
    if (this.db.dialect.name === 'postgres') {
      this.schema.alterTable('nodes', (table) => {
        table.dropColumn('appearanceColor')
        table.dropColumn('appearanceIcon')
      })
    } else {
      this.defer(async (db) => {
        await db.rawQuery('ALTER TABLE nodes DROP COLUMN "appearanceColor"')
        await db.rawQuery('ALTER TABLE nodes DROP COLUMN "appearanceIcon"')
      })
    }
  }
}
