import { defineConfig, drivers } from '@adonisjs/core/encryption'
import { appKey } from '../app/settings.js'

// Preserve signed sessions issued by Adonis 6 with the same operator APP_KEY.
export default defineConfig({
  default: 'legacy',
  list: { legacy: drivers.legacy({ keys: [appKey] }) },
})
