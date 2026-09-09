import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = readdirSync(new URL('.', import.meta.url))
  .filter((file) => file.endsWith('.test.ts'))
  .sort()

let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'tests/runner.ts', ...process.argv.slice(2)], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOPYA_JAPA_FILE: `tests/${file}` },
    stdio: 'inherit',
  })
  if (result.status !== 0) failed = true
}

if (failed) process.exitCode = 1
