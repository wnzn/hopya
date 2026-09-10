import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    const postgres = this.db.dialect.name === 'postgres'
    this.defer(async (db) => {
      await db.rawQuery(postgres ? `INSERT INTO document_subpages("workspaceId","documentId","pageDocumentId",position,"createdAt")
        SELECT a."workspaceId",(a.details::jsonb->>'documentId'),a."resourceId",COALESCE((a.details::jsonb->>'position')::integer,0),a."createdAt"
        FROM audit_logs a
        JOIN documents parent ON parent."workspaceId"=a."workspaceId" AND parent.id=(a.details::jsonb->>'documentId')
        JOIN documents page ON page."workspaceId"=a."workspaceId" AND page.id=a."resourceId"
        WHERE a.action='document.page.create' AND a."workspaceId" IS NOT NULL AND a."resourceId" IS NOT NULL
        ON CONFLICT DO NOTHING` : `INSERT OR IGNORE INTO document_subpages(workspaceId,documentId,pageDocumentId,position,createdAt)
        SELECT a.workspaceId,json_extract(a.details,'$.documentId'),a.resourceId,COALESCE(json_extract(a.details,'$.position'),0),a.createdAt
        FROM audit_logs a
        JOIN documents parent ON parent.workspaceId=a.workspaceId AND parent.id=json_extract(a.details,'$.documentId')
        JOIN documents page ON page.workspaceId=a.workspaceId AND page.id=a.resourceId
        WHERE a.action='document.page.create' AND a.workspaceId IS NOT NULL AND a.resourceId IS NOT NULL`)
    })
  }

  async down() {}
}
