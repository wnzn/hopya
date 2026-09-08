import { indexEntities } from '@adonisjs/core'
import { defineConfig } from '@adonisjs/core/app'

export default defineConfig({
  hooks: { init: [indexEntities()] },
  providers: [() => import('@adonisjs/core/providers/app_provider')],
  preloads: [() => import('./start/kernel.js'), () => import('./start/routes.js')],
})
