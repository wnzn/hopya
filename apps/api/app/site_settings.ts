import { mkdir, writeFile, unlink, readFile, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { Router } from '@adonisjs/core/http'
import { Effect } from 'effect'
import { z } from 'zod'
import { db, audit, runPromiseThrow } from './database.js'
import { requireAdmin } from './accounts.js'
import { dataDir } from './settings.js'
import { HttpError, type User } from './types.js'
import { authenticate } from './security.js'

const brandDirectory = join(dataDir, 'branding')
const logoName = 'logo'
const allowedLogoTypes: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg',
}
const getSetting = (key: string): string | null =>
  (db.prepare('SELECT value FROM site_settings WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null
const setSetting = (key: string, value: string | null): void => {
  db.prepare('INSERT INTO site_settings (key,value,updatedAt) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt')
    .run(key, value, new Date().toISOString())
}

const logoMeta = (): { file: string; updatedAt: string } | null => {
  const file = getSetting('logoFile')
  return file ? { file, updatedAt: getSetting('logoUpdatedAt') ?? '' } : null
}
export function siteConfig() {
  const landing = process.env.LANDING_ENABLED !== 'false' && getSetting('landingDisabled') !== '1'
  const logo = logoMeta()
  return { landingEnabled: landing, ...(logo ? { logo: `/api/v1/site/logo?v=${encodeURIComponent(logo.updatedAt)}` } : {}) }
}

// --- Typed branding failures (Effect values, mapped at the route boundary) ---
// Missing logos stay 404s with the contract message. Validation bounds and
// cache headers below are unchanged; IO defects reject as before.
class LogoNotFound { readonly _tag = 'LogoNotFound'; constructor(readonly message = 'No custom logo') {} }
type BrandingFailure = LogoNotFound

const brandingHttpError = (failure: BrandingFailure): HttpError => new HttpError(404, failure.message)

// Logo resolution as an Effect: read the allowlisted setting, then validate the
// exact names PUT /site/logo writes; anything else is absent.
const requireLogoFileEffect = (): Effect.Effect<{ path: string; file: string }, LogoNotFound> => Effect.gen(function* () {
  const file = yield* Effect.sync(() => getSetting('logoFile'))
  // Allowlist of the exact names PUT /site/logo writes; anything else is absent.
  if (!file || !/^logo\.(png|jpg|webp|svg)$/.test(file)) return yield* Effect.fail(new LogoNotFound())
  return { path: join(brandDirectory, file), file }
})

function requireLogoFile(): { path: string; file: string } {
  const result = Effect.runSync(Effect.either(requireLogoFileEffect()))
  if (result._tag === 'Left') throw brandingHttpError(result.left)
  return result.right
}

// Branding file writes as an Effect.gen pipeline; defects reject with the same
// errors plain awaits would raise, so behavior is unchanged.
const writeLogoEffect = (file: string, bytes: Buffer): Effect.Effect<string, unknown> => Effect.gen(function* () {
  yield* Effect.tryPromise({
    try: () => mkdir(brandDirectory, { recursive: true, mode: 0o700 }),
    catch: (error) => error as unknown,
  })
  const target = join(brandDirectory, file)
  yield* Effect.tryPromise({
    try: () => writeFile(target, bytes, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode: 0o600 }),
    catch: (error) => error as unknown,
  })
  return target
})

export function registerSiteSettings(router: Router): void {
  router.group(() => {
    router.get('/site/logo', async (ctx) => {
      const { path, file } = requireLogoFile()
      const stat = await lstat(path)
      if (!stat.isFile()) throw new HttpError(404, 'No custom logo')
      ctx.response.header('Cache-Control', 'public, max-age=300')
      const type = Object.entries(allowedLogoTypes).find(([, extension]) => file.endsWith(extension))?.[0] ?? 'application/octet-stream'
      return ctx.response.type(type).send(await readFile(path))
    })
    router.get('/site/settings', (ctx) => {
      authenticate(ctx)
      requireAdmin(ctx)
      return {
        landingDisabled: getSetting('landingDisabled') === '1',
        logo: logoMeta() ? { updatedAt: getSetting('logoUpdatedAt') ?? '', url: `/api/v1/site/logo?v=${encodeURIComponent(getSetting('logoUpdatedAt') ?? '')}` } : null,
      }
    })
    router.patch('/site/settings', (ctx) => {
      const admin: User = requireAdmin(ctx)
      const data = z.object({ landingDisabled: z.boolean().optional() }).strict().parse(ctx.request.body())
      return db.transaction(() => {
        if (data.landingDisabled !== undefined) {
          setSetting('landingDisabled', data.landingDisabled ? '1' : null)
          audit(admin.id, null, 'site.settings.update', null, { landingDisabled: data.landingDisabled })
        }
        return { landingDisabled: getSetting('landingDisabled') === '1' }
      })()
    })
    router.put('/site/logo', async (ctx) => {
      const admin: User = requireAdmin(ctx)
      const data = z.object({
        contentType: z.string().max(127).refine((value) => value in allowedLogoTypes, 'Logo must be PNG, JPEG, WebP or SVG'),
        data: z.string().max(400 * 1024 / 3 * 4).refine((value) => {
          if (value.length > 300000) return false
          return Buffer.from(value, 'base64').toString('base64') === value.replace(/\s/g, '')
        }, 'Invalid base64'),
      }).strict().parse(ctx.request.body())
      const bytes = Buffer.from(data.data, 'base64')
      if (bytes.length > 300 * 1024) throw new HttpError(400, 'Logo must be at most 300 KB')
      const extension = allowedLogoTypes[data.contentType]!
      const file = `${logoName}.${extension}`
      await runPromiseThrow(writeLogoEffect(file, bytes))
      const updatedAt = new Date().toISOString()
      db.transaction(() => {
        setSetting('logoFile', file)
        setSetting('logoUpdatedAt', updatedAt)
        audit(admin.id, null, 'site.logo.update', null, { contentType: data.contentType, size: bytes.length })
      })()
      return { url: `/api/v1/site/logo?v=${encodeURIComponent(updatedAt)}`, updatedAt }
    })
    router.delete('/site/logo', async (ctx) => {
      const admin: User = requireAdmin(ctx)
      const previous = requireLogoFile()
      await unlink(previous.path).catch(() => {})
      db.transaction(() => {
        db.prepare('DELETE FROM site_settings WHERE key=? OR key=?').run('logoFile', 'logoUpdatedAt')
        audit(admin.id, null, 'site.logo.delete', null)
      })()
      return { success: true }
    })
  }).prefix('/api/v1')
}
