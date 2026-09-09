import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Ignitor } from '@adonisjs/core'
import type { ApplicationService } from '@adonisjs/core/types'

let app: ApplicationService | undefined

/** Run the official Lucid Ace command against the test's configured database. */
export function runMigrations(environment: NodeJS.ProcessEnv = process.env): void {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url))
  const result = spawnSync(process.execPath, ['ace.js', 'migration:run', '--no-schema-generate', '--compact-output', '--force'], {
    cwd: appRoot,
    env: environment,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'node ace migration:run failed')
}

export async function migrateDatabase(): Promise<void> {
  runMigrations()
  const root = new URL('../../', import.meta.url)
  app = new Ignitor(root, {
    importer: (filePath) => import(filePath.startsWith('.') ? new URL(filePath, root).href : filePath),
  }).createApp('test')
  await app.init()
  await app.boot()
}

export async function closeDatabase(): Promise<void> {
  if (!app) return
  await app.terminate()
  app = undefined
}
