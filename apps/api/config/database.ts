import { defineConfig } from '@adonisjs/lucid'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from '../app/settings.js'

const configuredConnection = process.env.DB_CONNECTION || 'sqlite'
if (configuredConnection !== 'sqlite' && configuredConnection !== 'pg') {
  throw new Error('DB_CONNECTION must be either sqlite or pg')
}
if (configuredConnection === 'pg' && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required when DB_CONNECTION=pg')
}
const connection: 'sqlite' | 'pg' = configuredConnection
if (connection === 'sqlite') mkdirSync(dataDir, { recursive: true, mode: 0o700 })

const dbConfig = defineConfig({
  connection,
  connections: {
    sqlite: {
      client: 'better-sqlite3',
      connection: {
        filename: join(dataDir, 'hopya.sqlite'),
      },
      useNullAsDefault: true,
      pool: {
        min: 1,
        max: 10,
        afterCreate(connection, done) {
          try {
            connection.pragma('journal_mode = WAL')
            connection.pragma('foreign_keys = ON')
            connection.pragma('busy_timeout = 5000')
            done(null, connection)
          } catch (error) {
            done(error, connection)
          }
        },
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
      schemaGeneration: { enabled: false },
    },
    pg: {
      client: 'pg',
      connection: process.env.DATABASE_URL!,
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
