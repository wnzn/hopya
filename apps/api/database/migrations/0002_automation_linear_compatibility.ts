import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      if (['sqlite3', 'better-sqlite3', 'libsql'].includes(db.dialect.name)) {
        // Rebuild without disabling foreign keys. Dropping the parent cascades
        // only its credential bindings, which are copied and restored atomically.
        await db.rawQuery('CREATE TEMP TABLE automation_bindings_backup AS SELECT * FROM automation_version_credentials')
        await db.schema.createTable('automation_versions_repaired', (table) => {
          table.text('workspaceId').notNullable()
          table.text('automationId').notNullable()
          table.integer('version').notNullable()
          table.text('format').notNullable()
          table.text('graph').notNullable()
          table.text('publisherId').nullable()
          table.text('publishedAt').notNullable()
          table.check("?? IN ('linear','graph')", ['format'])
          table.check('?? >= 1', ['version'])
          table.check("?? = 'linear' OR length(??) <= 262144", ['format', 'graph'], 'automation_versions_graph_size_check')
          table.primary(['workspaceId', 'automationId', 'version'])
          table.foreign(['workspaceId', 'automationId'], 'automation_versions_automation_fk').references(['workspaceId', 'id']).inTable('automations').onDelete('CASCADE')
          table.foreign(['publisherId'], 'automation_versions_publisher_fk').references(['id']).inTable('users').onDelete('SET NULL')
        })
        await db.rawQuery('INSERT INTO automation_versions_repaired SELECT * FROM automation_versions')
        await db.schema.dropTable('automation_versions')
        await db.schema.renameTable('automation_versions_repaired', 'automation_versions')
        await db.rawQuery('INSERT INTO automation_version_credentials SELECT * FROM automation_bindings_backup')
        await db.rawQuery('DROP TABLE automation_bindings_backup')
      } else {
        await db.rawQuery('ALTER TABLE automation_versions DROP CONSTRAINT IF EXISTS automation_versions_graph_check')
        await db.rawQuery('ALTER TABLE automation_versions DROP CONSTRAINT IF EXISTS automation_versions_graph_size_check')
        await db.rawQuery("ALTER TABLE automation_versions ADD CONSTRAINT automation_versions_graph_size_check CHECK (format = 'linear' OR length(graph) <= 262144)")
      }

      // Repair only derived linear representations, never immutable graph
      // publications or user-edited drafts. Original step configs stay untouched.
      let cursor: { workspaceId: string; automationId: string; version: number } | undefined
      while (true) {
        const result = await db.rawQuery(`SELECT "workspaceId","automationId",version,graph FROM automation_versions WHERE format='linear'
          ${cursor ? 'AND ("workspaceId","automationId",version) > (?,?,?)' : ''}
          ORDER BY "workspaceId","automationId",version LIMIT 1`, cursor ? [cursor.workspaceId, cursor.automationId, cursor.version] : [])
        const row = (Array.isArray(result) ? result : result.rows)[0] as { workspaceId: string; automationId: string; version: number; graph: string } | undefined
        if (!row) break
        cursor = row
        const graph = JSON.parse(row.graph) as { nodes: { id: string; type: string; config: Record<string, unknown> }[] }
        const trigger = graph.nodes.find((node) => node.type === 'trigger')
        if (!trigger) continue
        let changed = false
        for (const node of graph.nodes) {
          if (node.type !== 'http' || typeof node.config.body !== 'string' || !node.config.body.includes('{{event}}')) continue
          node.config.body = node.config.body.replaceAll('{{event}}', `{{nodes.${trigger.id}.output.event}}`)
          changed = true
        }
        if (changed) await db.rawQuery('UPDATE automation_versions SET graph=? WHERE "workspaceId"=? AND "automationId"=? AND version=?', [JSON.stringify(graph), row.workspaceId, row.automationId, row.version])
      }
    })
  }

  async down() {
    // This compatibility repair is intentionally retained on rollback: restoring
    // the old limit could reject preserved linear data, and templates are lossy.
  }
}
