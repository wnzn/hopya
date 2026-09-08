import server from '@adonisjs/core/services/server'
server.errorHandler(() => import('../app/exceptions/handler.js'))
server.use([
  () => import('../app/middleware/boundary.js'),
  () => import('@adonisjs/core/bodyparser_middleware'),
])
