import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Squashed baseline of the complete Hopya relational schema. New databases
 * (SQLite and Postgres) apply only this migration; databases migrated with
 * the legacy numbered .sql runner are adopted inside up() below, which marks
 * the baseline as already applied without rebuilding their schema.
 *
 * Layout parity rules with the legacy SQLite schema:
 * - All timestamps are TEXT ISO-8601 strings produced by the application,
 *   never engine timestamp types, so lexicographic SQL comparisons
 *   (expiry checks, keyset cursor seeks) behave identically on both dialects.
 * - All IDs are application-generated UUID strings (text columns).
 * - Boolean-ish columns are 0/1 integers with CHECK constraints.
 * - JSON payloads are text columns; shape/size bounds are enforced with
 *   CHECK constraints.
 */
export default class extends BaseSchema {
  async up() {
    // Lucid dialect names: 'better-sqlite3' for the sqlite connection,
    // 'postgres' for Postgres. Works on both query and transaction clients.
    const pg = this.db.dialect.name === 'postgres'

    // Legacy adoption: SQLite deployments migrated with the numbered .sql
    // runner already have the complete final schema and a populated
    // schema_migrations history. Their upgrade ends here; fresh databases
    // fall through and build the schema.
    if (!pg) {
      const legacy = await this.db.rawQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      const hasHistory = Array.isArray(legacy) && legacy.length > 0 &&
        ((await this.db.rawQuery('SELECT COUNT(*) AS count FROM schema_migrations') as { count: number }[]))[0]?.count > 0
      if (hasHistory) return
    }

    this.schema.createTable('users', (table) => {
      table.text('id').primary()
      table.text('name').notNullable()
      table.text('email').notNullable()
      table.text('passwordHash').nullable()
      table.integer('isAdmin').notNullable().defaultTo(0)
      table.integer('disabled').notNullable().defaultTo(0)
      table.text('createdAt').notNullable()
      table.check('?? IN (0,1)', ['isAdmin'])
      table.check('?? IN (0,1)', ['disabled'])
    })
    // Case-insensitive email uniqueness: COLLATE NOCASE on SQLite,
    // lower() unique index on Postgres.
    if (pg) {
      this.defer(async (db) => { await db.rawQuery('CREATE UNIQUE INDEX users_email_unique ON users (lower(email))') })
    } else {
      this.defer(async (db) => { await db.rawQuery('CREATE UNIQUE INDEX users_email_unique ON users (email COLLATE NOCASE)') })
    }

    this.schema.createTable('sessions', (table) => {
      table.text('id').primary()
      table.text('userId').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.text('tokenHash').notNullable()
      table.text('expiresAt').notNullable()
      table.text('createdAt').notNullable()
      table.unique(['tokenHash'])
      table.index(['expiresAt'], 'sessions_expiry')
    })

    this.schema.createTable('tokens', (table) => {
      table.text('id').primary()
      table.text('userId').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('tokenHash').notNullable()
      table.text('expiresAt').notNullable()
      table.text('createdAt').notNullable()
      table.unique(['tokenHash'])
      table.index(['userId'], 'tokens_user')
    })

    this.schema.createTable('workspaces', (table) => {
      table.text('id').primary()
      table.text('name').notNullable()
      table.text('createdAt').notNullable()
    })

    this.schema.createTable('roles', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('permissions').notNullable()
      table.integer('isOwner').notNullable().defaultTo(0)
      table.check('?? IN (0,1)', ['isOwner'])
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'name'], 'roles_workspace_name_unique')
    })

    this.schema.createTable('memberships', (table) => {
      table.text('workspaceId').notNullable()
      table.text('userId').notNullable()
      table.text('roleId').notNullable()
      table.primary(['workspaceId', 'userId'])
      table.index(['userId'], 'memberships_user')
      table.foreign(['workspaceId'], 'memberships_workspace_fk').references(['id']).on('workspaces').onDelete('CASCADE')
      table.foreign(['workspaceId', 'roleId'], 'memberships_role_fk').references(['workspaceId', 'id']).on('roles').onDelete('CASCADE')
    })

    this.schema.createTable('nodes', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('kind').notNullable()
      table.text('parentId').nullable()
      table.text('description').notNullable().defaultTo('')
      table.text('icon').nullable()
      table.text('color').nullable()
      table.text('createdAt').notNullable()
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'parentId'], 'nodes_workspace')
      table.foreign(['workspaceId', 'parentId'], 'nodes_parent_fk').references(['workspaceId', 'id']).on('nodes').onDelete('CASCADE')
    })

    this.schema.createTable('fields', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('type').notNullable()
      table.text('options').notNullable().defaultTo('[]')
      table.text('settings').notNullable().defaultTo('{}')
      table.unique(['workspaceId', 'name'])
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'id'], 'fields_workspace_id')
    })

    this.schema.createTable('items', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('nodeId').notNullable()
      table.text('title').notNullable()
      table.text('description').notNullable().defaultTo('')
      table.text('status').notNullable()
      table.text('priority').notNullable()
      table.text('startDate').nullable()
      table.text('dueDate').nullable()
      table.text('tags').notNullable().defaultTo('[]')
      table.text('customFields').notNullable().defaultTo('{}')
      table.text('assigneeId').nullable()
      table.text('checklist').notNullable().defaultTo('[]')
      table.text('parentId').nullable()
      table.text('archivedAt').nullable()
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'nodeId', 'status'], 'items_workspace')
      table.index(['workspaceId', 'createdAt', 'id'], 'items_workspace_read')
      table.index(['workspaceId', 'archivedAt', 'createdAt', 'id'], 'items_workspace_archive_read')
      table.index(['parentId'], 'items_parent')
      table.foreign(['workspaceId', 'nodeId'], 'items_node_fk').references(['workspaceId', 'id']).on('nodes').onDelete('CASCADE')
      table.foreign(['parentId'], 'items_parent_fk').references(['id']).on('items').onDelete('CASCADE')
      table.foreign(['assigneeId'], 'items_assignee_fk').references(['id']).on('users')
    })

    this.schema.createTable('audit_logs', (table) => {
      table.text('id').primary()
      table.text('actorId').nullable()
      table.text('workspaceId').nullable()
      table.text('action').notNullable()
      table.text('resourceId').nullable()
      table.text('details').notNullable().defaultTo('{}')
      table.text('createdAt').notNullable()
      table.index(['workspaceId', 'createdAt'], 'audit_workspace')
      table.foreign(['actorId'], 'audit_actor_fk').references(['id']).on('users')
    })

    this.schema.createTable('storage_objects', (table) => {
      table.text('objectKey').primary()
      table.text('driver').notNullable()
      table.text('location').notNullable()
      table.text('createdAt').notNullable()
      table.index(['driver', 'location', 'createdAt'], 'storage_objects_gc')
    })

    this.schema.createTable('attachments', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('itemId').notNullable()
      table.text('objectKey').notNullable()
      table.text('name').notNullable()
      table.text('contentType').notNullable()
      table.integer('size').notNullable()
      table.text('createdBy').nullable()
      table.text('createdAt').notNullable()
      table.unique(['objectKey'])
      table.index(['workspaceId', 'itemId', 'createdAt'], 'attachments_item')
      table.foreign(['objectKey'], 'attachments_object_fk').references(['objectKey']).on('storage_objects')
      table.foreign(['workspaceId', 'itemId'], 'attachments_item_fk').references(['workspaceId', 'id']).on('items').onDelete('CASCADE')
      table.foreign(['createdBy'], 'attachments_creator_fk').references(['id']).on('users').onDelete('SET NULL')
    })

    this.schema.createTable('oidc_identities', (table) => {
      table.text('id').primary()
      table.text('userId').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.text('issuer').notNullable()
      table.text('subject').notNullable()
      table.text('createdAt').notNullable()
      table.unique(['issuer', 'subject'])
      table.index(['userId'], 'oidc_identities_user')
    })

    this.schema.createTable('oidc_flows', (table) => {
      table.text('cookieHash').primary()
      table.text('stateHash').notNullable()
      table.text('nonce').notNullable()
      table.text('codeVerifier').notNullable()
      table.text('issuer').notNullable()
      table.text('clientId').notNullable()
      table.text('redirectUri').notNullable()
      table.text('expiresAt').notNullable()
      table.unique(['stateHash'])
      table.index(['expiresAt'], 'oidc_flows_expiry')
    })

    this.schema.createTable('project_field_configs', (table) => {
      table.text('workspaceId').notNullable()
      table.text('projectId').notNullable()
      table.text('builtInFields').notNullable().defaultTo('[]')
      table.text('dateFormat').nullable()
      table.text('statuses').notNullable()
      table.text('updatedAt').notNullable()
      table.primary(['workspaceId', 'projectId'])
      table.foreign(['workspaceId', 'projectId'], 'project_field_configs_node_fk').references(['workspaceId', 'id']).on('nodes').onDelete('CASCADE')
    })

    this.schema.createTable('project_field_assignments', (table) => {
      table.text('workspaceId').notNullable()
      table.text('projectId').notNullable()
      table.text('fieldId').notNullable()
      table.integer('position').notNullable()
      table.primary(['workspaceId', 'projectId', 'fieldId'])
      table.index(['workspaceId', 'fieldId', 'projectId'], 'project_field_assignments_field')
      table.foreign(['workspaceId', 'projectId'], 'project_field_assignments_config_fk').references(['workspaceId', 'projectId']).on('project_field_configs').onDelete('CASCADE')
      table.foreign(['workspaceId', 'fieldId'], 'project_field_assignments_field_fk').references(['workspaceId', 'id']).on('fields').onDelete('CASCADE')
    })

    this.schema.createTable('list_status_configs', (table) => {
      table.text('workspaceId').notNullable()
      table.text('listId').notNullable()
      table.text('statuses').nullable()
      table.text('updatedAt').notNullable()
      table.primary(['workspaceId', 'listId'])
      table.foreign(['workspaceId', 'listId'], 'list_status_configs_node_fk').references(['workspaceId', 'id']).on('nodes').onDelete('CASCADE')
    })

    this.schema.createTable('site_settings', (table) => {
      table.text('key').primary()
      table.text('value').nullable()
      table.text('updatedAt').notNullable()
    })

    this.schema.createTable('webhooks', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('url').notNullable()
      table.text('events').notNullable()
      table.integer('enabled').notNullable().defaultTo(1)
      table.text('secret').notNullable()
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.check('?? IN (0,1)', ['enabled'])
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId'], 'webhooks_workspace')
    })

    this.schema.createTable('automations', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('name').notNullable()
      table.text('event').notNullable()
      table.text('config').notNullable().defaultTo('{}')
      table.integer('enabled').notNullable().defaultTo(1)
      table.integer('version').notNullable().defaultTo(1)
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.check('?? IN (0,1)', ['enabled'])
      table.check('?? >= 1', ['version'])
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId'], 'automations_workspace')
    })

    this.schema.createTable('automation_steps', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('automationId').notNullable()
      table.integer('version').notNullable()
      table.integer('position').notNullable()
      table.text('type').notNullable()
      table.text('config').notNullable()
      table.text('createdAt').notNullable()
      table.check('?? >= 1', ['version'])
      table.check('?? >= 1', ['position'])
      table.unique(['automationId', 'version', 'position'])
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'automationId', 'version', 'position'], 'automation_steps_version')
      table.foreign(['workspaceId', 'automationId'], 'automation_steps_automation_fk').references(['workspaceId', 'id']).on('automations').onDelete('CASCADE')
    })

    this.schema.createTable('automation_runs', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('automationId').nullable()
      table.text('targetType').notNullable()
      table.text('targetId').notNullable()
      table.integer('automationVersion').nullable()
      table.text('status').notNullable()
      table.text('event').nullable()
      table.text('detail').notNullable().defaultTo('')
      table.text('createdAt').notNullable()
      table.text('startedAt').nullable()
      table.text('completedAt').nullable()
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'createdAt', 'id'], 'automation_runs_workspace')
      table.index(['status', 'createdAt', 'id'], 'automation_runs_pending')
      table.index(['workspaceId', 'automationId', 'createdAt', 'id'], 'automation_runs_automation')
    })

    this.schema.createTable('automation_step_runs', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('runId').notNullable()
      table.text('stepId').notNullable()
      table.integer('position').notNullable()
      table.text('type').notNullable()
      table.text('status').notNullable()
      table.text('output').notNullable().defaultTo('')
      table.text('log').notNullable().defaultTo('')
      table.text('startedAt').nullable()
      table.text('completedAt').nullable()
      table.check('?? >= 1', ['position'])
      table.unique(['runId', 'position'])
      table.index(['workspaceId', 'runId', 'position'], 'automation_step_runs_run')
      table.foreign(['workspaceId', 'runId'], 'automation_step_runs_run_fk').references(['workspaceId', 'id']).on('automation_runs').onDelete('CASCADE')
      table.foreign(['workspaceId', 'stepId'], 'automation_step_runs_step_fk').references(['workspaceId', 'id']).on('automation_steps').onDelete('CASCADE')
    })

    this.schema.createTable('password_reset_tokens', (table) => {
      table.text('id').primary()
      table.text('userId').notNullable()
      table.text('tokenHash').notNullable()
      table.text('expiresAt').notNullable()
      table.text('createdAt').notNullable()
      table.unique(['userId'])
      table.unique(['tokenHash'])
      table.index(['expiresAt'], 'password_reset_tokens_expiry')
      table.foreign(['userId'], 'password_reset_tokens_user_fk').references(['id']).on('users').onDelete('CASCADE')
    })

    this.schema.createTable('comments', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('itemId').notNullable()
      table.text('authorId').nullable()
      table.text('body').notNullable()
      table.text('createdAt').notNullable()
      table.text('deletedAt').nullable()
      table.text('parentId').nullable()
      table.unique(['workspaceId', 'itemId', 'id'])
      table.index(['workspaceId', 'itemId', 'createdAt', 'id'], 'comments_item')
      table.foreign(['workspaceId', 'itemId'], 'comments_item_fk').references(['workspaceId', 'id']).on('items').onDelete('CASCADE')
      table.foreign(['authorId'], 'comments_author_fk').references(['id']).on('users').onDelete('SET NULL')
      table.foreign(['parentId'], 'comments_parent_fk').references(['id']).on('comments')
    })

    this.schema.createTable('item_mentions', (table) => {
      table.text('workspaceId').notNullable()
      table.text('itemId').notNullable()
      table.text('userId').notNullable()
      table.primary(['workspaceId', 'itemId', 'userId'])
      table.foreign(['workspaceId', 'itemId'], 'item_mentions_item_fk').references(['workspaceId', 'id']).on('items').onDelete('CASCADE')
      table.foreign(['workspaceId', 'userId'], 'item_mentions_member_fk').references(['workspaceId', 'userId']).on('memberships').onDelete('CASCADE')
    })

    this.schema.createTable('comment_mentions', (table) => {
      table.text('workspaceId').notNullable()
      table.text('itemId').notNullable()
      table.text('commentId').notNullable()
      table.text('userId').notNullable()
      table.primary(['workspaceId', 'commentId', 'userId'])
      table.foreign(['workspaceId', 'itemId', 'commentId'], 'comment_mentions_comment_fk').references(['workspaceId', 'itemId', 'id']).on('comments').onDelete('CASCADE')
      table.foreign(['workspaceId', 'userId'], 'comment_mentions_member_fk').references(['workspaceId', 'userId']).on('memberships').onDelete('CASCADE')
    })

    this.schema.createTable('notifications', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('userId').notNullable()
      table.text('actorId').nullable()
      table.text('type').notNullable()
      table.text('itemId').notNullable()
      table.text('commentId').nullable()
      table.text('createdAt').notNullable()
      table.text('readAt').nullable()
      table.foreign(['workspaceId', 'userId'], 'notifications_member_fk').references(['workspaceId', 'userId']).on('memberships').onDelete('CASCADE')
      table.foreign(['workspaceId', 'itemId'], 'notifications_item_fk').references(['workspaceId', 'id']).on('items').onDelete('CASCADE')
      table.foreign(['workspaceId', 'itemId', 'commentId'], 'notifications_comment_fk').references(['workspaceId', 'itemId', 'id']).on('comments').onDelete('CASCADE')
      table.foreign(['actorId'], 'notifications_actor_fk').references(['id']).on('users').onDelete('SET NULL')
    })

    this.schema.createTable('comment_reactions', (table) => {
      table.text('workspaceId').notNullable()
      table.text('itemId').notNullable()
      table.text('commentId').notNullable()
      table.text('userId').notNullable()
      table.text('emoji').notNullable()
      table.text('createdAt').notNullable()
      table.primary(['workspaceId', 'commentId', 'userId', 'emoji'])
      table.index(['workspaceId', 'itemId', 'commentId', 'emoji'], 'comment_reactions_comment')
      table.foreign(['workspaceId', 'itemId', 'commentId'], 'comment_reactions_comment_fk').references(['workspaceId', 'itemId', 'id']).on('comments').onDelete('CASCADE')
      table.foreign(['workspaceId', 'userId'], 'comment_reactions_member_fk').references(['workspaceId', 'userId']).on('memberships').onDelete('CASCADE')
    })

    this.schema.createTable('list_view_settings', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('userId').notNullable()
      table.text('view').notNullable()
      table.text('projectId').nullable()
      table.text('columnOrder').notNullable()
      table.text('hiddenColumns').notNullable()
      table.text('sort').nullable()
      table.text('updatedAt').notNullable()
      table.foreign(['workspaceId', 'userId'], 'list_view_settings_member_fk').references(['workspaceId', 'userId']).on('memberships').onDelete('CASCADE')
      table.foreign(['workspaceId', 'projectId'], 'list_view_settings_node_fk').references(['workspaceId', 'id']).on('nodes').onDelete('CASCADE')
    })

    this.schema.createTable('list_tag_color_configs', (table) => {
      table.text('workspaceId').notNullable()
      table.text('listId').notNullable()
      table.text('colors').notNullable().defaultTo('{}')
      table.text('updatedAt').notNullable()
      table.primary(['workspaceId', 'listId'])
      table.foreign(['workspaceId', 'listId'], 'list_tag_color_configs_node_fk').references(['workspaceId', 'id']).on('nodes').onDelete('CASCADE')
    })

    // CHECK constraints (value domains and JSON shape bounds) plus partial
    // unique indexes. Raw SQL deferred statements; the two dialects differ
    // in JSON functions and regex operators, so each declares its own set.
    const check = (sql: string) => this.defer(async (db) => { await db.rawQuery(sql) })
    if (pg) {
      check('ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK ("kind" IN (\'project\',\'folder\',\'list\'))')
      check('ALTER TABLE nodes ADD CONSTRAINT nodes_description_check CHECK (length("description") <= 50000 AND ("kind" = \'project\' OR "description" = \'\'))')
      check('ALTER TABLE nodes ADD CONSTRAINT nodes_icon_check CHECK ("icon" IS NULL OR "icon" IN (\'diamond\',\'briefcase\',\'target\',\'folder\',\'archive\',\'bookmark\',\'list\',\'checklist\',\'calendar\',\'flag\'))')
      check('ALTER TABLE nodes ADD CONSTRAINT nodes_color_check CHECK ("color" IS NULL OR "color" IN (\'slate\',\'orange\',\'amber\',\'green\',\'teal\',\'blue\',\'violet\',\'rose\'))')
      check('ALTER TABLE fields ADD CONSTRAINT fields_type_check CHECK ("type" IN (\'text\',\'number\',\'date\',\'datetime\',\'checkbox\',\'select\',\'checklist\',\'rating\',\'formula\'))')
      check('ALTER TABLE fields ADD CONSTRAINT fields_settings_check CHECK (jsonb_typeof("settings"::jsonb) = \'object\')')
      check('ALTER TABLE items ADD CONSTRAINT items_priority_check CHECK ("priority" IN (\'none\',\'low\',\'medium\',\'high\',\'urgent\'))')
      check('ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (length("status") BETWEEN 1 AND 64 AND "status" ~ \'^[A-Za-z0-9][A-Za-z0-9_-]*$\')')
      check('ALTER TABLE items ADD CONSTRAINT items_description_check CHECK (length("description") <= 50000)')
      check('ALTER TABLE attachments ADD CONSTRAINT attachments_size_check CHECK ("size" BETWEEN 0 AND 10485760)')
      check('ALTER TABLE storage_objects ADD CONSTRAINT storage_objects_driver_check CHECK ("driver" IN (\'filesystem\',\'s3\'))')
      check('ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_type_check CHECK ("type" IN (\'webhook\',\'email\',\'http\',\'log\'))')
      check('ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_target_check CHECK ("targetType" IN (\'automation\',\'webhook\'))')
      check('ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_status_check CHECK ("status" IN (\'pending\',\'running\',\'delivered\',\'failed\'))')
      check('ALTER TABLE automation_step_runs ADD CONSTRAINT automation_step_runs_type_check CHECK ("type" IN (\'webhook\',\'email\',\'http\',\'log\'))')
      check('ALTER TABLE automation_step_runs ADD CONSTRAINT automation_step_runs_status_check CHECK ("status" IN (\'pending\',\'running\',\'delivered\',\'failed\',\'skipped\'))')
      check('ALTER TABLE comments ADD CONSTRAINT comments_body_check CHECK (length("body") BETWEEN 1 AND 10000)')
      check('ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK ("type" IN (\'assignment\',\'mention\'))')
      check('ALTER TABLE comment_reactions ADD CONSTRAINT comment_reactions_emoji_check CHECK ("emoji" IN (\'👍\',\'❤️\',\'😂\',\'🎉\',\'😕\',\'👀\'))')
      check('ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_view_check CHECK ("view" = \'list\')')
      check('ALTER TABLE project_field_configs ADD CONSTRAINT project_field_configs_status_check CHECK (jsonb_typeof("statuses"::jsonb) = \'array\' AND jsonb_array_length("statuses"::jsonb) BETWEEN 1 AND 50)')
      check('ALTER TABLE project_field_configs ADD CONSTRAINT project_field_configs_dateformat_check CHECK ("dateFormat" IS NULL OR "dateFormat" IN (\'yyyy-MM-dd\',\'MMM d, yyyy\',\'MMMM d, yyyy\',\'dd/MM/yyyy\'))')
      check('ALTER TABLE list_status_configs ADD CONSTRAINT list_status_configs_status_check CHECK ("statuses" IS NULL OR (jsonb_typeof("statuses"::jsonb) = \'array\' AND jsonb_array_length("statuses"::jsonb) BETWEEN 1 AND 50))')
      check('ALTER TABLE list_tag_color_configs ADD CONSTRAINT list_tag_color_configs_colors_check CHECK (jsonb_typeof("colors"::jsonb) = \'object\')')
      check('ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_columns_check CHECK (jsonb_typeof("columnOrder"::jsonb) = \'array\' AND jsonb_array_length("columnOrder"::jsonb) <= 111)')
      check('ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_hidden_check CHECK (jsonb_typeof("hiddenColumns"::jsonb) = \'array\' AND jsonb_array_length("hiddenColumns"::jsonb) <= 110)')
      check('ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_sort_check CHECK ("sort" IS NULL OR jsonb_typeof("sort"::jsonb) = \'object\')')

      this.defer(async (db) => {
        await db.rawQuery('CREATE UNIQUE INDEX list_view_settings_all_scope ON list_view_settings ("workspaceId", "userId", "view") WHERE "projectId" IS NULL')
        await db.rawQuery('CREATE UNIQUE INDEX list_view_settings_project_scope ON list_view_settings ("workspaceId", "userId", "view", "projectId") WHERE "projectId" IS NOT NULL')
        await db.rawQuery('CREATE INDEX notifications_user ON notifications ("workspaceId", "userId", "createdAt" DESC, "id" DESC)')
        await db.rawQuery('CREATE INDEX notifications_unread ON notifications ("workspaceId", "userId", "createdAt" DESC, "id" DESC) WHERE "readAt" IS NULL')
      })
    } else {
      check("ALTER TABLE nodes ADD CONSTRAINT nodes_kind_check CHECK (kind IN ('project','folder','list'))")
      check("ALTER TABLE nodes ADD CONSTRAINT nodes_description_check CHECK (length(description) <= 50000 AND (kind = 'project' OR description = ''))")
      check("ALTER TABLE nodes ADD CONSTRAINT nodes_icon_check CHECK (icon IS NULL OR icon IN ('diamond','briefcase','target','folder','archive','bookmark','list','checklist','calendar','flag'))")
      check("ALTER TABLE nodes ADD CONSTRAINT nodes_color_check CHECK (color IS NULL OR color IN ('slate','orange','amber','green','teal','blue','violet','rose'))")
      check("ALTER TABLE fields ADD CONSTRAINT fields_type_check CHECK (type IN ('text','number','date','datetime','checkbox','select','checklist','rating','formula'))")
      check("ALTER TABLE fields ADD CONSTRAINT fields_settings_check CHECK (json_valid(settings) AND json_type(settings) = 'object')")
      check("ALTER TABLE items ADD CONSTRAINT items_priority_check CHECK (priority IN ('none','low','medium','high','urgent'))")
      check("ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (length(status) BETWEEN 1 AND 64 AND status NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(status,1,1) GLOB '[A-Za-z0-9]')")
      check("ALTER TABLE items ADD CONSTRAINT items_description_check CHECK (length(description) <= 50000)")
      check('ALTER TABLE attachments ADD CONSTRAINT attachments_size_check CHECK (size BETWEEN 0 AND 10485760)')
      check("ALTER TABLE storage_objects ADD CONSTRAINT storage_objects_driver_check CHECK (driver IN ('filesystem','s3'))")
      check("ALTER TABLE automation_steps ADD CONSTRAINT automation_steps_type_check CHECK (type IN ('webhook','email','http','log'))")
      check("ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_target_check CHECK (targetType IN ('automation','webhook'))")
      check("ALTER TABLE automation_runs ADD CONSTRAINT automation_runs_status_check CHECK (status IN ('pending','running','delivered','failed'))")
      check("ALTER TABLE automation_step_runs ADD CONSTRAINT automation_step_runs_type_check CHECK (type IN ('webhook','email','http','log'))")
      check("ALTER TABLE automation_step_runs ADD CONSTRAINT automation_step_runs_status_check CHECK (status IN ('pending','running','delivered','failed','skipped'))")
      check("ALTER TABLE comments ADD CONSTRAINT comments_body_check CHECK (length(body) BETWEEN 1 AND 10000)")
      check("ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN ('assignment','mention'))")
      check("ALTER TABLE comment_reactions ADD CONSTRAINT comment_reactions_emoji_check CHECK (emoji IN ('👍','❤️','😂','🎉','😕','👀'))")
      check('ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_view_check CHECK ("view" = \'list\')')
      check("ALTER TABLE project_field_configs ADD CONSTRAINT project_field_configs_status_check CHECK (json_valid(statuses) AND json_type(statuses) = 'array' AND json_array_length(statuses) BETWEEN 1 AND 50)")
      check("ALTER TABLE project_field_configs ADD CONSTRAINT project_field_configs_dateformat_check CHECK (dateFormat IS NULL OR dateFormat IN ('yyyy-MM-dd','MMM d, yyyy','MMMM d, yyyy','dd/MM/yyyy'))")
      check("ALTER TABLE list_status_configs ADD CONSTRAINT list_status_configs_status_check CHECK (statuses IS NULL OR (json_valid(statuses) AND json_type(statuses) = 'array' AND json_array_length(statuses) BETWEEN 1 AND 50))")
      check("ALTER TABLE list_tag_color_configs ADD CONSTRAINT list_tag_color_configs_colors_check CHECK (json_valid(colors) AND json_type(colors) = 'object')")
      check("ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_columns_check CHECK (json_valid(columnOrder) AND json_type(columnOrder) = 'array' AND json_array_length(columnOrder) <= 111)")
      check("ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_hidden_check CHECK (json_valid(hiddenColumns) AND json_type(hiddenColumns) = 'array' AND json_array_length(hiddenColumns) <= 110)")
      check("ALTER TABLE list_view_settings ADD CONSTRAINT list_view_settings_sort_check CHECK (sort IS NULL OR (json_valid(sort) AND json_type(sort) = 'object'))")

      this.defer(async (db) => {
        await db.rawQuery('CREATE UNIQUE INDEX list_view_settings_all_scope ON list_view_settings (workspaceId, userId, view) WHERE projectId IS NULL')
        await db.rawQuery('CREATE UNIQUE INDEX list_view_settings_project_scope ON list_view_settings (workspaceId, userId, view, projectId) WHERE projectId IS NOT NULL')
        await db.rawQuery('CREATE INDEX notifications_user ON notifications (workspaceId, userId, createdAt DESC, id DESC)')
        await db.rawQuery('CREATE INDEX notifications_unread ON notifications (workspaceId, userId, createdAt DESC, id DESC) WHERE readAt IS NULL')
      })
    }
  }

  async down() {
    this.schema.dropTable('comment_reactions')
    this.schema.dropTable('notifications')
    this.schema.dropTable('comment_mentions')
    this.schema.dropTable('item_mentions')
    this.schema.dropTable('comments')
    this.schema.dropTable('password_reset_tokens')
    this.schema.dropTable('automation_step_runs')
    this.schema.dropTable('automation_runs')
    this.schema.dropTable('automation_steps')
    this.schema.dropTable('automations')
    this.schema.dropTable('webhooks')
    this.schema.dropTable('site_settings')
    this.schema.dropTable('list_status_configs')
    this.schema.dropTable('list_tag_color_configs')
    this.schema.dropTable('list_view_settings')
    this.schema.dropTable('project_field_assignments')
    this.schema.dropTable('project_field_configs')
    this.schema.dropTable('oidc_flows')
    this.schema.dropTable('oidc_identities')
    this.schema.dropTable('attachments')
    this.schema.dropTable('storage_objects')
    this.schema.dropTable('audit_logs')
    this.schema.dropTable('items')
    this.schema.dropTable('fields')
    this.schema.dropTable('nodes')
    this.schema.dropTable('memberships')
    this.schema.dropTable('roles')
    this.schema.dropTable('workspaces')
    this.schema.dropTable('tokens')
    this.schema.dropTable('sessions')
    this.schema.dropTable('users')
  }
}