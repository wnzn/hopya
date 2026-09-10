import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { audit, db } from './database.js'
import { commentAnchorSchema, anchorColumns, decodeAnchor, relocateAnchors, validateAnchor } from './comment_anchors.js'
import { commentReactionEmojis, lockWorkspaceHierarchy, nextItemUpdatedAt, requireMembership, requirePermission } from './service.js'
import { decodeItem, itemColumns, type ItemRow, type ItemWithSubtasks } from './task_reads.js'
import { HttpError, type Comment, type CommentReaction, type DocumentRecord } from './types.js'

const id = z.string().uuid()
const timestamp = z.string().max(64).datetime({ offset: true })
const title = z.string().trim().min(1).max(300)
const body = z.string().transform((value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')).pipe(z.string().max(50000))
const commentBody = body.pipe(z.string().trim().min(1).max(10000))
const reactionEmoji = z.enum(commentReactionEmojis)
const now = () => new Date().toISOString()

type DocumentCommentRow = Record<string, unknown> & {
  id: string; workspaceId: string; documentId: string; authorId: string | null; authorName: string
  body: string; parentId: string | null; createdAt: string; deletedAt: string | null
}

async function documentInWorkspace(wid: string, documentId: string): Promise<DocumentRecord> {
  const document = await db.get<DocumentRecord & Record<string, unknown>>(`SELECT d.id,d.workspaceId,d.parentId,d.title,d.body,d.bodyRevision,d.createdAt,d.updatedAt,
    creator.name AS createdByName,COALESCE(updater.name,CASE WHEN d.updatedById IS NOT NULL THEN 'Former member' END) AS updatedByName
    FROM documents d LEFT JOIN users creator ON creator.id=d.createdById LEFT JOIN users updater ON updater.id=d.updatedById
    WHERE d.workspaceId=? AND d.id=?`, wid, id.parse(documentId))
  if (!document) throw new HttpError(404, 'Document not found')
  return document
}

async function validateParent(wid: string, parentId: string | null) {
  if (parentId === null) return
  const parent = await db.get<{ kind: string; parentId: string | null }>('SELECT kind,parentId FROM nodes WHERE workspaceId=? AND id=?', wid, parentId)
  if (!parent) throw new HttpError(404, 'Parent node not found')
  if (parent.kind !== 'project' && parent.kind !== 'folder') throw new HttpError(400, 'Documents may only be placed in projects or folders')
  let current = parent.parentId
  let depth = 1
  while (current !== null) {
    if (++depth >= 32) throw new HttpError(400, 'Maximum hierarchy depth exceeded')
    const ancestor = await db.get<{ parentId: string | null }>('SELECT parentId FROM nodes WHERE workspaceId=? AND id=?', wid, current)
    if (!ancestor) throw new HttpError(400, 'Document parent hierarchy is incomplete')
    current = ancestor.parentId
  }
}

async function requireDocumentMetadata(userId: string, wid: string) {
  const member = await requireMembership(userId, wid)
  if (!member.permissions.some((permission) => permission === 'documents:read' || permission === 'documents:write' || permission === 'structure:write')) {
    throw new HttpError(403, 'Document access denied')
  }
}

async function documentPageLineage(wid: string, documentId: string) {
  let current = id.parse(documentId)
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const parent = await db.get<{ documentId: string }>('SELECT documentId FROM document_subpages WHERE workspaceId=? AND pageDocumentId=?', wid, current)
    if (!parent) return { rootId: current, depth: seen.size - 1 }
    current = parent.documentId
    if (seen.size >= 32) throw new HttpError(409, 'Document page hierarchy is invalid')
  }
  throw new HttpError(409, 'Document page hierarchy is invalid')
}

async function listReactions(userId: string, wid: string, documentId: string) {
  const rows = await db.all<{ commentId: string; emoji: string; count: number; reactedByMe: number }>(`SELECT commentId,emoji,count(*) AS count,max(CASE WHEN userId=? THEN 1 ELSE 0 END) AS reactedByMe
    FROM document_comment_reactions WHERE workspaceId=? AND documentId=? GROUP BY commentId,emoji ORDER BY emoji`, userId, wid, documentId)
  const result = new Map<string, CommentReaction[]>()
  for (const row of rows) {
    const reactions = result.get(row.commentId) ?? []
    reactions.push({ emoji: row.emoji, count: Number(row.count), reactedByMe: Boolean(row.reactedByMe) })
    result.set(row.commentId, reactions)
  }
  return result
}

export const documentService = {
  async listDocuments(userId: string, wid: string) {
    await requireDocumentMetadata(userId, wid)
    return db.all<Pick<DocumentRecord, 'id' | 'workspaceId' | 'parentId' | 'title' | 'createdAt' | 'updatedAt'> & { parentDocumentId: string | null; pagePlacement: string | null }>(
      `SELECT d.id,d.workspaceId,d.parentId,d.title,d.createdAt,d.updatedAt,p.documentId AS parentDocumentId,p.placement AS pagePlacement
       FROM documents d LEFT JOIN document_subpages p ON p.workspaceId=d.workspaceId AND p.pageDocumentId=d.id
       WHERE d.workspaceId=? ORDER BY d.createdAt,d.id`, wid)
  },

  async getDocument(userId: string, wid: string, documentId: string) {
    await requirePermission(userId, wid, 'documents:read')
    return documentInWorkspace(wid, documentId)
  },

  async createDocument(userId: string, wid: string, input: unknown) {
    const data = z.object({ title, body: body.default(''), parentId: id.nullable().default(null) }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:write')
      await lockWorkspaceHierarchy(wid)
      await validateParent(wid, data.parentId)
      const createdAt = now()
      const document = { id: randomUUID(), workspaceId: wid, ...data, bodyRevision: 1, createdAt, updatedAt: createdAt, createdById: userId, updatedById: userId }
      await db.run(`INSERT INTO documents(id,workspaceId,parentId,title,body,bodyRevision,createdAt,updatedAt,createdById,updatedById)
        VALUES (@id,@workspaceId,@parentId,@title,@body,@bodyRevision,@createdAt,@updatedAt,@createdById,@updatedById)`, document)
      await audit(userId, wid, 'document.create', document.id, { parentId: document.parentId })
      return documentInWorkspace(wid, document.id)
    })
  },

  async updateDocument(userId: string, wid: string, documentId: string, input: unknown) {
    const data = z.object({ title: title.optional(), body: body.optional(), parentId: id.nullable().optional(), expectedUpdatedAt: timestamp }).strict()
      .refine((value) => value.title !== undefined || value.body !== undefined || value.parentId !== undefined, 'Provide a field to update').parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:read')
      await requirePermission(userId, wid, 'documents:write')
      await lockWorkspaceHierarchy(wid)
      await db.get(`SELECT id FROM documents WHERE workspaceId=? AND id=? ${db.sql({ pg: 'FOR UPDATE', sqlite: '' })}`, wid, documentId)
      const previous = await documentInWorkspace(wid, documentId)
      if (previous.updatedAt !== data.expectedUpdatedAt) throw new HttpError(409, 'Document changed; reload before saving')
      const parentId = data.parentId === undefined ? previous.parentId : data.parentId
      await validateParent(wid, parentId)
      if (data.parentId !== undefined) {
        const { rootId } = await documentPageLineage(wid, documentId)
        if (rootId !== documentId) throw new HttpError(400, 'Document pages inherit their root document location')
      }
      const bodyChanged = data.body !== undefined && data.body !== previous.body
      const bodyRevision = previous.bodyRevision + Number(bodyChanged)
      const updatedAt = nextItemUpdatedAt(previous.updatedAt)
      const updated = await db.run(`UPDATE documents SET title=?,body=?,parentId=?,bodyRevision=?,updatedAt=?,updatedById=?
        WHERE workspaceId=? AND id=? AND updatedAt=?`, data.title ?? previous.title, data.body ?? previous.body, parentId,
        bodyRevision, updatedAt, userId, wid, documentId, data.expectedUpdatedAt)
      if (!updated.changes) throw new HttpError(409, 'Document changed; reload before saving')
      if (data.parentId !== undefined) {
        await db.run(`WITH RECURSIVE descendants(id,depth) AS (
          SELECT pageDocumentId,1 FROM document_subpages WHERE workspaceId=? AND documentId=?
          UNION ALL SELECT p.pageDocumentId,d.depth+1 FROM document_subpages p JOIN descendants d ON p.documentId=d.id
          WHERE p.workspaceId=? AND d.depth<32
        ) UPDATE documents SET parentId=? WHERE workspaceId=? AND id IN (SELECT id FROM descendants)`, wid, documentId, wid, parentId, wid)
      }
      if (bodyChanged) await relocateAnchors('document_comments', 'documentId', wid, documentId, data.body!, bodyRevision)
      await audit(userId, wid, 'document.update', documentId, { fields: Object.keys(data).filter((key) => key !== 'expectedUpdatedAt') })
      return documentInWorkspace(wid, documentId)
    })
  },

  async deleteDocument(userId: string, wid: string, documentId: string) {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:delete')
      await lockWorkspaceHierarchy(wid)
      await documentInWorkspace(wid, documentId)
      const descendants = await db.all<{ id: string }>(`WITH RECURSIVE descendants(id,depth) AS (
        SELECT pageDocumentId,1 FROM document_subpages WHERE workspaceId=? AND documentId=?
        UNION ALL SELECT p.pageDocumentId,d.depth+1 FROM document_subpages p JOIN descendants d ON p.documentId=d.id
        WHERE p.workspaceId=? AND d.depth<32
      ) SELECT id FROM descendants`, wid, documentId, wid)
      const documentIds = [documentId, ...descendants.map(document => document.id)]
      const placeholders = documentIds.map(() => '?').join(',')
      const pages = Number((await db.get<{ count: number | string }>(`SELECT count(*) AS count FROM document_pages WHERE workspaceId=? AND documentId IN (${placeholders})`, wid, ...documentIds))!.count)
      await db.run(`DELETE FROM documents WHERE workspaceId=? AND id IN (${placeholders})`, wid, ...documentIds)
      await audit(userId, wid, 'document.delete', documentId, { unlinkedPages: pages, deletedSubpages: descendants.length })
      return { success: true, unlinkedPages: pages, deletedSubpages: descendants.length }
    })
  },

  async listPages(userId: string, wid: string, documentId: string): Promise<{ items: ItemWithSubtasks[]; total: number; truncated: boolean }> {
    await requirePermission(userId, wid, 'documents:read')
    await requirePermission(userId, wid, 'items:read')
    await documentInWorkspace(wid, documentId)
    const total = Number((await db.get<{ count: number | string }>(`WITH RECURSIVE page_items(id) AS (
      SELECT p.itemId FROM document_pages p JOIN items root ON root.workspaceId=p.workspaceId AND root.id=p.itemId
      WHERE p.workspaceId=? AND p.documentId=? AND root.archivedAt IS NULL
      UNION ALL SELECT i.id FROM items i JOIN page_items p ON i.parentId=p.id WHERE i.workspaceId=? AND i.archivedAt IS NULL
    ) SELECT count(*) AS count FROM page_items`, wid, documentId, wid))!.count)
    const rows = await db.all<ItemRow>(`WITH RECURSIVE page_items(id,depth,rootPosition) AS (
      SELECT p.itemId,0,p.position FROM document_pages p JOIN items root ON root.workspaceId=p.workspaceId AND root.id=p.itemId
      WHERE p.workspaceId=? AND p.documentId=? AND root.archivedAt IS NULL
      UNION ALL SELECT i.id,p.depth+1,p.rootPosition FROM items i JOIN page_items p ON i.parentId=p.id
      WHERE i.workspaceId=? AND i.archivedAt IS NULL AND p.depth<32
    ) SELECT ${itemColumns.split(',').map((column) => `i.${column}`).join(',')} FROM items i JOIN page_items p ON p.id=i.id
      WHERE i.archivedAt IS NULL ORDER BY p.rootPosition,i.createdAt,i.id LIMIT 500`, wid, documentId, wid)
    return { items: rows.map(decodeItem), total, truncated: total > rows.length }
  },

  async listSubpages(userId: string, wid: string, documentId: string) {
    await requirePermission(userId, wid, 'documents:read')
    await documentInWorkspace(wid, documentId)
    const { rootId } = await documentPageLineage(wid, documentId)
    const total = Number((await db.get<{ count: number | string }>(`WITH RECURSIVE page_documents(id,depth) AS (
      SELECT pageDocumentId,1 FROM document_subpages WHERE workspaceId=? AND documentId=?
      UNION ALL SELECT p.pageDocumentId,d.depth+1 FROM document_subpages p JOIN page_documents d ON p.documentId=d.id
      WHERE p.workspaceId=? AND d.depth<32
    ) SELECT count(*) AS count FROM page_documents`, wid, rootId, wid))!.count)
    const documents = await db.all<Pick<DocumentRecord, 'id' | 'workspaceId' | 'parentId' | 'title' | 'createdAt' | 'updatedAt'> & { parentDocumentId: string; pagePlacement: string }>(`WITH RECURSIVE page_documents(id,depth) AS (
      SELECT pageDocumentId,1 FROM document_subpages WHERE workspaceId=? AND documentId=?
      UNION ALL SELECT p.pageDocumentId,d.depth+1 FROM document_subpages p JOIN page_documents d ON p.documentId=d.id
      WHERE p.workspaceId=? AND d.depth<32
    ) SELECT d.id,d.workspaceId,d.parentId,d.title,d.createdAt,d.updatedAt,p.documentId AS parentDocumentId,p.placement AS pagePlacement
      FROM documents d JOIN page_documents tree ON tree.id=d.id JOIN document_subpages p ON p.workspaceId=d.workspaceId AND p.pageDocumentId=d.id
      WHERE d.workspaceId=? ORDER BY tree.depth,p.position,p.createdAt,p.pageDocumentId LIMIT 500`, wid, rootId, wid, wid)
    return { rootId, documents, total, truncated: total > documents.length }
  },

  async createSubpage(userId: string, wid: string, documentId: string, input: unknown) {
    const data = z.object({ title, placement: z.enum(['page', 'subpage']).default('subpage') }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:write')
      await lockWorkspaceHierarchy(wid)
      const parent = await documentInWorkspace(wid, documentId)
      const { rootId, depth } = await documentPageLineage(wid, documentId)
      if (data.placement === 'page' && documentId !== rootId) throw new HttpError(400, 'Top-level pages must be created from the root document')
      if (depth >= 31) throw new HttpError(400, 'Maximum document page depth exceeded')
      const count = (await db.get<{ count: number }>('SELECT count(*) AS count FROM document_subpages WHERE workspaceId=? AND documentId=?', wid, documentId))!.count
      const createdAt = now()
      const page = { id: randomUUID(), workspaceId: wid, parentId: parent.parentId, title: data.title, body: '', bodyRevision: 1, createdAt, updatedAt: createdAt, createdById: userId, updatedById: userId }
      await db.run(`INSERT INTO documents(id,workspaceId,parentId,title,body,bodyRevision,createdAt,updatedAt,createdById,updatedById)
        VALUES (@id,@workspaceId,@parentId,@title,@body,@bodyRevision,@createdAt,@updatedAt,@createdById,@updatedById)`, page)
      await db.run('INSERT INTO document_subpages(workspaceId,documentId,pageDocumentId,position,createdAt,placement) VALUES (?,?,?,?,?,?)', wid, documentId, page.id, count, createdAt, data.placement)
      await audit(userId, wid, 'document.page.create', page.id, { documentId, position: count, placement: data.placement })
      return documentInWorkspace(wid, page.id)
    })
  },

  async linkPage(userId: string, wid: string, documentId: string, input: unknown) {
    const data = z.object({ itemId: id, position: z.number().int().min(0).max(1000000).default(0) }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:write')
      await requirePermission(userId, wid, 'items:read')
      await documentInWorkspace(wid, documentId)
      const item = await db.get<{ parentId: string | null; archivedAt: string | null }>(`SELECT parentId,archivedAt FROM items WHERE workspaceId=? AND id=? ${db.sql({ pg: 'FOR UPDATE', sqlite: '' })}`, wid, data.itemId)
      if (!item) throw new HttpError(404, 'Task not found')
      if (item.parentId !== null) throw new HttpError(400, 'Only top-level tasks may be linked as document pages')
      if (item.archivedAt !== null) throw new HttpError(409, 'Archived tasks cannot be linked as document pages')
      if (await db.get('SELECT documentId FROM document_pages WHERE workspaceId=? AND itemId=?', wid, data.itemId)) throw new HttpError(409, 'Task is already linked to a document')
      await db.run('INSERT INTO document_pages(workspaceId,documentId,itemId,position,createdAt) VALUES (?,?,?,?,?)', wid, documentId, data.itemId, data.position, now())
      await audit(userId, wid, 'document.page.link', data.itemId, { documentId, position: data.position })
      return { documentId, itemId: data.itemId, position: data.position }
    })
  },

  async unlinkPage(userId: string, wid: string, documentId: string, itemId: string) {
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:write')
      await requirePermission(userId, wid, 'items:read')
      const result = await db.run('DELETE FROM document_pages WHERE workspaceId=? AND documentId=? AND itemId=?', wid, id.parse(documentId), id.parse(itemId))
      if (!result.changes) throw new HttpError(404, 'Document page not found')
      await audit(userId, wid, 'document.page.unlink', itemId, { documentId })
      return { success: true }
    })
  },

  async listComments(userId: string, wid: string, documentId: string): Promise<(Omit<Comment, 'itemId'> & { documentId: string })[]> {
    await requirePermission(userId, wid, 'documents:read')
    await documentInWorkspace(wid, documentId)
    const comments = await db.all<DocumentCommentRow>(`SELECT c.*,CASE WHEN c.authorId IS NULL THEN 'Former member' ELSE COALESCE(u.name,'Former member') END AS authorName
      FROM document_comments c LEFT JOIN users u ON u.id=c.authorId WHERE c.workspaceId=? AND c.documentId=? ORDER BY c.createdAt,c.id`, wid, documentId)
    const reactions = await listReactions(userId, wid, documentId)
    return comments.map((row) => ({
      id: row.id, workspaceId: row.workspaceId, documentId: row.documentId, authorId: row.authorId, authorName: row.authorName,
      body: row.deletedAt ? '' : row.body, parentId: row.parentId, anchor: decodeAnchor(row), reactions: reactions.get(row.id) ?? [],
      createdAt: row.createdAt, deletedAt: row.deletedAt,
    }))
  },

  async createComment(userId: string, wid: string, documentId: string, input: unknown) {
    const data = z.object({ body: commentBody, parentId: id.nullable().optional(), anchor: commentAnchorSchema.optional() }).strict()
      .refine((value) => !value.parentId || value.anchor === undefined, 'Replies inherit the root comment anchor').parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:read')
      await requirePermission(userId, wid, 'comments:create')
      await db.get(`SELECT id FROM documents WHERE workspaceId=? AND id=? ${db.sql({ pg: 'FOR UPDATE', sqlite: '' })}`, wid, documentId)
      const document = await documentInWorkspace(wid, documentId)
      const parentId = data.parentId ?? null
      if (parentId) {
        const parent = (await db.get<{ depth: number | null }>(`WITH RECURSIVE lineage(id,parentId,depth) AS (
          SELECT id,parentId,1 FROM document_comments WHERE workspaceId=? AND documentId=? AND id=?
          UNION ALL SELECT c.id,c.parentId,l.depth+1 FROM document_comments c JOIN lineage l ON c.id=l.parentId
          WHERE c.workspaceId=? AND c.documentId=? AND l.depth<33) SELECT max(depth) AS depth FROM lineage`, wid, documentId, parentId, wid, documentId))!
        if (parent.depth === null) throw new HttpError(404, 'Parent comment not found')
        if (parent.depth >= 32) throw new HttpError(400, 'Comment reply depth cannot exceed 32')
      }
      const anchor = data.anchor ? validateAnchor(document.body, document.bodyRevision, data.anchor) : null
      const comment = { id: randomUUID(), workspaceId: wid, documentId, authorId: userId, body: data.body, parentId, createdAt: now(), deletedAt: null, ...anchorColumns(anchor) }
      await db.run(`INSERT INTO document_comments(id,workspaceId,documentId,authorId,body,parentId,createdAt,anchorRevision,anchorStart,anchorEnd,anchorExact,anchorPrefix,anchorSuffix,anchorState)
        VALUES (@id,@workspaceId,@documentId,@authorId,@body,@parentId,@createdAt,@anchorRevision,@anchorStart,@anchorEnd,@anchorExact,@anchorPrefix,@anchorSuffix,@anchorState)`, comment)
      await audit(userId, wid, 'document.comment.create', comment.id, { documentId, parentId, anchored: anchor !== null })
      const author = (await db.get<{ name: string }>('SELECT name FROM users WHERE id=?', userId))!
      return {
        id: comment.id, workspaceId: comment.workspaceId, documentId: comment.documentId, authorId: comment.authorId, authorName: author.name,
        body: comment.body, parentId: comment.parentId, anchor, reactions: [], createdAt: comment.createdAt, deletedAt: comment.deletedAt,
      }
    })
  },

  async deleteComment(userId: string, wid: string, documentId: string, commentId: string) {
    return db.transaction(async () => {
      const member = await requirePermission(userId, wid, 'documents:read')
      await documentInWorkspace(wid, documentId)
      const comment = await db.get<{ authorId: string | null; parentId: string | null; deletedAt: string | null }>('SELECT authorId,parentId,deletedAt FROM document_comments WHERE workspaceId=? AND documentId=? AND id=?', wid, documentId, id.parse(commentId))
      if (!comment) throw new HttpError(404, 'Comment not found')
      if (comment.deletedAt) {
        if (!member.permissions.includes('comments:manage')) throw new HttpError(403, 'Comments manager required to remove a deleted entry')
        await db.run('UPDATE document_comments SET parentId=? WHERE workspaceId=? AND documentId=? AND parentId=?', comment.parentId, wid, documentId, commentId)
        await db.run('DELETE FROM document_comments WHERE workspaceId=? AND documentId=? AND id=?', wid, documentId, commentId)
        await audit(userId, wid, 'document.comment.purge', commentId, { documentId })
      } else {
        if (comment.authorId !== userId && !member.permissions.includes('comments:manage')) throw new HttpError(403, 'Comment author or comments manager required')
        await db.run("UPDATE document_comments SET body='[deleted]',deletedAt=? WHERE workspaceId=? AND documentId=? AND id=?", now(), wid, documentId, commentId)
        await audit(userId, wid, 'document.comment.delete', commentId, { documentId, own: comment.authorId === userId })
      }
      return { success: true }
    })
  },

  async updateCommentReaction(userId: string, wid: string, documentId: string, commentId: string, input: unknown) {
    const data = z.object({ emoji: reactionEmoji, active: z.boolean() }).strict().parse(input)
    return db.transaction(async () => {
      await requirePermission(userId, wid, 'documents:read')
      await requirePermission(userId, wid, 'comments:create')
      const comment = await db.get<{ deletedAt: string | null }>('SELECT deletedAt FROM document_comments WHERE workspaceId=? AND documentId=? AND id=?', wid, documentId, id.parse(commentId))
      if (!comment) throw new HttpError(404, 'Comment not found')
      if (comment.deletedAt) throw new HttpError(409, 'Deleted comments cannot receive reactions')
      const result = data.active
        ? await db.run('INSERT INTO document_comment_reactions(workspaceId,documentId,commentId,userId,emoji,createdAt) VALUES (?,?,?,?,?,?) ON CONFLICT(workspaceId,documentId,commentId,userId,emoji) DO NOTHING', wid, documentId, commentId, userId, data.emoji, now())
        : await db.run('DELETE FROM document_comment_reactions WHERE workspaceId=? AND documentId=? AND commentId=? AND userId=? AND emoji=?', wid, documentId, commentId, userId, data.emoji)
      if (result.changes) await audit(userId, wid, data.active ? 'document.comment.reaction.add' : 'document.comment.reaction.remove', commentId, { documentId, emoji: data.emoji })
      const count = Number((await db.get<{ count: number | string }>('SELECT count(*) AS count FROM document_comment_reactions WHERE workspaceId=? AND documentId=? AND commentId=? AND emoji=?', wid, documentId, commentId, data.emoji))!.count)
      return { emoji: data.emoji, active: data.active, count }
    })
  },
}
