import { test } from './japa.js'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { openTestDatabase } from './helpers/database.js'
import { runMigrations } from './helpers/migrate.js'

test('real Adonis HTTP contract and authentication security', { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hopya-http-'))
  const socket = createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  const base = `http://127.0.0.1:${port}`
  const origin = 'http://localhost:4321'
  const password = 'test password with enough length'
  const setupToken = 'operator-only-test-setup-token'
  const compiled = process.env.HOPYA_TEST_BUILD === 'true'
  const environment = { ...process.env, DATA_DIR: directory, API_PORT: String(port), HOST: '127.0.0.1', APP_URL: origin,
    NODE_ENV: compiled ? 'production' : 'test', APP_KEY: 'a-random-looking-test-key-not-for-deployment-123456789', SETUP_TOKEN: setupToken,
    LANDING_ENABLED: 'true', REGISTRATION_ENABLED: 'false', AI_PROVIDER: '', OIDC_ISSUER: '', STORAGE_DRIVER: 'filesystem', LOG_LEVEL: 'fatal' }
  runMigrations(environment)
  const child = spawn(process.execPath, compiled ? ['build/bin/server.js'] : ['--import', 'tsx', 'bin/server.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  let database: ReturnType<typeof openTestDatabase> | undefined
  t.after(async () => {
    await database?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited
      clearTimeout(timer)
    }
    rmSync(directory, { recursive: true, force: true })
  })
  let ready = false
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) break
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(ready, `Adonis failed to start:\n${output}`)
  database = openTestDatabase(join(directory, 'hopya.sqlite'))
  async function request(path: string, options: { method?: string; body?: unknown; cookie?: string; token?: string; origin?: string | null; headers?: Record<string, string> } = {}) {
    const method = options.method || 'GET'
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.cookie) headers.cookie = options.cookie
    if (options.token) headers.authorization = `Bearer ${options.token}`
    if (options.origin !== null && !['GET', 'HEAD'].includes(method)) headers.origin = options.origin || origin
    const response = await fetch(`${base}/api/v1${path}`, { method, headers, body: options.body !== undefined ? JSON.stringify(options.body) : undefined, redirect: 'manual' })
    const text = await response.text()
    let data: any
    try { data = JSON.parse(text) } catch { assert.fail(`Expected JSON for ${method} ${path} (${response.status}): ${text}\n${output}`) }
    const cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
    return { status: response.status, data, response, cookie }
  }
  let adminCookie = ''; let adminId = ''; let otherCookie = ''; let otherId = ''; let workspaceId = ''; let ownerRoleId = ''; let viewerRoleId = ''; let listId = ''; let itemId = ''; let token = ''

  await t.test('configuration has no secrets and unsafe unauthenticated endpoints require matching origin', async () => {
    const config = await request('/config')
    assert.deepEqual(config.data, { landingEnabled: true, registrationEnabled: false, setupRequired: true, ssoEnabled: false, aiEnabled: false, passwordResetEnabled: false })
    for (const endpoint of ['/auth/setup', '/auth/login', '/auth/register', '/auth/logout', '/missing']) {
      assert.equal((await request(endpoint, { method: 'POST', body: {}, origin: null })).status, 403)
      assert.equal((await request(endpoint, { method: 'POST', body: {}, origin: 'https://evil.example' })).status, 403)
    }
    const missing = await request('/missing')
    assert.equal(missing.status, 404)
    assert.deepEqual(Object.keys(missing.data), ['error'])
    assert.equal((await request('/auth/me')).status, 401)
    assert.equal((await request('/auth/setup', { method: 'POST', body: {}, token: 'a'.repeat(43), origin: null })).status, 401)
  })
  await t.test('first setup requires operator secret and issues a private hashed expiring session', async () => {
    const body = { name: 'Admin', email: 'ADMIN@example.test', password, setupToken }
    assert.equal((await request('/auth/setup', { method: 'POST', body: { ...body, setupToken: 'wrong' } })).status, 403)
    const result = await request('/auth/setup', { method: 'POST', body })
    assert.equal(result.status, 201, JSON.stringify(result.data))
    adminCookie = result.cookie; adminId = result.data.id
    assert.deepEqual(Object.keys(result.data).sort(), ['email', 'id', 'isAdmin', 'name'])
    assert.equal(result.data.email, 'admin@example.test')
    assert.equal(result.data.isAdmin, true)
    const setCookie = result.response.headers.get('set-cookie')!
    assert.match(setCookie, /HttpOnly/i)
    assert.match(setCookie, /SameSite=Lax/i)
    assert.match(setCookie, /Path=\//i)
    assert.match(setCookie, /Max-Age=604800/i)
    const session = await database!.get<any>('SELECT * FROM sessions WHERE userId=?', adminId)
    assert.match(session.tokenHash, /^[a-f0-9]{64}$/)
    assert.ok(new Date(session.expiresAt).getTime() > Date.now())
    assert.equal(adminCookie.includes(session.tokenHash), false)
    assert.equal((await request('/config')).data.setupRequired, false)
    assert.equal((await request('/auth/setup', { method: 'POST', body })).status, 409)
    assert.equal((await request('/auth/register', { method: 'POST', body: { name: 'Public', email: 'public@example.test', password } })).status, 403)
  })
  await t.test('Adonis 6 signed sessions survive the runtime upgrade without bypassing purpose, expiry or revocation', async () => {
    // Generated with core 6.21.0 CookieClient and this test's APP_KEY, not the current signer.
    const signed = 's:eyJtZXNzYWdlIjoidjYtY29tcGF0aWJpbGl0eS10ZXN0LXNlc3Npb24tbm90LWEtcmVhbC1jcmVkZW50aWFsIiwicHVycG9zZSI6ImhvcHlhX3Nlc3Npb24ifQ.pHJZn-wR6lSNjBt-cLpJyto2jsPHFLiCjqL-IO0civQ'
    const wrongPurpose = 's:eyJtZXNzYWdlIjoidjYtY29tcGF0aWJpbGl0eS10ZXN0LXNlc3Npb24tbm90LWEtcmVhbC1jcmVkZW50aWFsIiwicHVycG9zZSI6ImFub3RoZXJfY29va2llIn0.3smX-5o6NCFyj-rHGMe7Zl7w5z2ZFMsOrJed516QxzU'
    const id = randomUUID()
    await database!.run('INSERT INTO sessions (id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)',
      id, adminId, createHash('sha256').update('v6-compatibility-test-session-not-a-real-credential').digest('hex'),
      new Date(Date.now() + 60000).toISOString(), new Date().toISOString(),
    )
    const cookie = `hopya_session=${encodeURIComponent(signed)}`
    try {
      const authenticated = await request('/auth/me', { cookie })
      assert.equal(authenticated.status, 200)
      assert.equal(authenticated.data.id, adminId)
      for (const invalid of [wrongPurpose, signed.slice(0, -1) + 'X']) {
        assert.equal((await request('/auth/me', { cookie: `hopya_session=${encodeURIComponent(invalid)}` })).status, 401)
      }
      await database!.run('UPDATE sessions SET expiresAt=? WHERE id=?', '2000-01-01T00:00:00.000Z', id)
      assert.equal((await request('/auth/me', { cookie })).status, 401)
      await database!.run('UPDATE sessions SET expiresAt=? WHERE id=?', new Date(Date.now() + 60000).toISOString(), id)
      assert.equal((await request('/auth/logout', { method: 'POST', cookie })).status, 200)
      assert.equal((await request('/auth/me', { cookie })).status, 401)
      assert.equal(await database!.get('SELECT id FROM sessions WHERE id=?', id), undefined)
    } finally {
      await database!.run('DELETE FROM sessions WHERE id=?', id)
    }
  })
  await t.test('admin user creation is private; login rotates sessions and generic failures hide accounts', async () => {
    assert.equal((await request('/auth/login', { method: 'POST', body: { email: 'missing@example.test', password } })).status, 401)
    assert.equal((await request('/auth/login', { method: 'POST', body: { email: 'admin@example.test', password: 'wrong' } })).status, 401)
    const login = await request('/auth/login', { method: 'POST', cookie: adminCookie, body: { email: 'admin@example.test', password } })
    assert.equal(login.status, 200)
    assert.equal((await request('/auth/me', { cookie: adminCookie })).status, 401)
    adminCookie = login.cookie
    const created = await request('/admin/users', { method: 'POST', cookie: adminCookie, body: { name: 'Other', email: 'other@example.test', password } })
    assert.equal(created.status, 201)
    otherId = created.data.id
    assert.equal(JSON.stringify(created.data).includes('Hash'), false)
    const otherLogin = await request('/auth/login', { method: 'POST', body: { email: 'other@example.test', password } })
    assert.equal(otherLogin.status, 200)
    otherCookie = otherLogin.cookie
    for (const endpoint of ['/admin/users', '/admin/audit', '/admin/status']) assert.equal((await request(endpoint, { cookie: otherCookie })).status, 403)
    assert.equal((await request('/admin/users', { method: 'POST', cookie: otherCookie, body: { name: 'Bad', email: 'bad@example.test', password, isAdmin: true } })).status, 403)
    const status = await request('/admin/status', { cookie: adminCookie })
    assert.equal(status.status, 200)
    assert.deepEqual(status.data.migrations.map((migration: { name: string }) => migration.name), ['database/migrations/0000_baseline', 'database/migrations/0001_automation_graphs'])
    assert.ok(status.data.migrations[0].appliedAt)
  })
  await t.test('workspace structure, role and item endpoints follow the REST contract', async () => {
    const workspace = await request('/workspaces', { method: 'POST', cookie: adminCookie, body: { name: 'Workspace' } })
    assert.equal(workspace.status, 201)
    workspaceId = workspace.data.id
    assert.equal((await request(`/workspaces/${workspaceId}`, { cookie: otherCookie })).status, 403)
    const detail = await request(`/workspaces/${workspaceId}`, { cookie: adminCookie })
    assert.deepEqual(Object.keys(detail.data).sort(), ['fields', 'listStatusConfigs', 'listTagColorConfigs', 'members', 'nodes', 'permissions', 'projectFields', 'role', 'roles', 'workspace'])
    ownerRoleId = detail.data.roles.find((role: any) => role.isOwner).id
    viewerRoleId = detail.data.roles.find((role: any) => role.name === 'Viewer').id
    const project = await request(`/workspaces/${workspaceId}/nodes`, { method: 'POST', cookie: adminCookie, body: { name: 'Project', kind: 'project', parentId: null } })
    assert.equal(project.status, 201)
    const list = await request(`/workspaces/${workspaceId}/nodes`, { method: 'POST', cookie: adminCookie, body: { name: 'List', kind: 'list', parentId: project.data.id } })
    assert.equal(list.status, 201); listId = list.data.id
    const field = await request(`/workspaces/${workspaceId}/fields`, { method: 'POST', cookie: adminCookie, body: { name: 'Estimate', type: 'number' } })
    assert.equal(field.status, 201)
    const item = await request(`/workspaces/${workspaceId}/items`, { method: 'POST', cookie: adminCookie, body: { title: 'Implement', description: '', nodeId: listId, tags: ['backend'], customFields: { [field.data.id]: 3 } } })
    assert.equal(item.status, 201); itemId = item.data.id
    assert.deepEqual(Object.keys(item.data).sort(), ['archivedAt', 'assigneeId', 'checklist', 'createdAt', 'customFields', 'description', 'dueDate', 'id', 'nodeId', 'parentId', 'priority', 'startDate', 'status', 'tags', 'title', 'updatedAt', 'workspaceId'])
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', cookie: adminCookie, body: { status: 'done' } })).data.status, 'done')
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', cookie: adminCookie, body: { description: '' } })).data.description, '')
    assert.equal((await request(`/workspaces/${workspaceId}/items?status=done&search=Implement`, { cookie: adminCookie })).data.length, 1)
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', cookie: adminCookie, body: { dueDate: '2026-02-30' } })).status, 400)
    assert.equal((await request(`/workspaces/${workspaceId}/export`, { cookie: adminCookie })).data.version, 3)
  })
  await t.test('bulk archive is revision-checked and excluded from ordinary reads', async () => {
    const created = await request(`/workspaces/${workspaceId}/items`, { method: 'POST', cookie: adminCookie, body: { title: 'Archive me', nodeId: listId } })
    assert.equal(created.status, 201)
    const result = await request(`/workspaces/${workspaceId}/items/bulk`, { method: 'POST', cookie: adminCookie,
      body: { action: 'archive', items: [{ id: created.data.id, expectedUpdatedAt: created.data.updatedAt }] } })
    assert.equal(result.status, 200)
    assert.deepEqual(result.data, { action: 'archive', affected: 1 })
    assert.equal((await request(`/workspaces/${workspaceId}/items?search=Archive%20me`, { cookie: adminCookie })).data.length, 0)
    assert.ok((await request(`/workspaces/${workspaceId}/items/${created.data.id}`, { cookie: adminCookie })).data.archivedAt)
  })
  await t.test('conditional PATCH rejects stale or invalid versions without side effects and keeps legacy writes', async () => {
    const path = `/workspaces/${workspaceId}/items/${itemId}`
    const current = (await request(path, { cookie: adminCookie })).data
    const auditCount = async () => (await database!.get<{ count: number }>("SELECT count(*) AS count FROM audit_logs WHERE resourceId=? AND action='item.update'", itemId))!.count
    const before = await auditCount()
    const responses = await Promise.all(['low', 'urgent'].map((priority) => request(path, { method: 'PATCH', cookie: adminCookie, body: { priority, expectedUpdatedAt: current.updatedAt } })))
    assert.deepEqual(responses.map((result) => result.status).sort(), [200, 409])
    const winner = responses.find((result) => result.status === 200)!.data
    assert.ok(Date.parse(winner.updatedAt) > Date.parse(current.updatedAt))
    assert.equal(Object.hasOwn(winner, 'expectedUpdatedAt'), false)
    assert.equal(await auditCount(), before + 1)
    const stale = await request(path, { method: 'PATCH', cookie: adminCookie, body: { title: 'Stale replacement', expectedUpdatedAt: current.updatedAt } })
    assert.equal(stale.status, 409)
    assert.deepEqual(Object.keys(stale.data), ['error'])
    for (const expectedUpdatedAt of [null, '', 'bad', '2026-02-30T00:00:00.000Z', 123]) {
      assert.equal((await request(path, { method: 'PATCH', cookie: adminCookie, body: { expectedUpdatedAt } })).status, 400)
    }
    assert.equal((await request(`/workspaces/${workspaceId}/items`, { method: 'POST', cookie: adminCookie, body: { title: 'Invalid create', nodeId: listId, expectedUpdatedAt: winner.updatedAt } })).status, 400)
    assert.deepEqual((await request(path, { cookie: adminCookie })).data, winner)
    assert.equal(await auditCount(), before + 1)
    const legacy = await request(path, { method: 'PATCH', cookie: adminCookie, body: { priority: 'medium' } })
    assert.equal(legacy.status, 200)
    assert.ok(Date.parse(legacy.data.updatedAt) > Date.parse(winner.updatedAt))
  })
  await t.test('membership ownership stays protected while site admins can suspend and recover sole owners', async () => {
    assert.equal((await request(`/workspaces/${workspaceId}/members/${adminId}`, { method: 'DELETE', cookie: adminCookie })).status, 409)
    assert.equal((await request(`/workspaces/${workspaceId}/roles/${ownerRoleId}`, { method: 'PATCH', cookie: adminCookie, body: { permissions: [] } })).status, 403)
    assert.equal((await request(`/admin/users/${adminId}`, { method: 'PATCH', cookie: adminCookie, body: { isAdmin: false } })).status, 409)
    assert.equal((await request(`/admin/users/${adminId}`, { method: 'PATCH', cookie: adminCookie, body: { disabled: true } })).status, 409)
    assert.equal((await request(`/workspaces/${workspaceId}/members`, { method: 'POST', cookie: adminCookie, body: { email: 'other@example.test', roleId: viewerRoleId } })).status, 201)
    assert.equal((await request(`/workspaces/${workspaceId}/items`, { cookie: otherCookie })).status, 200)
    assert.equal((await request(`/workspaces/${workspaceId}/items`, { method: 'POST', cookie: otherCookie, body: { title: 'Denied', nodeId: listId } })).status, 403)
    assert.equal((await request(`/admin/users/${otherId}`, { method: 'PATCH', cookie: adminCookie, body: { isAdmin: true } })).status, 200)
    const ownerToken = await request('/auth/tokens', { method: 'POST', cookie: adminCookie, body: { name: 'Owner suspension regression' } })
    assert.equal(ownerToken.status, 201)
    assert.equal((await request(`/admin/users/${adminId}`, { method: 'PATCH', cookie: otherCookie, body: { disabled: true } })).status, 200)
    assert.equal((await request('/auth/me', { cookie: adminCookie })).status, 401)
    assert.equal((await request('/auth/me', { token: ownerToken.data.token })).status, 401)
    assert.equal((await database!.get<{ roleId: string }>('SELECT roleId FROM memberships WHERE workspaceId=? AND userId=?', workspaceId, adminId))!.roleId, ownerRoleId)
    assert.equal((await request(`/admin/users/${otherId}`, { method: 'PATCH', cookie: otherCookie, body: { disabled: true } })).status, 409)
    assert.equal((await request(`/admin/users/${adminId}`, { method: 'PATCH', cookie: otherCookie, body: { disabled: false } })).status, 200)
    assert.equal((await request('/auth/me', { token: ownerToken.data.token })).status, 401)
    const recovered = await request('/auth/login', { method: 'POST', body: { email: 'admin@example.test', password } })
    assert.equal(recovered.status, 200)
    adminCookie = recovered.cookie
    assert.equal((await request(`/workspaces/${workspaceId}`, { cookie: adminCookie })).data.role.isOwner, true)
  })
  await t.test('comment and notification routes preserve workspace and recipient ownership', async () => {
    const commentsPath = `/workspaces/${workspaceId}/items/${itemId}/comments`
    const created = await request(commentsPath, { method: 'POST', cookie: adminCookie, body: {
      body: `HTTP mention [@Other](/app?workspace=${workspaceId}&mentionUser=${otherId})`,
    } })
    assert.equal(created.status, 201)
    const reply = await request(commentsPath, { method: 'POST', cookie: adminCookie, body: { body: 'HTTP reply', parentId: created.data.id } })
    assert.equal(reply.status, 201)
    assert.equal(reply.data.parentId, created.data.id)
    assert.equal((await request(`${commentsPath}/${reply.data.id}/reaction`, { method: 'PATCH', cookie: adminCookie, body: { emoji: '🎉', active: true } })).status, 200)
    assert.equal((await request(commentsPath, { cookie: otherCookie })).data[0].id, created.data.id)
    const noticesPath = `/workspaces/${workspaceId}/notifications`
    const notices = await request(noticesPath, { cookie: otherCookie })
    assert.equal(notices.status, 200)
    const notice = notices.data.find((row: any) => row.commentId === created.data.id)
    assert.equal(notice.type, 'mention')
    assert.equal((await request(`${noticesPath}/unread-count`, { cookie: otherCookie })).data.unread > 0, true)
    assert.equal((await request(`${noticesPath}/${notice.id}`, { method: 'PATCH', cookie: adminCookie, body: { read: true } })).status, 404)
    assert.ok((await request(`${noticesPath}/${notice.id}`, { method: 'PATCH', cookie: otherCookie, body: { read: true } })).data.readAt)
    assert.equal((await request(`${commentsPath}/${created.data.id}`, { method: 'DELETE', cookie: otherCookie })).status, 403)
    assert.equal((await request(`${commentsPath}/${created.data.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200)
    assert.equal((await request(`${commentsPath}/${created.data.id}`, { method: 'DELETE', cookie: adminCookie })).status, 200)
    assert.equal((await request(commentsPath, { cookie: adminCookie })).data.some((comment: any) => comment.id === created.data.id), false)
  })
  await t.test('read-only and write-only roles cannot PATCH or receive existing task contents', async () => {
    const path = `/workspaces/${workspaceId}/items/${itemId}`
    const current = (await request(path, { cookie: adminCookie })).data
    const role = await request(`/workspaces/${workspaceId}/roles`, { method: 'POST', cookie: adminCookie, body: { name: 'Write only', permissions: ['items:write'] } })
    assert.equal(role.status, 201)
    for (const roleId of [viewerRoleId, role.data.id]) {
      assert.equal((await request(`/workspaces/${workspaceId}/members/${otherId}`, { method: 'PATCH', cookie: adminCookie, body: { roleId } })).status, 200)
      const before: Record<string, unknown>[] = await database!.all('SELECT * FROM audit_logs')
      for (const body of [{}, { status: 'done' }, { expectedUpdatedAt: current.updatedAt }]) {
        const result = await request(path, { method: 'PATCH', cookie: otherCookie, body })
        assert.equal(result.status, 403)
        assert.deepEqual(Object.keys(result.data), ['error'])
      }
      assert.deepEqual(await database!.all('SELECT * FROM audit_logs'), before)
      assert.deepEqual((await request(path, { cookie: adminCookie })).data, current)
    }
    assert.equal((await request(path, { cookie: otherCookie })).status, 403)
    assert.equal((await request(`/workspaces/${workspaceId}/members/${otherId}`, { method: 'PATCH', cookie: adminCookie, body: { roleId: viewerRoleId } })).status, 200)
  })
  await t.test('bearer tokens are hashed, revocable, isolated and do not relax browser origin checks', async () => {
    const result = await request('/auth/tokens', { method: 'POST', cookie: adminCookie, body: { name: 'Automation' } })
    assert.equal(result.status, 201); token = result.data.token
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal((await request('/auth/me', { token })).data.id, adminId)
    const tokens = await request('/auth/tokens', { cookie: adminCookie })
    assert.equal(JSON.stringify(tokens.data).includes(token), false)
    assert.equal(JSON.stringify(tokens.data).includes('tokenHash'), false)
    const stored = await database!.get<any>('SELECT tokenHash FROM tokens WHERE userId=?', adminId)
    assert.notEqual(stored.tokenHash, token)
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', token, origin: null, body: { priority: 'high' } })).status, 200)
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', token, origin: 'https://evil.example', body: { priority: 'urgent' } })).status, 403)
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', token, cookie: adminCookie, origin: null, body: { priority: 'urgent' } })).status, 403)
    assert.equal((await request('/auth/me', { token: 'not-valid', cookie: adminCookie })).status, 401)
    assert.equal((await request(`/auth/tokens/${tokens.data[0].id}`, { method: 'DELETE', cookie: otherCookie })).status, 404)
    assert.equal((await request(`/auth/tokens/${tokens.data[0].id}`, { method: 'DELETE', cookie: adminCookie })).status, 200)
    assert.equal((await request('/auth/me', { token })).status, 401)
  })
  await t.test('password changes require current password, revoke credentials, and never appear in audits', async () => {
    token = (await request('/auth/tokens', { method: 'POST', cookie: otherCookie, body: { name: 'Old token' } })).data.token
    assert.equal((await request('/auth/profile', { method: 'PATCH', cookie: otherCookie, body: { name: 'Other', password: 'a new lengthy password' } })).status, 403)
    const changed = await request('/auth/profile', { method: 'PATCH', cookie: otherCookie, body: { name: 'Renamed', password: 'a new lengthy password', currentPassword: password } })
    assert.equal(changed.status, 200); assert.equal(changed.data.name, 'Renamed')
    assert.equal((await request('/auth/me', { cookie: otherCookie })).status, 401)
    assert.equal((await request('/auth/me', { token })).status, 401)
    otherCookie = changed.cookie
    assert.equal((await request('/auth/me', { cookie: otherCookie })).status, 200)
    const audit = await request('/admin/audit?limit=200&offset=0', { cookie: adminCookie })
    assert.equal(audit.status, 200)
    const serialized = JSON.stringify(audit.data)
    for (const value of [password, 'a new lengthy password', token, setupToken, 'passwordHash', 'tokenHash']) assert.equal(serialized.includes(value), false)
    assert.equal((await request('/admin/audit?limit=201', { cookie: adminCookie })).status, 400)
  })
  await t.test('disabled accounts lose all credentials and expiry is enforced server-side', async () => {
    const owned = await request('/workspaces', { method: 'POST', cookie: otherCookie, body: { name: 'Sole-owned by suspended account' } })
    assert.equal(owned.status, 201)
    const project = await request(`/workspaces/${owned.data.id}/nodes`, { method: 'POST', cookie: otherCookie, body: { name: 'Project', kind: 'project' } })
    const list = await request(`/workspaces/${owned.data.id}/nodes`, { method: 'POST', cookie: otherCookie, body: { name: 'List', kind: 'list', parentId: project.data.id } })
    const ownedItem = await request(`/workspaces/${owned.data.id}/items`, { method: 'POST', cookie: otherCookie, body: { title: 'Self assigned', nodeId: list.data.id, assigneeId: otherId } })
    assert.equal(ownedItem.status, 201)
    const assigned = await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', cookie: adminCookie, body: { assigneeId: otherId } })
    assert.equal(assigned.status, 200)
    const tokenResult = await request('/auth/tokens', { method: 'POST', cookie: otherCookie, body: { name: 'Disable me' } })
    assert.equal((await request(`/admin/users/${otherId}`, { method: 'PATCH', cookie: adminCookie, body: { disabled: true } })).status, 200)
    assert.equal((await request('/auth/me', { cookie: otherCookie })).status, 401)
    assert.equal((await request('/auth/me', { token: tokenResult.data.token })).status, 401)
    assert.equal((await database!.get<any>('SELECT count(*) AS count FROM sessions WHERE userId=?', otherId))!.count, 0)
    assert.equal((await database!.get<any>('SELECT count(*) AS count FROM tokens WHERE userId=?', otherId))!.count, 0)
    assert.ok(await database!.get('SELECT userId FROM memberships WHERE workspaceId=? AND userId=?', owned.data.id, otherId))
    assert.equal((await database!.get<{ count: number }>('SELECT count(*) AS count FROM items WHERE assigneeId=?', otherId))!.count, 0)
    const cleared = (await request(`/workspaces/${workspaceId}/items/${itemId}`, { cookie: adminCookie })).data
    assert.equal(cleared.assigneeId, null)
    assert.ok(Date.parse(cleared.updatedAt) > Date.parse(assigned.data.updatedAt))
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', cookie: adminCookie, body: { expectedUpdatedAt: assigned.data.updatedAt, status: 'todo' } })).status, 409)
    assert.equal((await request(`/workspaces/${workspaceId}/items/${itemId}`, { method: 'PATCH', cookie: adminCookie, body: { expectedUpdatedAt: cleared.updatedAt, status: 'todo' } })).status, 200)
    const suspensionAudit = (await database!.get<{ details: string }>("SELECT details FROM audit_logs WHERE action='admin.user.update' AND resourceId=? ORDER BY rowid DESC LIMIT 1", otherId))!
    assert.deepEqual(JSON.parse(suspensionAudit.details), { disabled: true, clearedAssignments: 2, affectedWorkspaces: 2, revokedSessions: 1, revokedTokens: 1 })
    const expiring = await request('/auth/tokens', { method: 'POST', cookie: adminCookie, body: { name: 'Expired' } })
    await database!.run('UPDATE tokens SET expiresAt=?', '2000-01-01T00:00:00.000Z')
    assert.equal((await request('/auth/me', { token: expiring.data.token })).status, 401)
    const logout = await request('/auth/logout', { method: 'POST', cookie: adminCookie })
    assert.equal(logout.status, 200)
    assert.equal((await request('/auth/me', { cookie: adminCookie })).status, 401)
    const login = await request('/auth/login', { method: 'POST', body: { email: 'admin@example.test', password } })
    assert.equal(login.status, 200)
    await database!.run('UPDATE sessions SET expiresAt=?', '2000-01-01T00:00:00.000Z')
    assert.equal((await request('/auth/me', { cookie: login.cookie })).status, 401)
  })
  await t.test('workspace owners can permanently delete through the REST endpoint', async () => {
    const login = await request('/auth/login', { method: 'POST', body: { email: 'admin@example.test', password } })
    const deleted = await request(`/workspaces/${workspaceId}`, { method: 'DELETE', cookie: login.cookie })
    assert.equal(deleted.status, 200)
    assert.deepEqual(deleted.data, { success: true })
    assert.equal((await request(`/workspaces/${workspaceId}`, { cookie: login.cookie })).status, 403)
    assert.ok(await database!.get("SELECT id FROM audit_logs WHERE workspaceId=? AND action='workspace.delete'", workspaceId))
  })
  await t.test('setup and login rate limits cannot be bypassed with forwarded IP spoofing', async () => {
    for (const path of ['/auth/login', '/auth/setup']) {
      let status = 0
      for (let index = 0; index < 12; index++) {
        const result = await request(path, { method: 'POST', body: {}, headers: { 'x-forwarded-for': `192.0.2.${index}` } })
        status = result.status
        if (status === 429) { assert.ok(Number(result.response.headers.get('retry-after')) > 0); break }
      }
      assert.equal(status, 429)
    }
  })
  assert.equal((await database.get<{ integrity_check: string }>('PRAGMA integrity_check'))?.integrity_check, 'ok')
})
