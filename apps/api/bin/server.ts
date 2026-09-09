import 'reflect-metadata'
import { Ignitor } from '@adonisjs/core'
import { existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const projectRoot = root.pathname.endsWith('/build/') ? new URL('../', root) : root
for (const path of [new URL('../../.env', projectRoot), new URL('.env', projectRoot)]) {
  if (existsSync(path)) process.loadEnvFile(path)
}
process.env.PORT = process.env.API_PORT || '3333'
process.env.HOST ||= '127.0.0.1'
new Ignitor(root, { importer: (filePath) => import(filePath.startsWith('.') ? new URL(filePath, root).href : filePath) })
  .tap((app) => {
    app.listen('SIGTERM', () => app.terminate())
    app.listen('SIGINT', () => app.terminate())
  })
  .httpServer()
  .start()
  .catch((error: unknown) => { console.error(error); process.exitCode = 1 })
