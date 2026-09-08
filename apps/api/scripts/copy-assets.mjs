import { cpSync } from 'node:fs'
cpSync(new URL('../database', import.meta.url), new URL('../build/database', import.meta.url), { recursive: true })
