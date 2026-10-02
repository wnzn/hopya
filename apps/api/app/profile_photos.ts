import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { z } from 'zod'
import { audit, db } from './database.js'
import { authenticate } from './security.js'
import { HttpError } from './types.js'
import { rasterContentType } from './rich_text_images.js'
import { profilePhotoMetadata, profilePhotoUrl } from './profile_photo_metadata.js'

const maxBytes = 512 * 1024
const input = z.object({ contentType: z.string().max(127), data: z.string().min(1).max(Math.ceil(maxBytes / 3) * 4) }).strict()
const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
const visiblePhoto = `FROM profile_photos p JOIN users u ON u.id=p.userId AND u.disabled=0
  JOIN users viewer ON viewer.id=? AND viewer.disabled=0 WHERE p.userId=?
  AND (viewer.id=p.userId OR viewer.isAdmin=1 OR EXISTS (SELECT 1 FROM memberships mine JOIN memberships subject ON subject.workspaceId=mine.workspaceId
    WHERE mine.userId=viewer.id AND subject.userId=p.userId))`

export const profilePhotos = {
  async me(ctx: HttpContext) {
    const user = await authenticate(ctx)
    return { ...user, ...await profilePhotoMetadata(user.id) }
  },

  async put(ctx: HttpContext) {
    const user = await authenticate(ctx)
    const data = input.parse(ctx.request.body())
    if (!allowedTypes.has(data.contentType)) throw new HttpError(415, 'Use a PNG, JPEG or WebP profile photo')
    const bytes = Buffer.from(data.data, 'base64')
    if (!bytes.length || bytes.toString('base64') !== data.data) throw new HttpError(400, 'Invalid base64 photo data')
    if (bytes.length > maxBytes) throw new HttpError(413, 'Profile photos must be at most 512 KiB')
    let contentType: string
    try { contentType = rasterContentType(bytes) }
    catch (cause) {
      if (cause instanceof HttpError && cause.status === 415) throw new HttpError(415, 'Use a valid PNG, JPEG or WebP profile photo')
      throw cause
    }
    if (!allowedTypes.has(contentType) || contentType !== data.contentType) throw new HttpError(415, 'Photo bytes do not match the declared image type')
    return db.transaction(async () => {
      const current = await authenticate(ctx)
      if (current.id !== user.id) throw new HttpError(401, 'Authentication required')
      const revision = randomUUID()
      await db.run(`INSERT INTO profile_photos(userId,revision,contentType,bytes,size,updatedAt) VALUES (?,?,?,?,?,?)
        ON CONFLICT(userId) DO UPDATE SET revision=excluded.revision,contentType=excluded.contentType,bytes=excluded.bytes,size=excluded.size,updatedAt=excluded.updatedAt`,
      user.id, revision, contentType, bytes, bytes.length, new Date().toISOString())
      await audit(user.id, null, 'user.photo.update', user.id, { contentType, size: bytes.length })
      return { photoUrl: profilePhotoUrl(user.id, revision) }
    })
  },

  async remove(ctx: HttpContext) {
    const user = await authenticate(ctx)
    return db.transaction(async () => {
      const current = await authenticate(ctx)
      if (current.id !== user.id) throw new HttpError(401, 'Authentication required')
      const removed = await db.run('DELETE FROM profile_photos WHERE userId=?', user.id)
      if (removed.changes) await audit(user.id, null, 'user.photo.delete', user.id, { removed: removed.changes })
      return { photoUrl: null }
    })
  },

  async get(ctx: HttpContext) {
    const user = await authenticate(ctx)
    const userId = z.string().uuid().parse(ctx.params.id)
    const { v } = z.object({ v: z.string().uuid().optional() }).strict().parse(ctx.request.qs())
    // Existence and an opaque revision never authorize a read. Check current shared membership.
    const photo = await db.get<{ bytes: Buffer; contentType: string; revision: string }>(`SELECT p.bytes,p.contentType,p.revision ${visiblePhoto} ${v ? 'AND p.revision=?' : ''}`,
      user.id, userId, ...(v ? [v] : []))
    if (!photo) throw new HttpError(404, 'Profile photo not found')
    const current = await authenticate(ctx)
    if (!await db.get(`SELECT p.userId ${visiblePhoto} AND p.revision=?`, current.id, userId, photo.revision)) throw new HttpError(404, 'Profile photo not found')
    ctx.response.header('Cache-Control', 'private, no-store')
    ctx.response.header('X-Content-Type-Options', 'nosniff')
    ctx.response.header('Cross-Origin-Resource-Policy', 'same-origin')
    ctx.response.header('Content-Security-Policy', "default-src 'none'; sandbox")
    ctx.response.header('Content-Disposition', 'inline')
    return ctx.response.type(photo.contentType).send(photo.bytes)
  },
}
