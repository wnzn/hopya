import { db, audit } from './database.js'
import { HttpError } from './types.js'

export type ImageKind = 'task-body' | 'task-comment' | 'document-comment'
export type ImageRow = Record<string, unknown> & {
  id: string; workspaceId: string; objectKey: string; kind: ImageKind; itemId: string | null; documentId: string | null
  commentId: string | null; documentCommentId: string | null; attachmentId: string | null; createdBy: string | null
  name: string; contentType: string; size: number; createdAt: string; expiresAt: string; committedAt: string | null
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const privateImage = new RegExp(`^/api/v1/workspaces/(${uuid})/images/(${uuid})/inline$`)
const attachmentImage = new RegExp(`^/api/v1/workspaces/(${uuid})/items/(${uuid})/attachments/(${uuid})/inline$`)

/** Called only inside the task/comment mutation transaction, after target authorization.
 * A failed body save (including its audit) leaves all pending uploads claimable.
 * URLs are identifiers, never authorization. Pending images belong to their uploader.
 */
export async function claimBodyImages(userId: string, wid: string, resourceId: string, kind: ImageKind, markdown: string, commentId?: string) {
  const source = markdown.replace(/^```[^\n]*\n[\s\S]*?(?:^```\s*$|$(?![\s\S]))/gm, '').replace(/`[^`\n]+`/g, '')
  const references = [...source.matchAll(/!\[(?:\\.|[^\]\\])*\]\(([^)\s]+)\)/g)]
  if (references.length > 100) throw new HttpError(400, 'A body may contain at most 100 images')
  const urls = [...new Set(references.map(match => match[1]))]
  for (const url of urls) {
    const attachment = url.match(attachmentImage)
    if (attachment) {
      if (kind === 'document-comment' || attachment[1] !== wid || attachment[2] !== resourceId ||
        !await db.get('SELECT id FROM attachments WHERE workspaceId=? AND itemId=? AND id=?', wid, resourceId, attachment[3])) {
        throw new HttpError(400, 'Image does not belong to this resource')
      }
      continue // Bytes are independently validated by the inline retrieval route.
    }
    const match = url.match(privateImage)
    if (!match) continue // Unsupported image URLs remain inert in the Markdown renderer.
    if (match[1] !== wid) throw new HttpError(400, 'Image does not belong to this workspace')
    const image = await db.get<ImageRow>(`SELECT * FROM rich_text_images WHERE workspaceId=? AND id=? ${db.sql({ pg: 'FOR UPDATE', sqlite: '' })}`, wid, match[2])
    if (!image) throw new HttpError(400, 'Image upload is unavailable; upload it again before saving')
    const targetId = kind === 'document-comment' ? image.documentId : image.itemId
    if (targetId !== resourceId && !(kind === 'task-body' && image.kind === kind && targetId === null)) throw new HttpError(400, 'Image does not belong to this resource')
    if (image.committedAt) {
      // References to a deleted comment must never be made live again by copying its URL.
      if (image.commentId && !await db.get('SELECT id FROM comments WHERE id=? AND deletedAt IS NULL', image.commentId) ||
        image.documentCommentId && !await db.get('SELECT id FROM document_comments WHERE id=? AND deletedAt IS NULL', image.documentCommentId)) {
        throw new HttpError(400, 'Image comment has been deleted')
      }
      continue
    }
    if (image.createdBy !== userId || image.kind !== kind) throw new HttpError(403, 'Image upload belongs to another draft')
    if (image.expiresAt <= new Date().toISOString()) throw new HttpError(409, 'Image upload expired; upload it again before saving')
    if (kind === 'task-body') {
      await db.run(`INSERT INTO attachments(id,workspaceId,itemId,objectKey,name,contentType,size,createdBy,createdAt)
        VALUES (?,?,?,?,?,?,?,?,?)`, image.id, wid, resourceId, image.objectKey, image.name, image.contentType, image.size, userId, image.createdAt)
    }
    await db.run(`UPDATE rich_text_images SET itemId=?,attachmentId=?,commentId=?,documentCommentId=?,committedAt=? WHERE workspaceId=? AND id=?`,
      kind === 'document-comment' ? null : resourceId, kind === 'task-body' ? image.id : null,
      kind === 'task-comment' ? commentId! : null, kind === 'document-comment' ? commentId! : null, new Date().toISOString(), wid, image.id)
    await audit(userId, wid, 'image.commit', image.id, { kind, resourceId, size: image.size })
  }
}

/** Type is derived from bytes, never filename or the client-supplied MIME type.
 * Explicit raster containers plus nosniff/sandbox prevent HTML/SVG/script delivery.
 * Bounds limit compressed-image dimensions; this is not an image transcoder.
 */
export function rasterContentType(bytes: Buffer): string {
  const reject = (): never => { throw new HttpError(415, 'Use a valid PNG, JPEG, GIF, or WebP image (up to 40 megapixels)') }
  const dimensions = (width: number, height: number) => { if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000) reject() }
  if (bytes.length < 14) return reject()
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let at = 8; let header = false; let data = false
    while (at + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(at); const tag = bytes.toString('ascii', at + 4, at + 8)
      if (length > bytes.length - at - 12) return reject()
      if (!header) {
        if (tag !== 'IHDR' || length !== 13) return reject()
        dimensions(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12)); header = true
      }
      if (tag === 'IDAT') data = true
      at += length + 12
      if (tag === 'IEND') return data && length === 0 && at === bytes.length ? 'image/png' : reject()
    }
    return reject()
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    return bytes.at(-1) === 0x3b ? 'image/gif' : reject()
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let at = 2; let frame = false
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 0xff) return reject()
      while (at < bytes.length && bytes[at] === 0xff) at++
      if (at + 3 > bytes.length) return reject()
      const marker = bytes[at++]; const length = bytes.readUInt16BE(at)
      if (length < 2 || at + length > bytes.length) return reject()
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) return reject()
        dimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3)); frame = true
      }
      if (marker === 0xda) return frame ? 'image/jpeg' : reject()
      at += length
    }
    return reject()
  }
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8) {
    const tag = bytes.toString('ascii', 12, 16)
    if (bytes.readUInt32LE(16) > bytes.length - 20) return reject()
    if (tag === 'VP8X') dimensions(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3))
    else if (tag === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 1, 0x2a]))) dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
    else if (tag === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21); dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    } else return reject()
    return 'image/webp'
  }
  return reject()
}
