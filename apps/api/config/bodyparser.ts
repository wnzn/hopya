import { defineConfig } from '@adonisjs/core/bodyparser'
export default defineConfig({
  allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  json: { limit: '15mb', strict: true, convertEmptyStringsToNull: false, types: ['application/json', 'application/*+json'] },
  form: { limit: '1mb', types: ['application/x-www-form-urlencoded'] },
  raw: { limit: '1mb', types: ['text/*'] },
  multipart: { autoProcess: false, processManually: ['*'], limit: '20mb', types: ['multipart/form-data'] },
})
