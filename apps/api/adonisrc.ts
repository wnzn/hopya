import { indexEntities } from '@adonisjs/core'
import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  hooks: { init: [indexEntities()] },
  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    () => import('@adonisjs/lucid/database_provider'),
  ],
  commands: [
    () => import('@adonisjs/core/commands'),
    () => import('@adonisjs/lucid/commands'),
  ],
  preloads: [() => import('./start/kernel.js'), () => import('./start/routes.js')],
})
