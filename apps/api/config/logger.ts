import { defineConfig } from '@adonisjs/core/logger'
export default defineConfig({ default: 'app', loggers: { app: { enabled: true, name: 'hopya', level: process.env.LOG_LEVEL || 'info' } } })
