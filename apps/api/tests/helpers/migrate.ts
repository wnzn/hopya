import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Run the official Lucid Ace command against the test's configured database. */
export function migrateDatabase(): void {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url))
  const result = spawnSync(process.execPath, ['ace.js', 'migration:run', '--no-schema-generate', '--compact-output'], {
    cwd: appRoot,
    env: process.env,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'node ace migration:run failed')
}
