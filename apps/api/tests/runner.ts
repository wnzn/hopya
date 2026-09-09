import { assert } from '@japa/assert'
import { configure, processCLIArgs, run } from '@japa/runner'
import { fileURLToPath } from 'node:url'
import { runFileCleanups } from './japa.js'

const file = process.env.HOPYA_JAPA_FILE
if (!file) throw new Error('HOPYA_JAPA_FILE is required')

processCLIArgs(process.argv.slice(2))
configure({
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  files: [file],
  plugins: [assert()],
  reporters: { activated: ['spec'] },
  teardown: [async () => runFileCleanups()],
})

await run()
