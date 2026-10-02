import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    // Additive: never rebuild the cascade-sensitive attachments/items tables.
    this.schema.createTable('rich_text_images', (table) => {
      table.text('id').primary()
      table.text('workspaceId').notNullable().references('id').inTable('workspaces').onDelete('CASCADE')
      table.text('objectKey').notNullable().unique().references('objectKey').inTable('storage_objects')
      table.text('kind').notNullable()
      table.text('itemId').nullable()
      table.text('documentId').nullable()
      table.text('commentId').nullable()
      table.text('documentCommentId').nullable()
      table.text('attachmentId').nullable().references('id').inTable('attachments').onDelete('CASCADE')
      table.text('createdBy').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.text('name').notNullable()
      table.text('contentType').notNullable()
      table.integer('size').notNullable()
      table.text('createdAt').notNullable()
      table.text('expiresAt').notNullable()
      table.text('committedAt').nullable()
      table.foreign(['workspaceId', 'itemId']).references(['workspaceId', 'id']).inTable('items').onDelete('CASCADE')
      table.foreign(['workspaceId', 'documentId']).references(['workspaceId', 'id']).inTable('documents').onDelete('CASCADE')
      table.foreign(['workspaceId', 'itemId', 'commentId']).references(['workspaceId', 'itemId', 'id']).inTable('comments').onDelete('CASCADE')
      table.foreign(['workspaceId', 'documentId', 'documentCommentId']).references(['workspaceId', 'documentId', 'id']).inTable('document_comments').onDelete('CASCADE')
      table.index(['createdBy', 'committedAt', 'expiresAt'])
      table.index(['workspaceId', 'itemId'])
      table.index(['workspaceId', 'documentId'])
      table.check('"size" > 0 AND "size" <= 10485760')
      table.check(`"contentType" IN ('image/png','image/jpeg','image/gif','image/webp')`)
      table.check(`("kind" = 'task-body' AND "documentId" IS NULL AND "commentId" IS NULL AND "documentCommentId" IS NULL)
        OR ("kind" = 'task-comment' AND "itemId" IS NOT NULL AND "documentId" IS NULL AND "documentCommentId" IS NULL AND "attachmentId" IS NULL)
        OR ("kind" = 'document-comment' AND "documentId" IS NOT NULL AND "itemId" IS NULL AND "commentId" IS NULL AND "attachmentId" IS NULL)`)
      table.check(`"committedAt" IS NULL OR ("kind" = 'task-body' AND "itemId" IS NOT NULL AND "attachmentId" IS NOT NULL)
        OR ("kind" = 'task-comment' AND "commentId" IS NOT NULL) OR ("kind" = 'document-comment' AND "documentCommentId" IS NOT NULL)`)
    })
  }

  async down() { this.schema.dropTable('rich_text_images') }
}
