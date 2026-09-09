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

// Automation events flush only after the mutation commits successfully.
async function flushed<T>(operation: () => Promise<T>): Promise<T> {
  const result = await operation()
  scheduleFlush()
  return result
}

router.get('/health', async () => {
  await db.get('SELECT 1')
  return { status: 'ok' }
})
router.group(() => {
  router.get('/config', async () => ({ ...await siteConfig(), registrationEnabled, setupRequired: await setupRequired(), ssoEnabled: Boolean(process.env.OIDC_ISSUER), aiEnabled: Boolean(process.env.AI_PROVIDER), passwordResetEnabled: passwordResetEnabled() }))
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
  router.get('/workspaces', async (ctx) => service.listWorkspaces((await authenticate(ctx)).id))
  router.post('/workspaces', async (ctx) => created(ctx, async () => service.createWorkspace((await authenticate(ctx)).id, ctx.request.body())))
  router.get('/workspaces/:wid', async (ctx) => service.getWorkspace((await authenticate(ctx)).id, ctx.params.wid))
  router.patch('/workspaces/:wid', async (ctx) => service.updateWorkspace((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body()))
  router.delete('/workspaces/:wid', async (ctx) => service.deleteWorkspace((await authenticate(ctx)).id, ctx.params.wid))
  router.get('/workspaces/:wid/export', (ctx) => streamTasks(ctx, true))
  router.get('/workspaces/:wid/nodes', async (ctx) => service.listNodes((await authenticate(ctx)).id, ctx.params.wid))
  router.post('/workspaces/:wid/nodes', async (ctx) => created(ctx, () => flushed(async () => service.createNode((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body()))))
  router.patch('/workspaces/:wid/nodes/:id', async (ctx) => flushed(async () => service.updateNode((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.delete('/workspaces/:wid/nodes/:id', async (ctx) => flushed(async () => service.deleteNode((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id)))
  router.get('/workspaces/:wid/items', (ctx) => streamTasks(ctx, false))
  router.post('/workspaces/:wid/items', async (ctx) => created(ctx, () => flushed(async () => service.createItem((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body()))))
  router.post('/workspaces/:wid/items/import', async (ctx) => created(ctx, () => flushed(async () => importItems((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body()))))
  router.get('/workspaces/:wid/items/export', (ctx) => handleExport(ctx))
  router.get('/workspaces/:wid/items/page', async (ctx) => service.pageItems((await authenticate(ctx)).id, ctx.params.wid, ctx.request.qs()))
  router.post('/workspaces/:wid/items/bulk', async (ctx) => flushed(async () => service.bulkItems((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body())))
  router.get('/workspaces/:wid/items/:id', async (ctx) => service.getItem((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id))
  router.patch('/workspaces/:wid/items/:id', async (ctx) => flushed(async () => service.updateItem((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.delete('/workspaces/:wid/items/:id', async (ctx) => flushed(async () => service.deleteItem((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id)))
  router.get('/workspaces/:wid/items/:id/comments', async (ctx) => service.listComments((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id))
  router.post('/workspaces/:wid/items/:id/comments', async (ctx) => created(ctx, async () => service.createComment((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.delete('/workspaces/:wid/items/:id/comments/:commentId', async (ctx) => service.deleteComment((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.params.commentId))
  router.patch('/workspaces/:wid/items/:id/comments/:commentId/reaction', async (ctx) => service.updateCommentReaction((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.params.commentId, ctx.request.body()))
  router.get('/workspaces/:wid/notifications', async (ctx) => service.listNotifications((await authenticate(ctx)).id, ctx.params.wid))
  router.get('/workspaces/:wid/notifications/unread-count', async (ctx) => service.unreadNotificationCount((await authenticate(ctx)).id, ctx.params.wid))
  router.patch('/workspaces/:wid/notifications/:id', async (ctx) => service.updateNotification((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.request.body()))
  router.delete('/workspaces/:wid/notifications/:id', async (ctx) => service.deleteNotification((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id))
  router.get('/workspaces/:wid/fields', async (ctx) => service.listFields((await authenticate(ctx)).id, ctx.params.wid))
  router.get('/workspaces/:wid/projects/:projectId/fields', async (ctx) => service.getProjectFields((await authenticate(ctx)).id, ctx.params.wid, ctx.params.projectId))
  router.patch('/workspaces/:wid/projects/:projectId/fields', async (ctx) => service.updateProjectFields((await authenticate(ctx)).id, ctx.params.wid, ctx.params.projectId, ctx.request.body()))
  router.get('/workspaces/:wid/views/list/settings', async (ctx) => service.getListViewSettings((await authenticate(ctx)).id, ctx.params.wid, ctx.request.qs()))
  router.patch('/workspaces/:wid/views/list/settings', async (ctx) => service.updateListViewSettings((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body()))
  router.get('/workspaces/:wid/lists/:listId/statuses', async (ctx) => service.getListStatuses((await authenticate(ctx)).id, ctx.params.wid, ctx.params.listId))
  router.patch('/workspaces/:wid/lists/:listId/statuses', async (ctx) => service.updateListStatuses((await authenticate(ctx)).id, ctx.params.wid, ctx.params.listId, ctx.request.body()))
  router.get('/workspaces/:wid/lists/:listId/tag-colors', async (ctx) => service.getListTagColors((await authenticate(ctx)).id, ctx.params.wid, ctx.params.listId))
  router.patch('/workspaces/:wid/lists/:listId/tag-colors', async (ctx) => service.updateListTagColors((await authenticate(ctx)).id, ctx.params.wid, ctx.params.listId, ctx.request.body()))
  router.post('/workspaces/:wid/fields', async (ctx) => created(ctx, () => flushed(async () => service.createField((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body()))))
  router.delete('/workspaces/:wid/fields/:id', async (ctx) => flushed(async () => service.deleteField((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id)))
  router.patch('/workspaces/:wid/fields/:id', async (ctx) => flushed(async () => service.updateField((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.request.body())))
  router.post('/workspaces/:wid/members', async (ctx) => created(ctx, async () => service.addMember((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body())))
  router.patch('/workspaces/:wid/members/:userId', async (ctx) => service.updateMember((await authenticate(ctx)).id, ctx.params.wid, ctx.params.userId, ctx.request.body()))
  router.delete('/workspaces/:wid/members/:userId', async (ctx) => service.deleteMember((await authenticate(ctx)).id, ctx.params.wid, ctx.params.userId))
  router.get('/workspaces/:wid/roles', async (ctx) => service.listRoles((await authenticate(ctx)).id, ctx.params.wid))
  router.post('/workspaces/:wid/roles', async (ctx) => created(ctx, async () => service.createRole((await authenticate(ctx)).id, ctx.params.wid, ctx.request.body())))
  router.patch('/workspaces/:wid/roles/:id', async (ctx) => service.updateRole((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id, ctx.request.body()))
  router.delete('/workspaces/:wid/roles/:id', async (ctx) => service.deleteRole((await authenticate(ctx)).id, ctx.params.wid, ctx.params.id))
}).prefix('/api/v1')

async function created<T>(ctx: HttpContext, operation: () => Promise<T>): Promise<T> {
  const result = await operation()
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
