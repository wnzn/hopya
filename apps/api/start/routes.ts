import router from '@adonisjs/core/services/router'
import type { HttpContext } from '@adonisjs/core/http'
import { authenticate, db, service } from '../app/core.js'
import { accounts, setupRequired } from '../app/accounts.js'
import { registrationEnabled } from '../app/settings.js'
import { passwordResetEnabled } from '../app/mail.js'
import { streamTasks } from '../app/task_streams.js'
import { siteConfig } from '../app/site_settings.js'
import { handleExport, importItems } from '../app/import_export.js'
import { openApiDocument } from '../app/openapi.js'
import { scheduleFlush } from '../app/automations.js'

// Automation events flush after the mutation response is written.
function flushed<T>(operation: () => T): T {
  const result = operation()
  scheduleFlush()
  return result
}

router.get('/health', () => {
  db.prepare('SELECT 1').get()
  return { status: 'ok' }
})
router.group(() => {
  router.get('/config', () => ({ ...siteConfig(), registrationEnabled, setupRequired: setupRequired(), ssoEnabled: Boolean(process.env.OIDC_ISSUER), aiEnabled: Boolean(process.env.AI_PROVIDER), passwordResetEnabled: passwordResetEnabled() }))
  router.get('/openapi.json', () => openApiDocument())
  router.post('/auth/setup', accounts.setup)
  router.post('/auth/register', accounts.register)
  router.post('/auth/login', accounts.login)
  router.post('/auth/forgot-password', accounts.forgotPassword)
  router.post('/auth/reset-password', accounts.resetPassword)
  router.post('/auth/logout', accounts.logout)
  router.get('/auth/me', authenticate)
  router.patch('/auth/profile', accounts.profile)
  router.get('/auth/tokens', accounts.listTokens)
  router.post('/auth/tokens', accounts.createToken)
  router.delete('/auth/tokens/:id', accounts.deleteToken)
  router.get('/admin/users', accounts.listUsers)
  router.post('/admin/users', accounts.createUser)
  router.patch('/admin/users/:id', accounts.updateUser)
  router.get('/admin/audit', accounts.listAudit)
  router.get('/admin/status', accounts.status)
  router.get('/workspaces', (ctx) => service.listWorkspaces(authenticate(ctx).id))
  router.post('/workspaces', (ctx) => { const result = service.createWorkspace(authenticate(ctx).id, ctx.request.body()); ctx.response.status(201); return result })
  router.get('/workspaces/:wid', (ctx) => service.getWorkspace(authenticate(ctx).id, ctx.params.wid))
  router.patch('/workspaces/:wid', (ctx) => service.updateWorkspace(authenticate(ctx).id, ctx.params.wid, ctx.request.body()))
  router.delete('/workspaces/:wid', (ctx) => service.deleteWorkspace(authenticate(ctx).id, ctx.params.wid))
  router.get('/workspaces/:wid/export', (ctx) => streamTasks(ctx, true))
  router.get('/workspaces/:wid/nodes', (ctx) => service.listNodes(authenticate(ctx).id, ctx.params.wid))
  router.post('/workspaces/:wid/nodes', (ctx) => created(ctx, () => flushed(() => service.createNode(authenticate(ctx).id, ctx.params.wid, ctx.request.body()))))
  router.patch('/workspaces/:wid/nodes/:id', (ctx) => flushed(() => service.updateNode(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.delete('/workspaces/:wid/nodes/:id', (ctx) => flushed(() => service.deleteNode(authenticate(ctx).id, ctx.params.wid, ctx.params.id)))
  router.get('/workspaces/:wid/items', (ctx) => streamTasks(ctx, false))
  router.post('/workspaces/:wid/items', (ctx) => created(ctx, () => flushed(() => service.createItem(authenticate(ctx).id, ctx.params.wid, ctx.request.body()))))
  router.post('/workspaces/:wid/items/import', (ctx) => created(ctx, () => flushed(() => importItems(authenticate(ctx).id, ctx.params.wid, ctx.request.body()))))
  router.get('/workspaces/:wid/items/export', (ctx) => handleExport(ctx))
  router.get('/workspaces/:wid/items/page', (ctx) => service.pageItems(authenticate(ctx).id, ctx.params.wid, ctx.request.qs()))
  router.post('/workspaces/:wid/items/bulk', (ctx) => flushed(() => service.bulkItems(authenticate(ctx).id, ctx.params.wid, ctx.request.body())))
  router.get('/workspaces/:wid/items/:id', (ctx) => service.getItem(authenticate(ctx).id, ctx.params.wid, ctx.params.id))
  router.patch('/workspaces/:wid/items/:id', (ctx) => flushed(() => service.updateItem(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.delete('/workspaces/:wid/items/:id', (ctx) => flushed(() => service.deleteItem(authenticate(ctx).id, ctx.params.wid, ctx.params.id)))
  router.get('/workspaces/:wid/items/:id/comments', (ctx) => service.listComments(authenticate(ctx).id, ctx.params.wid, ctx.params.id))
  router.post('/workspaces/:wid/items/:id/comments', (ctx) => created(ctx, () => service.createComment(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.delete('/workspaces/:wid/items/:id/comments/:commentId', (ctx) => service.deleteComment(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.params.commentId))
  router.patch('/workspaces/:wid/items/:id/comments/:commentId/reaction', (ctx) => service.updateCommentReaction(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.params.commentId, ctx.request.body()))
  router.get('/workspaces/:wid/notifications', (ctx) => service.listNotifications(authenticate(ctx).id, ctx.params.wid))
  router.get('/workspaces/:wid/notifications/unread-count', (ctx) => service.unreadNotificationCount(authenticate(ctx).id, ctx.params.wid))
  router.patch('/workspaces/:wid/notifications/:id', (ctx) => service.updateNotification(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.request.body()))
  router.delete('/workspaces/:wid/notifications/:id', (ctx) => service.deleteNotification(authenticate(ctx).id, ctx.params.wid, ctx.params.id))
  router.get('/workspaces/:wid/fields', (ctx) => service.listFields(authenticate(ctx).id, ctx.params.wid))
  router.get('/workspaces/:wid/projects/:projectId/fields', (ctx) => service.getProjectFields(authenticate(ctx).id, ctx.params.wid, ctx.params.projectId))
  router.patch('/workspaces/:wid/projects/:projectId/fields', (ctx) => service.updateProjectFields(authenticate(ctx).id, ctx.params.wid, ctx.params.projectId, ctx.request.body()))
  router.get('/workspaces/:wid/views/list/settings', (ctx) => service.getListViewSettings(authenticate(ctx).id, ctx.params.wid, ctx.request.qs()))
  router.patch('/workspaces/:wid/views/list/settings', (ctx) => service.updateListViewSettings(authenticate(ctx).id, ctx.params.wid, ctx.request.body()))
  router.get('/workspaces/:wid/lists/:listId/statuses', (ctx) => service.getListStatuses(authenticate(ctx).id, ctx.params.wid, ctx.params.listId))
  router.patch('/workspaces/:wid/lists/:listId/statuses', (ctx) => service.updateListStatuses(authenticate(ctx).id, ctx.params.wid, ctx.params.listId, ctx.request.body()))
  router.get('/workspaces/:wid/lists/:listId/tag-colors', (ctx) => service.getListTagColors(authenticate(ctx).id, ctx.params.wid, ctx.params.listId))
  router.patch('/workspaces/:wid/lists/:listId/tag-colors', (ctx) => service.updateListTagColors(authenticate(ctx).id, ctx.params.wid, ctx.params.listId, ctx.request.body()))
  router.post('/workspaces/:wid/fields', (ctx) => created(ctx, () => flushed(() => service.createField(authenticate(ctx).id, ctx.params.wid, ctx.request.body()))))
  router.delete('/workspaces/:wid/fields/:id', (ctx) => flushed(() => service.deleteField(authenticate(ctx).id, ctx.params.wid, ctx.params.id)))
  router.patch('/workspaces/:wid/fields/:id', (ctx) => flushed(() => service.updateField(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.post('/workspaces/:wid/members', (ctx) => created(ctx, () => service.addMember(authenticate(ctx).id, ctx.params.wid, ctx.request.body())))
  router.patch('/workspaces/:wid/members/:userId', (ctx) => service.updateMember(authenticate(ctx).id, ctx.params.wid, ctx.params.userId, ctx.request.body()))
  router.delete('/workspaces/:wid/members/:userId', (ctx) => service.deleteMember(authenticate(ctx).id, ctx.params.wid, ctx.params.userId))
  router.get('/workspaces/:wid/roles', (ctx) => service.listRoles(authenticate(ctx).id, ctx.params.wid))
  router.post('/workspaces/:wid/roles', (ctx) => created(ctx, () => service.createRole(authenticate(ctx).id, ctx.params.wid, ctx.request.body())))
  router.patch('/workspaces/:wid/roles/:id', (ctx) => service.updateRole(authenticate(ctx).id, ctx.params.wid, ctx.params.id, ctx.request.body()))
  router.delete('/workspaces/:wid/roles/:id', (ctx) => service.deleteRole(authenticate(ctx).id, ctx.params.wid, ctx.params.id))
}).prefix('/api/v1')

function created<T>(ctx: HttpContext, operation: () => T): T {
  const result = operation()
  ctx.response.status(201)
  return result
}

// Integration module default export: (router: Router) => void | Promise<void>.
// Register full /api/v1 paths here; the global boundary middleware also covers these routes.
const integrations = await import('../app/integrations/routes.js')
integrations.default(router)
const { registerAutomations } = await import('../app/automations.js')
registerAutomations(router)
const { registerSiteSettings } = await import('../app/site_settings.js')
registerSiteSettings(router)
