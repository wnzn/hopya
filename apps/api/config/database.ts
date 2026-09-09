import { defineConfig } from '@adonisjs/lucid'
import { join } from 'node:path'
import { dataDir } from '../app/settings.js'

const connection = process.env.DB_CONNECTION || 'sqlite'

const dbConfig = defineConfig({
  connection,
  connections: {
    sqlite: {
      client: 'better-sqlite3',
      connection: {
        filename: join(dataDir, 'hopya.sqlite'),
      },
      useNullAsDefault: true,
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
      schemaGeneration: { enabled: false },
    },
    pg: {
      client: 'pg',
      connection: process.env.DATABASE_URL,
      pool: { min: 1, max: 10 },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
      schemaGeneration: { enabled: false },
    },
  },
})

export default dbConfig