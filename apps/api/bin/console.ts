import 'reflect-metadata'
import { existsSync } from 'node:fs'
import { Ignitor, prettyPrintError } from '@adonisjs/core'

const APP_ROOT = new URL('../', import.meta.url)
const PROJECT_ROOT = APP_ROOT.pathname.endsWith('/build/') ? new URL('../', APP_ROOT) : APP_ROOT

for (const path of [new URL('../../.env', PROJECT_ROOT), new URL('.env', PROJECT_ROOT)]) {
  if (existsSync(path)) process.loadEnvFile(path)
}

const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .ace()
  .handle(process.argv.splice(2))
  .catch((error) => {
    process.exitCode = 1
    prettyPrintError(error)
  })
