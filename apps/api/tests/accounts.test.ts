import { test, after } from './japa.js'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { migrateDatabase } from './helpers/migrate.js'

const directory = mkdtempSync(join(tmpdir(), 'hopya-accounts-'))
process.env.DATA_DIR = directory
process.env.REGISTRATION_ENABLED = 'true'
migrateDatabase()
const { db, HttpError, service, authenticate } = await import('../app/core.js')
const { accounts } = await import('../app/accounts.js')
const { verifyPassword, hashPassword, hashToken } = await import('../app/security.js')
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

function accountContext(userId: string, body: unknown = {}, targetId = userId): HttpContext {
  const token = randomUUID()
  db.prepare('INSERT INTO sessions (id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)')
    .run(randomUUID(), userId, hashToken(token), new Date(Date.now() + 86400000).toISOString(), new Date().toISOString())
  return { params: { id: targetId }, request: { body: () => body, header: () => undefined, cookie: () => token }, response: { status: () => {} } } as unknown as HttpContext
}
function suspensionFixture() {
  const admin = (db.prepare('SELECT id FROM users WHERE email=?').get('admin@example.test') as { id: string }).id
  const userId = randomUUID()
  db.prepare('INSERT INTO users (id,name,email,createdAt) VALUES (?,?,?,?)').run(userId, 'Suspend', `${userId}@example.test`, new Date().toISOString())
  const owned = service.createWorkspace(userId, { name: 'Sole-owned workspace' })
  const shared = service.createWorkspace(admin, { name: 'Shared workspace' })
  const viewer = service.listRoles(admin, shared.id).find((role) => role.name === 'Viewer')!
  service.addMember(admin, shared.id, { email: `${userId}@example.test`, roleId: viewer.id })
  const items = [owned, shared].map((workspace) => {
    const actor = workspace.id === owned.id ? userId : admin
    const project = service.createNode(actor, workspace.id, { name: 'Project', kind: 'project' })
    const list = service.createNode(actor, workspace.id, { name: 'List', kind: 'list', parentId: project.id })
    return service.createItem(actor, workspace.id, { title: 'Assigned task', nodeId: list.id, assigneeId: userId })
  })
  const ctx = accountContext(admin, { disabled: true }, userId)
  const userCtx = accountContext(userId, { name: 'User automation' })
  accounts.createToken(userCtx)
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
  db.prepare('INSERT INTO users (id,name,email,isAdmin,createdAt) VALUES (?,?,?,?,?)').run(adminId, 'Admin', 'admin@example.test', 1, new Date().toISOString())
  const user = await accounts.register(ctx)
  assert.equal(status, 201)
  assert.equal(user.isAdmin, false)
  assert.deepEqual(Object.keys(user).sort(), ['email', 'id', 'isAdmin', 'name'])
  const row = db.prepare('SELECT passwordHash FROM users WHERE id=?').get(user.id) as { passwordHash: string }
  assert.equal(await verifyPassword(body.password, row.passwordHash), true)
  assert.ok(db.prepare('SELECT id FROM sessions WHERE userId=? AND tokenHash=?').get(user.id, hashToken(cookieValue)))
  assert.equal((db.prepare('SELECT count(*) AS count FROM memberships WHERE userId=?').get(user.id) as { count: number }).count, 0)
})
test('site suspension overrides sole ownership, clears assignments across workspaces and supports recovery', (t) => {
  const f = suspensionFixture()
  const memberships = db.prepare('SELECT * FROM memberships WHERE userId=? ORDER BY workspaceId').all(f.userId)
  const control = service.createItem(f.admin, f.shared.id, { title: 'Unaffected', nodeId: f.items[1].nodeId, assigneeId: f.admin })
  t.mock.method(Date, 'now', () => Math.min(...f.items.map((item) => Date.parse(item.updatedAt))))
  assert.equal(accounts.updateUser(f.ctx).disabled, true)
  assert.throws(() => authenticate(f.userCtx), (error: unknown) => error instanceof HttpError && error.status === 401)
  assert.deepEqual(db.prepare('SELECT * FROM memberships WHERE userId=? ORDER BY workspaceId').all(f.userId), memberships)
  assert.equal((db.prepare('SELECT count(*) AS count FROM sessions WHERE userId=?').get(f.userId) as { count: number }).count, 0)
  assert.equal((db.prepare('SELECT count(*) AS count FROM tokens WHERE userId=?').get(f.userId) as { count: number }).count, 0)
  for (const item of f.items) {
    const cleared = db.prepare('SELECT assigneeId,updatedAt FROM items WHERE id=?').get(item.id) as { assigneeId: null; updatedAt: string }
    assert.equal(cleared.assigneeId, null)
    assert.equal(Date.parse(cleared.updatedAt), Date.parse(item.updatedAt) + 1)
  }
  assert.deepEqual(service.getItem(f.admin, f.shared.id, control.id), control)
  const audit = db.prepare("SELECT details FROM audit_logs WHERE resourceId=? AND action='admin.user.update'").get(f.userId) as { details: string }
  assert.deepEqual(JSON.parse(audit.details), { disabled: true, clearedAssignments: 2, affectedWorkspaces: 2, revokedSessions: 1, revokedTokens: 1 })
  const sharedItem = service.getItem(f.admin, f.shared.id, f.items[1].id)
  assert.throws(() => service.updateItem(f.admin, f.shared.id, sharedItem.id, { expectedUpdatedAt: f.items[1].updatedAt, status: 'done' }), (error: unknown) => error instanceof HttpError && error.status === 409)
  assert.equal(service.updateItem(f.admin, f.shared.id, sharedItem.id, { expectedUpdatedAt: sharedItem.updatedAt, status: 'done' }).status, 'done')
  const recover = accountContext(f.admin, { disabled: false }, f.userId)
  assert.equal(accounts.updateUser(recover).disabled, false)
  assert.equal(service.getWorkspace(f.userId, f.owned.id).role.isOwner, true)
  assert.throws(() => authenticate(f.userCtx), (error: unknown) => error instanceof HttpError && error.status === 401)
  assert.equal(service.updateItem(f.userId, f.owned.id, f.items[0].id, { status: 'done' }).status, 'done')
})
test('suspension rolls back account, credentials and assignments if auditing fails', () => {
  const f = suspensionFixture()
  const before = {
    user: db.prepare('SELECT * FROM users WHERE id=?').get(f.userId),
    sessions: db.prepare('SELECT * FROM sessions WHERE userId=?').all(f.userId),
    tokens: db.prepare('SELECT * FROM tokens WHERE userId=?').all(f.userId),
    items: db.prepare('SELECT * FROM items WHERE assigneeId=? ORDER BY id').all(f.userId),
    audits: db.prepare('SELECT * FROM audit_logs').all(),
  }
  db.exec("CREATE TRIGGER fail_suspension_audit BEFORE INSERT ON audit_logs WHEN NEW.action='admin.user.update' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
  try { assert.throws(() => accounts.updateUser(f.ctx)) }
  finally { db.exec('DROP TRIGGER fail_suspension_audit') }
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(f.userId), before.user)
  assert.deepEqual(db.prepare('SELECT * FROM sessions WHERE userId=?').all(f.userId), before.sessions)
  assert.deepEqual(db.prepare('SELECT * FROM tokens WHERE userId=?').all(f.userId), before.tokens)
  assert.deepEqual(db.prepare('SELECT * FROM items WHERE assigneeId=? ORDER BY id').all(f.userId), before.items)
  assert.deepEqual(db.prepare('SELECT * FROM audit_logs').all(), before.audits)
  assert.equal(authenticate(f.userCtx).id, f.userId)
})
test('last active site admin cannot be suspended or demoted, without changing credentials or assignments', () => {
  const admin = (db.prepare('SELECT id FROM users WHERE email=?').get('admin@example.test') as { id: string }).id
  for (const body of [{ disabled: true }, { isAdmin: false }, { disabled: true, isAdmin: false }]) {
    const ctx = accountContext(admin, body)
    const sessions = db.prepare('SELECT * FROM sessions WHERE userId=?').all(admin)
    const audits = db.prepare('SELECT * FROM audit_logs').all()
    assert.throws(() => accounts.updateUser(ctx), (error: unknown) => error instanceof HttpError && error.status === 409)
    assert.equal(authenticate(ctx).isAdmin, true)
    assert.deepEqual(db.prepare('SELECT * FROM sessions WHERE userId=?').all(admin), sessions)
    assert.deepEqual(db.prepare('SELECT * FROM audit_logs').all(), audits)
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
      db.prepare('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)').run(userId, 'Original', `${userId}@example.test`, passwordHash, createdAt)
      if (bearer) db.prepare('INSERT INTO tokens (id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)').run(tokenId, userId, 'Race', hashToken(token), expiresAt, createdAt)
      else db.prepare('INSERT INTO sessions (id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)').run(tokenId, userId, hashToken(token), expiresAt, createdAt)
      let replacementCookie = false
      const ctx = {
        request: { body: () => ({ name: 'Changed', currentPassword, password: 'profile race replacement password' }), ip: () => userId,
          header: (name: string) => name === 'authorization' && bearer ? `Bearer ${token}` : undefined, cookie: () => bearer ? undefined : token },
        response: { cookie: () => { replacementCookie = true }, clearCookie: () => {}, header: () => {} },
      } as unknown as HttpContext
      // Async scrypt cannot finish in this turn: withdraw the credential after
      // initial authentication but before either password await can resume.
      const pending = accounts.profile(ctx)
      if (scenario === 'token-revoke') accounts.deleteToken(accountContext(userId, {}, tokenId))
      else if (scenario.endsWith('expiry')) db.prepare(`UPDATE ${bearer ? 'tokens' : 'sessions'} SET expiresAt=? WHERE id=?`).run('2000-01-01T00:00:00.000Z', tokenId)
      const sessions = db.prepare('SELECT * FROM sessions WHERE userId=?').all(userId)
      const tokens = db.prepare('SELECT * FROM tokens WHERE userId=?').all(userId)
      await assert.rejects(pending, (error: unknown) => error instanceof HttpError && error.status === 401)
      assert.deepEqual(db.prepare('SELECT name,passwordHash FROM users WHERE id=?').get(userId), { name: 'Original', passwordHash })
      assert.deepEqual(db.prepare('SELECT * FROM sessions WHERE userId=?').all(userId), sessions)
      assert.deepEqual(db.prepare('SELECT * FROM tokens WHERE userId=?').all(userId), tokens)
      assert.equal(db.prepare("SELECT id FROM audit_logs WHERE actorId=? AND action='user.profile'").get(userId), undefined)
      assert.equal(replacementCookie, false)
    })
  }
})

test('email changes require the current password and revoke prior credentials', async () => {
  const userId = randomUUID()
  const currentPassword = 'current email change password'
  const passwordHash = await hashPassword(currentPassword)
  const createdAt = new Date().toISOString()
  db.prepare('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)').run(userId, 'Email owner', `${userId}@example.test`, passwordHash, createdAt)
  const rejected = accountContext(userId, { name: 'Email owner', email: `new-${userId}@example.test` })
  ;(rejected.request as unknown as { ip: () => string }).ip = () => `email-reject-${userId}`
  ;(rejected.response as unknown as { header: () => void }).header = () => {}
  await assert.rejects(() => accounts.profile(rejected), (error: unknown) => error instanceof HttpError && error.status === 403)
  const accepted = accountContext(userId, { name: 'Email owner', email: `new-${userId}@example.test`, currentPassword })
  ;(accepted.request as unknown as { ip: () => string }).ip = () => `email-accept-${userId}`
  ;(accepted.response as unknown as { header: () => void; cookie: () => void }).header = () => {}
  ;(accepted.response as unknown as { cookie: () => void }).cookie = () => {}
  const updated = await accounts.profile(accepted)
  assert.equal(updated.email, `new-${userId}@example.test`)
  assert.equal((db.prepare('SELECT count(*) AS count FROM sessions WHERE userId=?').get(userId) as { count: number }).count, 1)
  assert.deepEqual(JSON.parse((db.prepare("SELECT details FROM audit_logs WHERE actorId=? AND action='user.profile' ORDER BY createdAt DESC LIMIT 1").get(userId) as { details: string }).details), { passwordChanged: false, emailChanged: true })
})

test('password reset tokens are hashed, single-use, and revoke all credentials', async () => {
  const userId = randomUUID()
  const oldPassword = 'old reset test password'
  const newPassword = 'new reset test password'
  const createdAt = new Date().toISOString()
  db.prepare('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)').run(userId, 'Reset owner', `${userId}@example.test`, await hashPassword(oldPassword), createdAt)
  const token = randomUUID().replaceAll('-', '') + 'abcdefghijk'
  assert.equal(token.length, 43)
  db.prepare('INSERT INTO password_reset_tokens(id,userId,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?)')
    .run(randomUUID(), userId, hashToken(token), new Date(Date.now() + 60_000).toISOString(), createdAt)
  const session = accountContext(userId)
  accounts.createToken(accountContext(userId, { name: 'Reset token' }))
  let cleared = false
  const resetContext = {
    request: { body: () => ({ token, password: newPassword }), ip: () => `reset-${userId}`, cookie: () => undefined },
    response: { header: () => {}, clearCookie: () => { cleared = true } },
  } as unknown as HttpContext
  assert.deepEqual(await accounts.resetPassword(resetContext), { success: true })
  const row = db.prepare('SELECT passwordHash FROM users WHERE id=?').get(userId) as { passwordHash: string }
  assert.equal(await verifyPassword(oldPassword, row.passwordHash), false)
  assert.equal(await verifyPassword(newPassword, row.passwordHash), true)
  assert.equal((db.prepare('SELECT count(*) AS count FROM sessions WHERE userId=?').get(userId) as { count: number }).count, 0)
  assert.equal((db.prepare('SELECT count(*) AS count FROM tokens WHERE userId=?').get(userId) as { count: number }).count, 0)
  assert.equal(db.prepare('SELECT id FROM password_reset_tokens WHERE userId=?').get(userId), undefined)
  assert.equal(cleared, true)
  assert.throws(() => authenticate(session), (error: unknown) => error instanceof HttpError && error.status === 401)
  await assert.rejects(() => accounts.resetPassword({ ...resetContext, request: { ...resetContext.request, ip: () => `replay-${userId}` } } as unknown as HttpContext), (error: unknown) => error instanceof HttpError && error.status === 400)
  const audit = db.prepare("SELECT details FROM audit_logs WHERE actorId=? AND action='auth.password.reset'").get(userId) as { details: string }
  assert.deepEqual(JSON.parse(audit.details), { revokedSessions: 2, revokedTokens: 1 })
})

test('forgot-password responses do not disclose account existence and persist only hashed eligible requests', () => {
  const userId = randomUUID()
  const email = `${userId}@example.test`
  db.prepare('INSERT INTO users (id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)').run(userId, 'Recovery request', email, 'eligible-local-hash', new Date().toISOString())
  process.env.SMTP_URL = 'smtp://127.0.0.1:1'
  process.env.SMTP_FROM = 'Hopya <no-reply@example.test>'
  const invoke = (address: string, ip: string) => {
    let status = 200
    const ctx = {
      request: { body: () => ({ email: address }), ip: () => ip },
      response: { status: (value: number) => { status = value }, header: () => {} },
    } as unknown as HttpContext
    const result = accounts.forgotPassword(ctx)
    return { status, result }
  }
  try {
    const existing = invoke(email, `existing-${userId}`)
    const missing = invoke(`missing-${userId}@example.test`, `missing-${userId}`)
    assert.deepEqual(existing, missing)
    assert.equal(existing.status, 202)
    const row = db.prepare('SELECT tokenHash FROM password_reset_tokens WHERE userId=?').get(userId) as { tokenHash: string }
    assert.match(row.tokenHash, /^[a-f0-9]{64}$/)
    assert.ok(db.prepare("SELECT id FROM audit_logs WHERE actorId=? AND action='auth.password.reset.request'").get(userId))
  } finally {
    delete process.env.SMTP_URL
    delete process.env.SMTP_FROM
  }
})
