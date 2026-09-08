import 'reflect-metadata'
import { Ignitor } from '@adonisjs/core'

const root = new URL(process.env.HOPYA_TEST_BUILD === 'true' ? '../build/' : '../', import.meta.url)
process.env.PORT = process.env.API_PORT
new Ignitor(root, { importer: (path) => import(path.startsWith('.') ? new URL(path, root).href : path) })
  .tap((app) => {
    app.listen('SIGTERM', () => app.terminate())
    app.terminating(async () => { const { db } = await import(new URL('app/database.js', root).href); db.close() })
  })
  .httpServer().start()
  .catch((error: unknown) => { console.error(error); process.exitCode = 1 })
