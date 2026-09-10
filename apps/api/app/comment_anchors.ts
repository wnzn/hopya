import { z } from 'zod'
import { db } from './database.js'
import { HttpError, type CommentAnchor } from './types.js'

export const commentAnchorSchema = z.object({
  revision: z.number().int().min(1),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  exact: z.string().min(1).max(2000),
  prefix: z.string().max(200).default(''),
  suffix: z.string().max(200).default(''),
}).strict().refine((anchor) => anchor.end > anchor.start, 'Anchor end must follow its start')

export function validateAnchor(source: string, revision: number, input: z.output<typeof commentAnchorSchema>): CommentAnchor {
  if (input.revision !== revision) throw new HttpError(409, 'Body changed; select the text again')
  if (source.slice(input.start, input.end) !== input.exact) throw new HttpError(409, 'Selected text no longer matches the saved body')
  if (input.prefix && source.slice(Math.max(0, input.start - input.prefix.length), input.start) !== input.prefix) throw new HttpError(409, 'Selected text context changed')
  if (input.suffix && source.slice(input.end, input.end + input.suffix.length) !== input.suffix) throw new HttpError(409, 'Selected text context changed')
  return { ...input, state: 'attached' }
}

export function anchorColumns(anchor: CommentAnchor | null) {
  return anchor ? {
    anchorRevision: anchor.revision, anchorStart: anchor.start, anchorEnd: anchor.end,
    anchorExact: anchor.exact, anchorPrefix: anchor.prefix, anchorSuffix: anchor.suffix, anchorState: anchor.state,
  } : { anchorRevision: null, anchorStart: null, anchorEnd: null, anchorExact: null, anchorPrefix: null, anchorSuffix: null, anchorState: null }
}

export function decodeAnchor(row: Record<string, unknown>): CommentAnchor | null {
  if (row.anchorRevision === null || row.anchorRevision === undefined) return null
  return {
    revision: Number(row.anchorRevision), start: Number(row.anchorStart), end: Number(row.anchorEnd),
    exact: String(row.anchorExact), prefix: String(row.anchorPrefix ?? ''), suffix: String(row.anchorSuffix ?? ''),
    state: row.anchorState === 'orphaned' ? 'orphaned' : 'attached',
  }
}

export async function relocateAnchors(table: 'comments' | 'document_comments', targetColumn: 'itemId' | 'documentId', wid: string, targetId: string, source: string, revision: number) {
  const rows = await db.all<{ id: string; anchorExact: string; anchorPrefix: string; anchorSuffix: string }>(
    `SELECT id,anchorExact,anchorPrefix,anchorSuffix FROM ${table} WHERE workspaceId=? AND ${targetColumn}=? AND anchorRevision IS NOT NULL`, wid, targetId)
  for (const row of rows) {
    const matches: number[] = []
    let at = source.indexOf(row.anchorExact)
    while (at !== -1 && matches.length < 2) {
      const prefixMatches = !row.anchorPrefix || source.slice(Math.max(0, at - row.anchorPrefix.length), at) === row.anchorPrefix
      const end = at + row.anchorExact.length
      const suffixMatches = !row.anchorSuffix || source.slice(end, end + row.anchorSuffix.length) === row.anchorSuffix
      if (prefixMatches && suffixMatches) matches.push(at)
      at = source.indexOf(row.anchorExact, at + 1)
    }
    if (matches.length === 1) {
      await db.run(`UPDATE ${table} SET anchorRevision=?,anchorStart=?,anchorEnd=?,anchorState='attached' WHERE workspaceId=? AND ${targetColumn}=? AND id=?`,
        revision, matches[0], matches[0] + row.anchorExact.length, wid, targetId, row.id)
    } else {
      await db.run(`UPDATE ${table} SET anchorRevision=?,anchorState='orphaned' WHERE workspaceId=? AND ${targetColumn}=? AND id=?`, revision, wid, targetId, row.id)
    }
  }
}
