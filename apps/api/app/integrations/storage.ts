import type { Router, HttpContext } from '@adonisjs/core/http'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { Effect } from 'effect'
import { constants } from 'node:fs'
import { mkdir, lstat, chmod, open, unlink } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { authenticate, requirePermission, service, db, audit, HttpError, type Permission } from '../core.js'
import { runPromiseThrow } from '../database.js'
import { dataDir } from '../settings.js'

const maxBytes = 10 * 1024 * 1024
const objectDirectory = join(dataDir, 'objects')
const uploadSchema = z.object({
  name: z.string().trim().min(1).max(255).refine((name) => !/[\x00-\x1f\x7f/\\]/.test(name) && name !== '.' && name !== '..' && Buffer.from(name).toString('utf8') === name, 'Invalid filename'),
  contentType: z.string().max(127).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  data: z.string().max(4 * Math.ceil(maxBytes / 3)),
}).strict()
interface StoredObject { objectKey: string; driver: 'filesystem' | 's3'; location: string; createdAt: string }
interface Attachment extends StoredObject { id: string; workspaceId: string; itemId: string; name: string; contentType: string; size: number }
const metadata = ({ id, name, size, contentType, createdAt }: Attachment) => ({ id, name, size, contentType, createdAt })

// --- Typed storage failures (Effect values, mapped at the route boundary) ---
// Every failure below surfaces as the same HttpError status/message the routes
// have always returned; the classes only let the pipeline compose without
// try/catch. Messages are part of the contract tests, so keep them verbatim.
class StorageUnavailable { readonly _tag = 'StorageUnavailable'; constructor(readonly message = 'Attachment storage unavailable') {} }
class StorageMisconfigured { readonly _tag = 'StorageMisconfigured'; constructor(readonly message = 'Attachment storage is not configured') {} }
class InvalidObjectKey { readonly _tag = 'InvalidObjectKey'; constructor(readonly message = 'Invalid stored object key') {} }
type StorageFailure = StorageUnavailable | StorageMisconfigured | InvalidObjectKey

const storageHttpError = (failure: StorageFailure): HttpError => new HttpError(503, failure.message)
const runStorage = <A>(effect: Effect.Effect<A, StorageFailure>): Promise<A> =>
  runPromiseThrow(Effect.mapError(effect, storageHttpError))

type Backend =
  | { driver: 'filesystem'; location: string; client: undefined; bucket: undefined }
  | { driver: 's3'; location: string; client: S3Client; bucket: string }

// Backend selection as an Effect so put/get/delete/GC compose it instead of
// branching on thrown errors. Sync callers keep working via backend() below.
const resolveBackendEffect = (): Effect.Effect<Backend, StorageMisconfigured> => Effect.gen(function* () {
  const driver = process.env.STORAGE_DRIVER || 'filesystem'
  if (driver === 'filesystem') return { driver, location: 'objects', client: undefined, bucket: undefined } as const
  if (driver !== 's3' || !process.env.S3_BUCKET || !process.env.S3_REGION) return yield* Effect.fail(new StorageMisconfigured())
  const endpoint = process.env.S3_ENDPOINT
  if (endpoint) {
    let url: URL
    try { url = new URL(endpoint) } catch { return yield* Effect.fail(new StorageMisconfigured()) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return yield* Effect.fail(new StorageMisconfigured())
  }
  const bucket = process.env.S3_BUCKET
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true'
  // No explicit credentials or ACL: use the SDK credential chain and an operator-private bucket.
  const client = new S3Client({ region: process.env.S3_REGION, endpoint, forcePathStyle, maxAttempts: 2 })
  const location = createHash('sha256').update(JSON.stringify([bucket, process.env.S3_REGION, endpoint || '', forcePathStyle])).digest('hex')
  return { driver, location, client, bucket } as const
})

function backend(): Backend {
  const result = Effect.runSync(Effect.either(resolveBackendEffect()))
  if (result._tag === 'Left') throw new HttpError(503, result.left.message)
  return result.right
}

const validateObjectKeyEffect = (objectKey: string): Effect.Effect<void, InvalidObjectKey> =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(objectKey)
    ? Effect.void
    : Effect.fail(new InvalidObjectKey())

const filesystemObjectEffect = (object: StoredObject, operation: 'put' | 'get' | 'delete', bytes?: Buffer): Effect.Effect<Buffer, StorageUnavailable> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(objectDirectory, { recursive: true, mode: 0o700 })
      const directory = await lstat(objectDirectory)
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid object directory')
      await chmod(objectDirectory, 0o700)
      const path = join(objectDirectory, object.objectKey)
      if (operation === 'delete') {
        try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      } else {
        const flags = operation === 'put' ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        const file = await open(path, flags, 0o600)
        try {
          if (operation === 'put') { await file.writeFile(bytes!); await file.sync() }
          else {
            const stat = await file.stat()
            if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid stored object')
            const buffer = Buffer.alloc(stat.size)
            let offset = 0
            while (offset < buffer.length) {
              const result = await file.read(buffer, offset, buffer.length - offset, offset)
              if (!result.bytesRead) throw new Error('Truncated stored object')
              offset += result.bytesRead
            }
            return buffer
          }
        } finally { await file.close() }
      }
      return Buffer.alloc(0)
    },
    catch: () => new StorageUnavailable(),
  })

const s3ObjectEffect = (client: S3Client, bucket: string, object: StoredObject, operation: 'put' | 'get' | 'delete', bytes?: Buffer): Effect.Effect<Buffer, StorageUnavailable> =>
  Effect.tryPromise({
    try: async () => {
      const input = { Bucket: bucket, Key: object.objectKey }
      const options = { abortSignal: AbortSignal.timeout(30000) }
      if (operation === 'put') await client.send(new PutObjectCommand({ ...input, Body: bytes, ContentType: 'application/octet-stream', IfNoneMatch: '*' }), options)
      else if (operation === 'delete') await client.send(new DeleteObjectCommand(input), options)
      else {
        const result = await client.send(new GetObjectCommand(input), options)
        if (!result.Body) throw new Error('Missing object body')
        const chunks: Buffer[] = []
        let size = 0
        // Bound actual streamed bytes, not only the untrusted Content-Length header.
        for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
          size += chunk.byteLength
          if (size > maxBytes) throw new Error('Oversized stored object')
          chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
      }
      return Buffer.alloc(0)
    },
    catch: () => new StorageUnavailable(),
  })

// Backend resolution, key validation and the put/get/delete branches composed
// as one Effect.gen pipeline. The S3 client is released via ensuring, and a
// backend switch mid-flight maps to the same 503 the old guard produced.
const objectOperationEffect = (object: StoredObject, operation: 'put' | 'get' | 'delete', bytes?: Buffer): Effect.Effect<Buffer, StorageFailure> =>
  Effect.gen(function* () {
    yield* validateObjectKeyEffect(object.objectKey)
    const store = yield* Effect.mapError(
      resolveBackendEffect(),
      (): StorageFailure => new StorageUnavailable(),
    )
    const guarded = Effect.gen(function* () {
      if (object.driver !== store.driver || object.location !== store.location) return yield* Effect.fail(new StorageUnavailable())
      return yield* (store.driver === 's3'
        ? s3ObjectEffect(store.client, store.bucket, object, operation, bytes)
        : filesystemObjectEffect(object, operation, bytes))
    })
    return yield* Effect.ensuring(guarded, Effect.sync(() => store.client?.destroy()))
  })

async function objectOperation(object: StoredObject, operation: 'put' | 'get' | 'delete', bytes?: Buffer): Promise<Buffer> {
  return runStorage(objectOperationEffect(object, operation, bytes))
}

async function authorize(ctx: HttpContext, permission: Permission) {
  const user = await authenticate(ctx)
  const { wid, id } = z.object({ wid: z.string().uuid(), id: z.string().uuid() }).parse(ctx.params)
  await requirePermission(user.id, wid, permission)
  await service.getItem(user.id, wid, id)
  return user
}
async function attachment(ctx: HttpContext): Promise<Attachment> {
  const id = z.string().uuid().parse(ctx.params.attachmentId)
  const row = await db.get(`SELECT a.*,o.driver,o.location FROM attachments a JOIN storage_objects o ON o.objectKey=a.objectKey
    WHERE a.workspaceId=? AND a.itemId=? AND a.id=?`, ctx.params.wid, ctx.params.id, id) as Attachment | undefined
  if (!row) throw new HttpError(404, 'Attachment not found')
  return row
}

/** Operator-only hook: run regularly on the single API replica, with the same DATA_DIR
 * and storage env. No public route. Repeat while scanned === 100 and deleted > 0;
 * investigate failed objects rather than spinning indefinitely. An object ledger
 * survives item cascades and remote failures; unknown pre-ledger objects need an
 * offline inventory. Keep old backend settings available when changing storage. */
export async function collectStorageGarbage(): Promise<{ scanned: number; deleted: number; failed: number }> {
  const store = backend()
  store.client?.destroy()
  const rows = await db.all(`SELECT o.* FROM storage_objects o WHERE o.driver=? AND o.location=? AND o.createdAt<?
    AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.objectKey=o.objectKey) ORDER BY o.createdAt LIMIT 100`,
    store.driver, store.location, new Date(Date.now() - 86400000).toISOString()) as unknown as StoredObject[]
  // Each row is its own Effect that can only resolve to counted outcomes, so a
  // failed DELETE can never reject the collection. Sequential (concurrency 1)
  // preserves single-writer SQLite semantics on the shared connection.
  const collectRow = (row: StoredObject): Effect.Effect<'deleted' | 'failed', never> =>
    Effect.catchAll(
      Effect.gen(function* () {
        yield* Effect.tryPromise({
          try: () => objectOperation(row, 'delete'),
          catch: (error) => error as unknown,
        })
        yield* Effect.promise(() => db.run('DELETE FROM storage_objects WHERE objectKey=? AND NOT EXISTS (SELECT 1 FROM attachments WHERE objectKey=?)', row.objectKey, row.objectKey))
        return 'deleted' as const
      }),
      () => Effect.succeed('failed' as const),
    )
  const outcomes = await Effect.runPromise(Effect.forEach(rows, collectRow, { concurrency: 1 }))
  return { scanned: rows.length, deleted: outcomes.filter((outcome) => outcome === 'deleted').length, failed: outcomes.filter((outcome) => outcome === 'failed').length }
}

export function registerStorage(router: Router): void {
  const path = '/api/v1/workspaces/:wid/items/:id/attachments'
  router.get(path, async (ctx) => {
    await authorize(ctx, 'items:read')
    return db.all('SELECT id,name,size,contentType,createdAt FROM attachments WHERE workspaceId=? AND itemId=? ORDER BY createdAt,id', ctx.params.wid, ctx.params.id)
  })
  router.post(path, async (ctx) => {
    const user = await authorize(ctx, 'items:write')
    const data = uploadSchema.parse(ctx.request.body())
    const bytes = Buffer.from(data.data, 'base64')
    if (bytes.length > maxBytes) throw new HttpError(413, 'Attachment exceeds 10 MiB')
    if (bytes.toString('base64') !== data.data) throw new HttpError(400, 'Invalid base64 attachment data')
    const store = backend()
    store.client?.destroy()
    const row: Attachment = { id: randomUUID(), objectKey: randomUUID(), driver: store.driver, location: store.location,
      workspaceId: ctx.params.wid, itemId: ctx.params.id, name: data.name, size: bytes.length, contentType: data.contentType, createdAt: new Date().toISOString() }
    await db.transaction(async () => {
      await db.run('INSERT INTO storage_objects (objectKey,driver,location,createdAt) VALUES (@objectKey,@driver,@location,@createdAt)', row)
      await audit(user.id, row.workspaceId, 'attachment.upload.start', row.id)
    })
    let uploaded = false
    try {
      await objectOperation(row, 'put', bytes)
      uploaded = true
      await db.transaction(async () => {
        await authorize(ctx, 'items:write')
        if (Date.now() - Date.parse(row.createdAt) >= 86400000) throw new HttpError(503, 'Attachment upload expired')
        await db.run(`INSERT INTO attachments (id,workspaceId,itemId,objectKey,name,contentType,size,createdBy,createdAt)
          VALUES (@id,@workspaceId,@itemId,@objectKey,@name,@contentType,@size,@createdBy,@createdAt)`, { ...row, createdBy: user.id })
        await audit(user.id, row.workspaceId, 'attachment.create', row.id, { size: row.size })
      })
    } catch (error) {
      try {
        await objectOperation(row, 'delete')
        // A failed remote PUT may still finish after compensation. Keep its
        // ledger until the grace-period collector issues another DELETE.
        if (uploaded) await db.run('DELETE FROM storage_objects WHERE objectKey=?', row.objectKey)
      } catch { /* Durable ledger lets the collector retry failed compensation. */ }
      throw error
    }
    ctx.response.status(201)
    return metadata(row)
  })
  router.get(`${path}/:attachmentId`, async (ctx) => {
    await authorize(ctx, 'items:read')
    const row = await attachment(ctx)
    const bytes = await objectOperation(row, 'get')
    await authorize(ctx, 'items:read')
    if ((await attachment(ctx)).objectKey !== row.objectKey || bytes.length !== row.size) throw new HttpError(503, 'Attachment storage unavailable')
    const encoded = encodeURIComponent(row.name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    ctx.response.header('Content-Type', 'application/octet-stream')
    ctx.response.header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encoded}`)
    ctx.response.header('X-Content-Type-Options', 'nosniff')
    ctx.response.header('Cache-Control', 'private, no-store')
    ctx.response.send(bytes)
  })
  router.delete(`${path}/:attachmentId`, async (ctx) => {
    const user = await authorize(ctx, 'items:delete')
    const row = await attachment(ctx)
    // Revoke access atomically first. Physical deletion can safely be retried by GC.
    await db.transaction(async () => {
      await db.run('DELETE FROM attachments WHERE id=? AND workspaceId=? AND itemId=?', row.id, ctx.params.wid, ctx.params.id)
      await audit(user.id, row.workspaceId, 'attachment.delete', row.id)
    })
    let cleanupPending = false
    try {
      await objectOperation(row, 'delete')
      await db.run('DELETE FROM storage_objects WHERE objectKey=?', row.objectKey)
    } catch { cleanupPending = true }
    await authorize(ctx, 'items:delete')
    return { success: true, cleanupPending }
  })
}
