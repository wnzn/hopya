import { cpSync } from 'node:fs'
cpSync(new URL('../database/migrations/legacy', import.meta.url), new URL('../build/database/migrations/legacy', import.meta.url), { recursive: true })
