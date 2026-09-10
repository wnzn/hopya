import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('items', (table) => {
      table.integer('bodyRevision').notNullable().defaultTo(1)
    })
    this.schema.alterTable('comments', (table) => {
      table.integer('anchorRevision').nullable()
      table.integer('anchorStart').nullable()
      table.integer('anchorEnd').nullable()
      table.text('anchorExact').nullable()
      table.text('anchorPrefix').nullable()
      table.text('anchorSuffix').nullable()
      table.text('anchorState').nullable()
    })
    this.schema.createTable('documents', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('parentId').nullable()
      table.text('title').notNullable()
      table.text('body').notNullable().defaultTo('')
      table.integer('bodyRevision').notNullable().defaultTo(1)
      table.text('createdAt').notNullable()
      table.text('updatedAt').notNullable()
      table.unique(['workspaceId', 'id'])
      table.index(['workspaceId', 'parentId', 'createdAt', 'id'], 'documents_workspace_parent')
      table.foreign(['workspaceId', 'parentId'], 'documents_parent_fk').references(['workspaceId', 'id']).inTable('nodes').onDelete('CASCADE')
    })
    this.schema.createTable('document_pages', (table) => {
      table.text('workspaceId').notNullable()
      table.text('documentId').notNullable()
      table.text('itemId').notNullable()
      table.integer('position').notNullable().defaultTo(0)
      table.text('createdAt').notNullable()
      table.primary(['workspaceId', 'documentId', 'itemId'])
      table.unique(['workspaceId', 'itemId'])
      table.index(['workspaceId', 'documentId', 'position', 'createdAt', 'itemId'], 'document_pages_order')
      table.foreign(['workspaceId', 'documentId'], 'document_pages_document_fk').references(['workspaceId', 'id']).inTable('documents').onDelete('CASCADE')
      table.foreign(['workspaceId', 'itemId'], 'document_pages_item_fk').references(['workspaceId', 'id']).inTable('items').onDelete('CASCADE')
    })
    this.schema.createTable('document_comments', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable()
      table.text('documentId').notNullable()
      table.text('authorId').nullable()
      table.text('body').notNullable()
      table.text('createdAt').notNullable()
      table.text('deletedAt').nullable()
      table.text('parentId').nullable()
      table.integer('anchorRevision').nullable()
      table.integer('anchorStart').nullable()
      table.integer('anchorEnd').nullable()
      table.text('anchorExact').nullable()
      table.text('anchorPrefix').nullable()
      table.text('anchorSuffix').nullable()
      table.text('anchorState').nullable()
      table.unique(['workspaceId', 'documentId', 'id'])
      table.index(['workspaceId', 'documentId', 'createdAt', 'id'], 'document_comments_document')
      table.foreign(['workspaceId', 'documentId'], 'document_comments_document_fk').references(['workspaceId', 'id']).inTable('documents').onDelete('CASCADE')
      table.foreign(['authorId'], 'document_comments_author_fk').references(['id']).inTable('users').onDelete('SET NULL')
      table.foreign(['parentId'], 'document_comments_parent_fk').references(['id']).inTable('document_comments')
    })
    this.schema.createTable('document_comment_reactions', (table) => {
      table.text('workspaceId').notNullable()
      table.text('documentId').notNullable()
      table.text('commentId').notNullable()
      table.text('userId').notNullable()
      table.text('emoji').notNullable()
      table.text('createdAt').notNullable()
      table.primary(['workspaceId', 'documentId', 'commentId', 'userId', 'emoji'])
      table.index(['workspaceId', 'documentId', 'commentId', 'emoji'], 'document_comment_reactions_comment')
      table.foreign(['workspaceId', 'documentId', 'commentId'], 'document_comment_reactions_comment_fk').references(['workspaceId', 'documentId', 'id']).inTable('document_comments').onDelete('CASCADE')
      table.foreign(['workspaceId', 'userId'], 'document_comment_reactions_member_fk').references(['workspaceId', 'userId']).inTable('memberships').onDelete('CASCADE')
    })

    const pg = this.db.dialect.name === 'postgres'
    const check = (sql: string) => this.defer(async (db) => { await db.rawQuery(sql) })
    if (pg) {
      check('ALTER TABLE documents ADD CONSTRAINT documents_body_check CHECK (length("body") <= 50000 AND "bodyRevision" >= 1)')
      check('ALTER TABLE document_comments ADD CONSTRAINT document_comments_body_check CHECK (length("body") BETWEEN 1 AND 10000)')
      check('ALTER TABLE document_comments ADD CONSTRAINT document_comments_anchor_check CHECK (("anchorRevision" IS NULL AND "anchorStart" IS NULL AND "anchorEnd" IS NULL AND "anchorExact" IS NULL AND "anchorPrefix" IS NULL AND "anchorSuffix" IS NULL AND "anchorState" IS NULL) OR ("parentId" IS NULL AND "anchorRevision" >= 1 AND "anchorStart" >= 0 AND "anchorEnd" > "anchorStart" AND length("anchorExact") BETWEEN 1 AND 2000 AND length("anchorPrefix") <= 200 AND length("anchorSuffix") <= 200 AND "anchorState" IN (\'attached\',\'orphaned\')))')
      check('ALTER TABLE comments ADD CONSTRAINT comments_anchor_check CHECK (("anchorRevision" IS NULL AND "anchorStart" IS NULL AND "anchorEnd" IS NULL AND "anchorExact" IS NULL AND "anchorPrefix" IS NULL AND "anchorSuffix" IS NULL AND "anchorState" IS NULL) OR ("parentId" IS NULL AND "anchorRevision" >= 1 AND "anchorStart" >= 0 AND "anchorEnd" > "anchorStart" AND length("anchorExact") BETWEEN 1 AND 2000 AND length("anchorPrefix") <= 200 AND length("anchorSuffix") <= 200 AND "anchorState" IN (\'attached\',\'orphaned\')))')
      check('ALTER TABLE document_comment_reactions ADD CONSTRAINT document_comment_reactions_emoji_check CHECK ("emoji" IN (\'👍\',\'❤️\',\'😂\',\'🎉\',\'😕\',\'👀\'))')
      this.defer(async (db) => {
        await db.rawQuery(`UPDATE roles SET permissions=(SELECT jsonb_agg(value ORDER BY position)::text FROM (SELECT DISTINCT value, min(position) AS position FROM jsonb_array_elements_text(roles.permissions::jsonb) WITH ORDINALITY AS p(value,position) GROUP BY value UNION ALL SELECT 'comments:create', 1000 WHERE roles.permissions::jsonb ? 'items:write' UNION ALL SELECT 'documents:read', 1001 WHERE roles.permissions::jsonb ? 'items:read' UNION ALL SELECT 'documents:write', 1002 WHERE roles.permissions::jsonb ? 'items:write' UNION ALL SELECT 'documents:delete', 1003 WHERE roles.permissions::jsonb ? 'items:delete') migrated)`)
      })
    } else {
      check('ALTER TABLE documents ADD CONSTRAINT documents_body_check CHECK (length(body) <= 50000 AND bodyRevision >= 1)')
      check("ALTER TABLE document_comments ADD CONSTRAINT document_comments_body_check CHECK (length(body) BETWEEN 1 AND 10000)")
      check("ALTER TABLE document_comments ADD CONSTRAINT document_comments_anchor_check CHECK ((anchorRevision IS NULL AND anchorStart IS NULL AND anchorEnd IS NULL AND anchorExact IS NULL AND anchorPrefix IS NULL AND anchorSuffix IS NULL AND anchorState IS NULL) OR (parentId IS NULL AND anchorRevision >= 1 AND anchorStart >= 0 AND anchorEnd > anchorStart AND length(anchorExact) BETWEEN 1 AND 2000 AND length(anchorPrefix) <= 200 AND length(anchorSuffix) <= 200 AND anchorState IN ('attached','orphaned')))")
      check("ALTER TABLE comments ADD CONSTRAINT comments_anchor_check CHECK ((anchorRevision IS NULL AND anchorStart IS NULL AND anchorEnd IS NULL AND anchorExact IS NULL AND anchorPrefix IS NULL AND anchorSuffix IS NULL AND anchorState IS NULL) OR (parentId IS NULL AND anchorRevision >= 1 AND anchorStart >= 0 AND anchorEnd > anchorStart AND length(anchorExact) BETWEEN 1 AND 2000 AND length(anchorPrefix) <= 200 AND length(anchorSuffix) <= 200 AND anchorState IN ('attached','orphaned')))")
      check("ALTER TABLE document_comment_reactions ADD CONSTRAINT document_comment_reactions_emoji_check CHECK (emoji IN ('👍','❤️','😂','🎉','😕','👀'))")
      this.defer(async (db) => {
        await db.rawQuery(`UPDATE roles SET permissions=(SELECT json_group_array(value) FROM (SELECT DISTINCT value FROM json_each(roles.permissions) UNION ALL SELECT 'comments:create' WHERE EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value='items:write') UNION ALL SELECT 'documents:read' WHERE EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value='items:read') UNION ALL SELECT 'documents:write' WHERE EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value='items:write') UNION ALL SELECT 'documents:delete' WHERE EXISTS (SELECT 1 FROM json_each(roles.permissions) WHERE value='items:delete')))`)
      })
    }
  }

  async down() {
    this.schema.dropTable('document_comment_reactions')
    this.schema.dropTable('document_comments')
    this.schema.dropTable('document_pages')
    this.schema.dropTable('documents')
    this.schema.alterTable('comments', (table) => {
      for (const column of ['anchorRevision', 'anchorStart', 'anchorEnd', 'anchorExact', 'anchorPrefix', 'anchorSuffix', 'anchorState']) table.dropColumn(column)
    })
    this.schema.alterTable('items', (table) => table.dropColumn('bodyRevision'))
  }
}
