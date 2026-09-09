import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { closeDatabase, migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-accounts-'))
process.env.DATA_DIR = directory
process.env.REGISTRATION_ENABLED = 'true'
await migrateDatabase()
const { db, HttpError, service, authenticate } = await import('../app/core.js')
const { accounts } = await import('../app/accounts.js')
const { verifyPassword, hashPassword, hashToken } = await import('../app/security.js')
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }) })

async function accountContext(userId: string, body: unknown = {}, targetId = userId): Promise<HttpContext> {
  const token = randomUUID()
  await db.run('INSERT INTO sessions (id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)',
    randomUUID(), userId, hashToken(token), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString())
  return { params: { id: targetId }, request: { body: () => body, header: () => undefined, cookie: () => token }, response: { status: () => {} } } as unknown as HttpContext
}
async function suspensionFixture() {
  const admin = (await db.get<{ id: string }>('SELECT id FROM users WHERE email=?', 'admin@example.test'))!.id
  const userId = randomUUID()
  await db.run('INSERT INTO users (id,name,email,createdAt) VALUES (?,?,?,?)', userId, 'Suspend', `${userId}@example.test`, new Date().toISOString())
  const owned = await service.createWorkspace(userId, { name: 'Sole-owned workspace' })
  const shared = await service.createWorkspace(admin, { name: 'Shared workspace' })
  const viewer = (await service.listRoles(admin, shared.id)).find((role) => role.name === 'Viewer')!
  await service.addMember(admin, shared.id, { email: `${userId}@example.test`, roleId: viewer.id })
  const items = []
  for (const workspace of [owned, shared]) {
    const actor = workspace.id === owned.id ? userId : admin
    const project = await service.createNode(actor, workspace.id, { name: 'Project', kind: 'project' })
    const list = await service.createNode(actor, workspace.id, { name: 'List', kind: 'list', parentId: project.id })
    items.push(await service.createItem(actor, workspace.id, { title: 'Assigned task', nodeId: list.id, assigneeId: userId }))
  }
  const ctx = await accountContext(admin, { disabled: true }, userId)
  const userCtx = await accountContext(userId, { name: 'User automation' })
  await accounts.createToken(userCtx)
  return { admin, userId, owned, shared, items, ctx, userCtx }
}

test('explicitly enabled registration remains closed until setup, then creates only a non-admin', async () => {
  let cookieValue = ''; let status = 200
  const body = { name: 'New user', email: 'new@example.test', password: 'a long registration password' }
  const ctx = {
    request: { body: () => body, ip: () => '127.0.0.1', cookie: () => undefined },
    response: { cookie: (_name: string, value: string) => { cookieValue = value }, status: (value: number) => { status = value } },
  } as unknown as HttpContext
  await assert.rejects(() => accounts.register(ctx), (error: unknown) => error instanceof HttpError && error.status === 403)
  const adminId = randomUUID()
  await db.run('INSERT INTO users (id,name,email,isAdmin,createdAt) VALUES (?,?,?,?,?)', adminId, 'Admin', 'admin@example.test', 1, new Date().toISOString())
  const user = await accounts.register(ctx)
  assert.equal(status, 201)
  assert.equal(user.isAdmin, false)
  assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'isAdmin', 'name'])
  const row = (await db.get<{ passwordHash: string }>('SELECT passwordHash FROM users WHERE id=?', user.id))!
  assert.equal(await verifyPassword(body.password, row.passwordHash), true)
  assert.ok(await db.get('SELECT id FROM sessions WHERE userId=? AND tokenHash=?', user.id, hashToken(cookieValue)))
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM memberships WHERE userId=?', user.id))!.count, 0)
})
test('site suspension overrides sole ownership, clears assignments across workspaces and supports recovery', async (t) => {
  const f = await suspensionFixture()
  const memberships = await db.all('SELECT * FROM memberships WHERE userId=? ORDER BY workspaceId', f.userId)
  const control = await service.createItem(f.admin, f.shared.id, { title: 'Unaffected', nodeId: f.items[1].nodeId, assigneeId: f.admin })
  t.mock.method(Date, 'now', () => Math.min(...f.items.map((item) => Date.parse(item.updatedAt))))
  assert.equal((await accounts.updateUser(f.ctx)).disabled, true)
  await assert.rejects(() => authenticate(f.userCtx), (error: unknown) => error instanceof HttpError && error.status === 401)
  assert.deepEqual(await db.all('SELECT * FROM memberships WHERE userId=? ORDER BY workspaceId', f.userId), memberships)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM sessions WHERE userId=?', f.userId))!.count, 0)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM tokens WHERE userId=?', f.userId))!.count, 0)
  for (const item of f.items) {
    const cleared = (await db.get<{ assigneeId: null; updatedAt: string }>('SELECT assigneeId,updatedAt FROM items WHERE id=?', item.id))!
    assert.equal(cleared.assigneeId, null)
    assert.equal(Date.parse(cleared.updatedAt), Date.parse(item.updatedAt) + 1)
  }
  assert.deepEqual(await service.getItem(f.admin, f.shared.id, control.id), control)
  const audit = (await db.get<{ details: string }>("SELECT details FROM audit_logs WHERE resourceId=? AND action='admin.user.update'", f.userId))!
  assert.deepEqual(JSON.parse(audit.details), { disabled: true, clearedAssignments: 2, affectedWorkspaces: 2, revokedSessions: 1, revokedTokens: 1 })
  const sharedItem = await service.getItem(f.admin, f.shared.id, f.items[1].id)
  await assert.rejects(() => service.updateItem(f.admin, f.shared.id, sharedItem.id, { expectedUpdatedAt: f.items[1].updatedAt, status: 'done' }), (error: unknown) => error instanceof HttpError && error.status === 409)
  assert.equal((await service.updateItem(f.admin, f.shared.id, sharedItem.id, { expectedUpdatedAt: sharedItem.updatedAt, status: 'done' })).status, 'done')
  const recover = await accountContext(f.admin, { disabled: false }, f.userId)
  assert.equal((await accounts.updateUser(recover)).disabled, false)
  assert.equal((await service.getWorkspace(f.userId, f.owned.id)).role.isOwner, true)
  await assert.rejects(() => authenticate(f.userCtx), (error: unknown) => error instanceof HttpError && error.status === 401)
  assert.equal((await service.updateItem(f.userId, f.owned.id, f.items[0].id, { status: 'done' })).status, 'done')
})
test('suspension rolls back account, credentials and assignments if auditing fails', async () => {
  const f = await suspensionFixture()
  const before = {
    user: await db.get('SELECT * FROM users WHERE id=?', f.userId),
    sessions: await db.all('SELECT * FROM sessions WHERE userId=?', f.userId),
    tokens: await db.all('SELECT * FROM tokens WHERE userId=?', f.userId),
    items: await db.all('SELECT * FROM items WHERE assigneeId=? ORDER BY id', f.userId),
    audits: await db.all('SELECT * FROM audit_logs'),
  }
  await db.run("CREATE TRIGGER fail_suspension_audit BEFORE INSERT ON audit_logs WHEN NEW.action='admin.user.update' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  try { await assert.rejects(() => accounts.updateUser(f.ctx)) }
  finally { await db.run('DROP TRIGGER fail_suspension_audit') }
  assert.deepEqual(await db.get('SELECT * FROM users WHERE id=?', f.userId), before.user)
  assert.deepEqual(await db.all('SELECT * FROM sessions WHERE userId=?', f.userId), before.sessions)
  assert.deepEqual(await db.all('SELECT * FROM tokens WHERE userId=?', f.userId), before.tokens)
  assert.deepEqual(await db.all('SELECT * FROM items WHERE assigneeId=? ORDER BY id', f.userId), before.items)
  assert.deepEqual(await db.all('SELECT * FROM audit_logs'), before.audits)
  assert.equal((await authenticate(f.userCtx)).id, f.userId)
})
test('last active site admin cannot be suspended or demoted, without changing credentials or assignments', async () => {
  const admin = (await db.get<{ id: string }>('SELECT id FROM users WHERE email=?', 'admin@example.test'))!.id
  for (const body of [{ disabled: true }, { isAdmin: false }, { disabled: true, isAdmin: false }]) {
    const ctx = await accountContext(admin, body)
    const sessions = await db.all('SELECT * FROM sessions WHERE userId=?', admin)
    const audits = await db.all('SELECT * FROM audit_logs')
    await assert.rejects(() => accounts.updateUser(ctx), (error: unknown) => error instanceof HttpError && error.status === 409)
    assert.equal((await authenticate(ctx)).isAdmin, true)
    assert.deepEqual(await db.all('SELECT * FROM sessions WHERE userId=?', admin), sessions)
    assert.deepEqual(await db.all('SELECT * FROM audit_logs'), audits)
  }
})

test('profile password changes recheck session/token revocation and expiry after asynchronous hashing', async (t) => {
  const currentPassword = 'profile race current password'
  const passwordHash = await hashPassword(currentPassword)
  for (const scenario of ['token-revoke', 'session-expiry']) {
    await t.test(scenario, async () => {
      const userId = randomUUID()
      const token = randomUUID().replaceAll('-', '')
      const tokenId = randomUUID()
      const bearer = scenario.startsWith('token-')
      const expiresAt = new Date(Date.now() + 86400000).toISOString()
      const createdAt = new Date().toISOString()
      await db.run('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)', userId, 'Original', `${userId}@example.test`, passwordHash, createdAt)
      if (bearer) await db.run('INSERT INTO tokens (id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)', tokenId, userId, 'Race', hashToken(token), expiresAt, createdAt)
      else await db.run('INSERT INTO sessions (id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)', tokenId, userId, hashToken(token), expiresAt, createdAt)
      let replacementCookie = false
      const ctx = {
        request: { body: () => ({ name: 'Changed', currentPassword, password: 'profile race replacement password' }), ip: () => userId,
          header: (name: string) => name === 'authorization' && bearer ? `Bearer ${token}` : undefined, cookie: () => bearer ? undefined : token },
        response: { cookie: () => { replacementCookie = true }, clearCookie: () => {}, header: () => {} },
      } as unknown as HttpContext
      // Async scrypt cannot finish in this turn: withdraw the credential after
      // initial authentication but before either password await can resume.
      const pending = accounts.profile(ctx)
      if (scenario === 'token-revoke') await accounts.deleteToken(await accountContext(userId, {}, tokenId))
      else if (scenario.endsWith('expiry')) await db.run(`UPDATE ${bearer ? 'tokens' : 'sessions'} SET expiresAt=? WHERE id=?`, '2000-01-01T00:00:00.000Z', tokenId)
      const sessions = await db.all('SELECT * FROM sessions WHERE userId=?', userId)
      const tokens = await db.all('SELECT * FROM tokens WHERE userId=?', userId)
      await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.status === 401)
      assert.deepEqual(await db.get('SELECT name,passwordHash FROM users WHERE id=?', userId), { name: 'Original', passwordHash })
      assert.deepEqual(await db.all('SELECT * FROM sessions WHERE userId=?', userId), sessions)
      assert.deepEqual(await db.all('SELECT * FROM tokens WHERE userId=?', userId), tokens)
      assert.equal(await db.get("SELECT id FROM audit_logs WHERE actorId=? AND action='user.profile'", userId), undefined)
      assert.equal(replacementCookie, false)
    })
  }
})

test('email changes require the current password and revoke prior credentials', async () => {
  const userId = randomUUID()
  const currentPassword = 'current email change password'
  const passwordHash = await hashPassword(currentPassword)
  const createdAt = new Date().toISOString()
  await db.run('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)', userId, 'Email owner', `${userId}@example.test`, passwordHash, createdAt)
  const rejected = await accountContext(userId, { name: 'Email owner', email: `new-${userId}@example.test` })
  ;(rejected.request as unknown as { ip: () => string }).ip = () => `email-reject-${userId}`
  ;(rejected.response as unknown as { header: () => void }).header = () => {}
  await assert.rejects(() => accounts.profile(rejected), (error: unknown) => error instanceof HttpError && error.status === 403)
  const accepted = await accountContext(userId, { name: 'Email owner', email: `new-${userId}@example.test`, currentPassword })
  ;(accepted.request as unknown as { ip: () => string }).ip = () => `email-accept-${userId}`
  ;(accepted.response as unknown as { header: () => void; cookie: () => void }).header = () => {}
  ;(accepted.response as unknown as { cookie: () => void }).cookie = () => {}
  const updated = await accounts.profile(accepted)
  assert.equal(updated.email, `new-${userId}@example.test`)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM sessions WHERE userId=?', userId))!.count, 1)
  assert.deepEqual(JSON.parse((await db.get<{ details: string }>("SELECT details FROM audit_logs WHERE actorId=? AND action='user.profile' ORDER BY createdAt DESC LIMIT 1", userId))!.details), { passwordChanged: false, emailChanged: true })
})

test('password reset tokens are hashed, single-use, and revoke all credentials', async () => {
  const userId = randomUUID()
  const oldPassword = 'old reset test password'
  const newPassword = 'new reset test password'
  const createdAt = new Date().toISOString()
  await db.run('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)', userId, 'Reset owner', `${userId}@example.test`, await hashPassword(oldPassword), createdAt)
  const token = randomUUID().replaceAll('-', '') + 'abcdefghijk'
  assert.equal(token.length, 43)
  await db.run('INSERT INTO password_reset_tokens(id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)',
    randomUUID(), userId, hashToken(token), new Date(Date.now() + 60_000).toISOString(), createdAt)
  const session = await accountContext(userId)
  await accounts.createToken(await accountContext(userId, { name: 'Reset token' }))
  let cleared = false
  const resetContext = {
    request: { body: () => ({ token, password: newPassword }), ip: () => `reset-${userId}`, cookie: () => undefined },
    response: { header: () => {}, clearCookie: () => { cleared = true } },
  } as unknown as HttpContext
  assert.deepEqual(await accounts.resetPassword(resetContext), { success: true })
  const row = (await db.get<{ passwordHash: string }>('SELECT passwordHash FROM users WHERE id=?', userId))!
  assert.equal(await verifyPassword(oldPassword, row.passwordHash), false)
  assert.equal(await verifyPassword(newPassword, row.passwordHash), true)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM sessions WHERE userId=?', userId))!.count, 0)
  assert.equal((await db.get<{ count: number }>('SELECT count(*) AS count FROM tokens WHERE userId=?', userId))!.count, 0)
  assert.equal(await db.get('SELECT id FROM password_reset_tokens WHERE userId=?', userId), undefined)
  assert.equal(cleared, true)
  await assert.rejects(() => authenticate(session), (error: unknown) => error instanceof HttpError && error.status === 401)
  await assert.rejects(() => accounts.resetPassword({ ...resetContext, request: { ...resetContext.request, ip: () => `replay-${userId}` } } as unknown as HttpContext), (error: unknown) => error instanceof HttpError && error.status === 400)
  const audit = (await db.get<{ details: string }>("SELECT details FROM audit_logs WHERE actorId=? AND action='auth.password.reset'", userId))!
  assert.deepEqual(JSON.parse(audit.details), { revokedSessions: 2, revokedTokens: 1 })
})

test('forgot-password responses do not disclose account existence and persist only hashed eligible requests', async () => {
  const userId = randomUUID()
  const email = `${userId}@example.test`
  await db.run('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)', userId, 'Recovery request', email, 'eligible-local-hash', new Date().toISOString())
  process.env.SMTP_URL = 'smtp://127.0.0.1:1'
  process.env.SMTP_FROM = 'Hopya <no-reply@example.test>'
  const invoke = async (address: string, ip: string) => {
    let status = 200
    const ctx = {
      request: { body: () => ({ email: address }), ip: () => ip },
      response: { status: (value: number) => { status = value }, header: () => {} },
    } as unknown as HttpContext
    const result = await accounts.forgotPassword(ctx)
    return { status, result }
  }
  try {
    const existing = await invoke(email, `existing-${userId}`)
    const missing = await invoke(`missing-${userId}@example.test`, `missing-${userId}`)
    assert.deepEqual(existing, missing)
    assert.equal(existing.status, 202)
    const row = (await db.get<{ tokenHash: string }>('SELECT tokenHash FROM password_reset_tokens WHERE userId=?', userId))!
    assert.match(row.tokenHash, /^[a-f0-9]{64}$/)
    assert.ok(await db.get("SELECT id FROM audit_logs WHERE actorId=? AND action='auth.password.reset.request'", userId))
  } finally {
    delete process.env.SMTP_URL
    delete process.env.SMTP_FROM
  }
})
