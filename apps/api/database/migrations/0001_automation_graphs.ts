import { BaseSchema } from '@adonisjs/lucid/schema'

// Keep data conversion self-contained so later runtime validator changes cannot
// alter the meaning of an already shipped migration.
function migrateLegacyConfig(config: unknown, nodeIds: string[], types: string[], triggerId: string): Record<string, unknown> {
  const translate = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/\{\{steps\.(\d+)\.output\}\}/g, (original, raw: string) => {
      const index = Number(raw) - 1, id = nodeIds[index]
      if (!id) return original
      const field = types[index] === 'log' ? 'message' : types[index] === 'email' ? 'messageId' : 'body'
      return `{{nodes.${id}.output.${field}}}`
    })
    if (Array.isArray(value)) return value.map(translate)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, translate(entry)]))
    return value
  }
  const result = translate(config) as Record<string, unknown>
  if (typeof result.body === 'string') result.body = result.body.replaceAll('{{event}}', `{{nodes.${triggerId}.output.event}}`)
  if (result.headers && typeof result.headers === 'object' && Object.keys(result.headers).length) {
    result.headers = {}
    result.legacyHeaderMigrationRequired = true
  }
  return result
}

export function legacyAutomationGraph(event: string, version: number, steps: { id: string; position: number; type: string; config: string }[]) {
  const triggerId = `trigger-${version}`
  const ids = steps.map((step) => step.id), types = steps.map((step) => step.type)
  return {
    nodes: [
      { id: triggerId, type: 'trigger', position: { x: 0, y: 0 }, config: { event } },
      ...steps.map((step) => ({ id: step.id, type: step.type, position: { x: step.position * 240, y: 0 }, config: migrateLegacyConfig(JSON.parse(step.config), ids, types, triggerId) })),
    ],
    edges: steps.map((step, index) => ({ id: `edge-${version}-${index + 1}`, source: index === 0 ? triggerId : steps[index - 1]!.id, target: step.id })),
  }
}

export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('webhooks', (table) => {
      // Existing rows retain the historical SHA-256 construction. New rows use HMAC.
      table.integer('signingVersion').notNullable().defaultTo(1)
    })
    this.schema.alterTable('automation_runs', (table) => {
      table.text('leaseId').nullable()
      table.text('heartbeatAt').nullable()
      table.integer('attempt').notNullable().defaultTo(0)
      table.text('causation').notNullable().defaultTo('{}')
    })

    this.schema.createTable('automation_versions', (table) => {
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
    this.schema.createTable('automation_drafts', (table) => {
      table.text('workspaceId').notNullable()
      table.text('automationId').notNullable()
      table.integer('revision').notNullable().defaultTo(0)
      table.text('graph').notNullable()
      table.text('updatedBy').nullable()
      table.text('updatedAt').notNullable()
      table.check('?? >= 0', ['revision'])
      table.check('length(??) <= 262144', ['graph'])
      table.primary(['workspaceId', 'automationId'])
      table.foreign(['workspaceId', 'automationId'], 'automation_drafts_automation_fk').references(['workspaceId', 'id']).inTable('automations').onDelete('CASCADE')
      table.foreign(['updatedBy'], 'automation_drafts_user_fk').references(['id']).inTable('users').onDelete('SET NULL')
    })
    this.schema.createTable('automation_node_runs', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('runId').notNullable()
      table.text('nodeId').notNullable()
      table.text('type').notNullable()
      table.text('status').notNullable()
      table.integer('attempt').notNullable().defaultTo(0)
      table.text('output').notNullable().defaultTo('')
      table.text('log').notNullable().defaultTo('')
      table.text('startedAt').nullable()
      table.text('completedAt').nullable()
      table.check("?? IN ('trigger','http','webhook','email','log','update_item','condition','switch')", ['type'])
      table.check("?? IN ('pending','running','delivered','failed','skipped')", ['status'])
      table.check('?? >= 0', ['attempt'])
      table.check('length(??) <= 8192', ['output'])
      table.check('length(??) <= 2000', ['log'])
      table.unique(['runId', 'nodeId'])
      table.index(['workspaceId', 'runId'], 'automation_node_runs_run')
      table.foreign(['workspaceId', 'runId'], 'automation_node_runs_run_fk').references(['workspaceId', 'id']).inTable('automation_runs').onDelete('CASCADE')
    })

    this.schema.createTable('automation_credentials', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('type').notNullable()
      table.text('origin').notNullable()
      table.text('pathPrefix').nullable()
      table.integer('version').notNullable().defaultTo(1)
      table.text('status').notNullable().defaultTo('active')
      table.text('createdBy').nullable()
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.check("?? IN ('bearer','api_key','basic','custom_headers','oauth2')", ['type'])
      table.check("?? IN ('active','revoked')", ['status'])
      table.check('?? >= 1', ['version'])
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'status', 'createdAt'], 'automation_credentials_workspace')
      table.foreign(['createdBy'], 'automation_credentials_creator_fk').references(['id']).inTable('users').onDelete('SET NULL')
    })
    this.schema.createTable('automation_credential_versions', (table) => {
      table.text('workspaceId').notNullable()
      table.text('credentialId').notNullable()
      table.integer('version').notNullable()
      table.text('keyId').notNullable()
      table.text('encrypted').notNullable()
      table.text('createdAt').notNullable()
      table.check('?? >= 1', ['version'])
      table.primary(['workspaceId', 'credentialId', 'version'])
      table.foreign(['workspaceId', 'credentialId'], 'automation_credential_versions_credential_fk').references(['workspaceId', 'id']).inTable('automation_credentials').onDelete('CASCADE')
    })
    this.schema.createTable('automation_version_credentials', (table) => {
      table.text('workspaceId').notNullable()
      table.text('automationId').notNullable()
      table.integer('automationVersion').notNullable()
      table.text('nodeId').notNullable()
      table.text('credentialId').notNullable()
      table.integer('credentialVersion').notNullable()
      table.primary(['workspaceId', 'automationId', 'automationVersion', 'nodeId'])
      table.foreign(['workspaceId', 'automationId', 'automationVersion'], 'automation_version_credentials_version_fk').references(['workspaceId', 'automationId', 'version']).inTable('automation_versions').onDelete('CASCADE')
      table.foreign(['workspaceId', 'credentialId', 'credentialVersion'], 'automation_version_credentials_credential_fk').references(['workspaceId', 'credentialId', 'version']).inTable('automation_credential_versions')
    })
    this.schema.createTable('automation_oauth_flows', (table) => {
      table.text('stateHash').primary()
      table.text('workspaceId').notNullable()
      table.text('credentialId').notNullable()
      table.integer('credentialVersion').notNullable()
      table.text('verifierKeyId').notNullable()
      table.text('verifierEncrypted').notNullable()
      table.text('redirectUri').notNullable()
      table.text('expiresAt').notNullable()
      table.text('createdBy').notNullable()
      table.check('?? >= 1', ['credentialVersion'])
      table.index(['expiresAt'], 'automation_oauth_flows_expiry')
      table.foreign(['workspaceId', 'credentialId'], 'automation_oauth_flows_credential_fk').references(['workspaceId', 'id']).inTable('automation_credentials').onDelete('CASCADE')
      table.foreign(['createdBy'], 'automation_oauth_flows_user_fk').references(['id']).inTable('users').onDelete('CASCADE')
    })

    this.defer(async (db) => {
      const rows = <T>(result: unknown): T[] => Array.isArray(result) ? result as T[] : (result as { rows?: T[] }).rows ?? []
      const roles = await db.rawQuery('SELECT id,permissions FROM roles WHERE "permissions" LIKE ?', ['%workspace:manage%'])
      for (const role of rows<{ id: string; permissions: string }>(roles)) {
        const permissions = JSON.parse(role.permissions) as string[]
        for (const permission of ['automations:manage', 'credentials:manage']) if (!permissions.includes(permission)) permissions.push(permission)
        await db.rawQuery('UPDATE roles SET permissions=? WHERE id=?', [JSON.stringify(permissions), role.id])
      }
      const automations = await db.rawQuery('SELECT id,"workspaceId",event,version,"createdAt" FROM automations')
      for (const automation of rows<{ id: string; workspaceId: string; event: string; version: number; createdAt: string }>(automations)) {
        const owner = await db.rawQuery('SELECT m."userId" FROM memberships m JOIN roles r ON r.id=m."roleId" AND r."workspaceId"=m."workspaceId" WHERE m."workspaceId"=? AND r."isOwner"=1 ORDER BY m."userId" LIMIT 1', [automation.workspaceId])
        for (let version = 1; version <= automation.version; version++) {
          const result = await db.rawQuery('SELECT id,position,type,config FROM automation_steps WHERE "workspaceId"=? AND "automationId"=? AND version=? ORDER BY position', [automation.workspaceId, automation.id, version])
          const steps = rows<{ id: string; position: number; type: string; config: string }>(result)
          if (!steps.length) continue
          await db.rawQuery('INSERT INTO automation_versions ("workspaceId","automationId",version,format,graph,"publisherId","publishedAt") VALUES (?,?,?,?,?,?,?)', [automation.workspaceId, automation.id, version, 'linear', JSON.stringify(legacyAutomationGraph(automation.event, version, steps)), rows<{ userId: string }>(owner)[0]?.userId ?? null, automation.createdAt])
        }
      }
    })
  }

  async down() {
    this.defer(async (db) => {
      const result = await db.rawQuery('SELECT id,permissions FROM roles')
      const roles = Array.isArray(result) ? result : (result as { rows?: { id: string; permissions: string }[] }).rows ?? []
      for (const role of roles as { id: string; permissions: string }[]) {
        const permissions = (JSON.parse(role.permissions) as string[]).filter((permission) => permission !== 'automations:manage' && permission !== 'credentials:manage')
        await db.rawQuery('UPDATE roles SET permissions=? WHERE id=?', [JSON.stringify(permissions), role.id])
      }
    })
    this.schema.dropTable('automation_oauth_flows')
    this.schema.dropTable('automation_version_credentials')
    this.schema.dropTable('automation_credential_versions')
    this.schema.dropTable('automation_credentials')
    this.schema.dropTable('automation_node_runs')
    this.schema.dropTable('automation_drafts')
    this.schema.dropTable('automation_versions')
    this.schema.alterTable('automation_runs', (table) => {
      table.dropColumns('leaseId', 'heartbeatAt', 'attempt', 'causation')
    })
    this.schema.alterTable('webhooks', (table) => table.dropColumn('signingVersion'))
  }
}
