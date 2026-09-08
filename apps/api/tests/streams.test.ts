import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { get, type IncomingMessage } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
test('real HTTP bounded bulk streams, snapshots and live authorization', { timeout: 120000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hopya-streams-'))
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = (listener.address() as { port: number }).port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const base = `http://127.0.0.1:${port}`
  const origin = 'http://localhost:4321'
  const compiled = process.env.HOPYA_TEST_BUILD === 'true'
  const child = spawn(process.execPath, compiled ? ['build/bin/server.js'] : ['--import', 'tsx', 'bin/server.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, DATA_DIR: directory, API_PORT: String(port), HOST: '127.0.0.1', APP_URL: origin,
      NODE_ENV: compiled ? 'production' : 'test', APP_KEY: 'stream-test-key-not-for-deployment-123456789', SETUP_TOKEN: 'stream-test-setup-secret',
      REGISTRATION_ENABLED: 'false', AI_PROVIDER: '', OIDC_ISSUER: '', STORAGE_DRIVER: 'filesystem', LOG_LEVEL: 'fatal' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-20000) })
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-20000) })
  let database: Database.Database | undefined
  const opened = new Set<IncomingMessage>()
  t.after(async () => {
    for (const response of opened) response.destroy()
    database?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited; clearTimeout(timer)
    }
    rmSync(directory, { recursive: true, force: true })
  })
  let ready = false
  for (let n = 0; n < 150; n++) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break } } catch {}
    if (child.exitCode !== null) break
    await sleep(100)
  }
  assert.ok(ready, output)
  database = new Database(join(directory, 'hopya.sqlite'))
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 1000')
  let cookie = ''
  async function api(path: string, method = 'GET', body?: unknown, token?: string) {
    return fetch(`${base}/api/v1${path}`, { method, headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  }
  const setup = await api('/auth/setup', 'POST', { name: 'Admin', email: 'admin@streams.example.test', password: 'stream-test-long-password', setupToken: 'stream-test-setup-secret' })
  assert.equal(setup.status, 201)
  cookie = setup.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  const admin = await setup.json() as { id: string }
  const workspace = await (await api('/workspaces', 'POST', { name: 'Snapshot' })).json() as { id: string }
  const wid = workspace.id
  const project = await (await api(`/workspaces/${wid}/nodes`, 'POST', { name: 'Project', kind: 'project' })).json() as { id: string; createdAt: string }
  const list = await (await api(`/workspaces/${wid}/nodes`, 'POST', { name: 'List', kind: 'list' })).json() as { id: string; createdAt: string }
  const detail = await (await api(`/workspaces/${wid}`)).json() as any
  const users: { id: string; token: string; tokenId: string; roleId: string }[] = []
  const timestamp = '2026-01-01T00:00:00.000Z'
  const ids: string[] = []
  // The large body is allocated in the test parent, not an API fixture route.
  const description = 'Private body %_\\ '.repeat(3000).slice(0, 50000)
  database.transaction(() => {
    for (let n = 0; n < 5; n++) {
      const id = randomUUID(); const roleId = randomUUID(); const tokenId = randomUUID(); const token = randomBytes(32).toString('base64url')
      database!.prepare('INSERT INTO users(id,name,email,passwordHash,createdAt) VALUES (?,?,?,?,?)').run(id, `Reader ${n}`, `${id}@example.test`, 'private-password-hash-marker', timestamp)
      database!.prepare('INSERT INTO roles(id,workspaceId,name,permissions) VALUES (?,?,?,?)').run(roleId, wid, `Reader ${n}`, '["items:read"]')
      database!.prepare('INSERT INTO memberships(workspaceId,userId,roleId) VALUES (?,?,?)').run(wid, id, roleId)
      database!.prepare('INSERT INTO tokens(id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)').run(tokenId, id, 'Private token', createHash('sha256').update(token).digest('hex'), '2099-01-01T00:00:00.000Z', timestamp)
      users.push({ id, token, tokenId, roleId })
    }
    const insert = database!.prepare('INSERT INTO items(id,workspaceId,nodeId,title,description,status,priority,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)')
    for (let n = 0; n < 800; n++) {
      const id = randomUUID(); ids.push(id)
      insert.run(id, wid, list.id, `Item ${n}`, description, n === 0 ? 'done' : 'todo', 'none', new Date(Date.parse(timestamp) + n).toISOString(), timestamp)
    }
    database!.prepare('INSERT INTO fields(id,workspaceId,name,type,options) VALUES (?,?,?,?,?)').run(randomUUID(), wid, 'Color', 'select', '["Red","Blue"]')
    database!.prepare('INSERT INTO storage_objects(objectKey,driver,location,createdAt) VALUES (?,?,?,?)').run('private-storage-key-marker', 'filesystem', 'private-location-marker', timestamp)
    database!.prepare('INSERT INTO attachments(id,workspaceId,itemId,objectKey,name,contentType,size,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?)').run(randomUUID(), wid, ids[0], 'private-storage-key-marker', 'note.txt', 'text/plain', 12, admin.id, timestamp)
  })()
  const path = `/workspaces/${wid}/items`
  async function paused(suffix = path, token = users[0].token, useCookie = false): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = get(`${base}/api/v1${suffix}`, { headers: useCookie ? { cookie } : { authorization: `Bearer ${token}` }, agent: false }, (response) => {
        response.pause(); response.on('error', () => {})
        opened.add(response); response.once('close', () => opened.delete(response))
        resolve(response)
      })
      request.on('error', reject)
    })
  }
  async function text(response: IncomingMessage) {
    let value = ''
    for await (const chunk of response) value += chunk.toString()
    return value
  }
  async function truncated(response: IncomingMessage) {
    await assert.rejects(async () => { for await (const _chunk of response) {} })
    assert.equal(response.complete, false)
  }

  await t.test('page routing and invalid/auth parameters fail before bulk headers; legacy filters and redaction remain intact', async () => {
    const page = await api(`${path}/page?limit=2`)
    assert.equal(page.status, 200)
    const result = await page.json() as any
    assert.equal(result.items.length, 2); assert.equal(typeof result.nextCursor, 'string')
    for (const suffix of ['?limit=1', '?search[]=x', '?status=unsafe%20id', '?nodeId=bad', '?search=true&search=false']) {
      const response = await api(path + suffix)
      assert.equal(response.status, 400, suffix)
      assert.deepEqual(Object.keys(await response.json() as object), ['error'])
    }
    for (const suffix of ['?limit=true', '?limit[]=1', '?limit=0', '?limit=501', '?cursor[]=x', '?cursor=%20', '?cursor=' + 'x'.repeat(1025)]) assert.equal((await api(path + '/page' + suffix)).status, 400)
    assert.equal((await api(path, 'GET', undefined, 'x'.repeat(43))).status, 401)
    assert.deepEqual(await (await api(path + '?status=unconfigured-safe-id')).json(), [])
    const filtered = await (await api(path + '?status=done&search=%25_%5C')).json() as any[]
    assert.equal(filtered.length, 1); assert.equal(filtered[0].id, ids[0])
    assert.equal(filtered[0].description, description)
    assert.equal((await (await api(path + `?nodeId=${project.id}`)).json() as any[]).length, 0)
  })

  await t.test('paused snapshot export permits HTTP writes and preserves complete old workspace/nodes/items/fields/attachment metadata', async () => {
    const response = await paused(`/workspaces/${wid}/export`)
    assert.equal(response.statusCode, 200)
    const start = Date.now()
    assert.equal((await api(`${path}/${ids.at(-1)}`, 'PATCH', { title: 'Changed after snapshot' })).status, 200)
    assert.equal((await api(`/workspaces/${wid}`, 'PATCH', { name: 'Changed workspace' })).status, 200)
    assert.equal((await api(`/workspaces/${wid}/nodes/${list.id}`, 'PATCH', { name: 'Changed list' })).status, 200)
    assert.ok(Date.now() - start < 2500, 'snapshot must not busy the writer')
    database!.prepare('DELETE FROM attachments WHERE workspaceId=?').run(wid)
    database!.prepare('DELETE FROM fields WHERE workspaceId=?').run(wid)
    const body = await text(response)
    for (const secret of ['passwordHash', 'tokenHash', 'private-password-hash-marker', 'private-storage-key-marker', 'private-location-marker', ...users.map((user) => user.token)]) assert.equal(body.includes(secret), false)
    const data = JSON.parse(body)
    assert.deepEqual(Object.keys(data).sort(), ['attachments', 'commentReactions', 'comments', 'exportedAt', 'fields', 'items', 'listStatusConfigs', 'listTagColorConfigs', 'nodes', 'projectFields', 'version', 'workspace'])
    assert.equal(data.version, 3); assert.equal(data.workspace.name, 'Snapshot')
    assert.equal(data.nodes.find((node: any) => node.id === list.id).name, 'List')
    assert.equal(data.items.length, 800); assert.equal(data.items.at(-1).title, 'Item 799')
    assert.deepEqual(data.items.map((item: any) => item.id), ids)
    assert.ok(data.items.every((item: any) => item.description === description))
    assert.deepEqual(data.fields[0].options, ['Red', 'Blue'])
    assert.deepEqual(data.listStatusConfigs, detail.listStatusConfigs)
    assert.deepEqual(data.listTagColorConfigs, [{ listId: list.id, colors: {}, updatedAt: list.createdAt }])
    assert.equal(data.attachments.length, 1)
    assert.deepEqual(Object.keys(data.attachments[0]).sort(), ['contentType', 'createdAt', 'id', 'itemId', 'name', 'size'])
    assert.ok(body.length > 40_000_000)
    t.diagnostic(`Complete snapshot: ${Buffer.byteLength(body)} bytes, 800 items; concurrent writes completed before the paused reader resumed`)
  })

  await t.test('per-user and global admission, HEAD and disconnect release snapshots and slots', async () => {
    const held: IncomingMessage[] = []
    try {
      held.push(await paused(), await paused())
      const denied = await api(path, 'GET', undefined, users[0].token)
      assert.equal(denied.status, 429); assert.equal(denied.headers.get('retry-after'), '1')
      for (const endpoint of [path, `/workspaces/${wid}/export`]) assert.equal((await api(endpoint, 'HEAD', undefined, users[0].token)).status, 200)
      for (let n = 1; n < 4; n++) held.push(await paused(path, users[n].token), await paused(path, users[n].token))
      assert.ok(held.every((response) => response.statusCode === 200))
      assert.equal((await api(path, 'GET', undefined, users[4].token)).status, 429)
      assert.equal((await api(path + '?status=unsafe%20id', 'GET', undefined, users[4].token)).status, 400)
    } finally { for (const response of held) response.destroy() }
    await sleep(150)
    const replacement = await paused(); assert.equal(replacement.statusCode, 200); replacement.destroy()
    await sleep(100)
    const checkpoint = database!.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    assert.equal(checkpoint[0].busy, 0)
  })

  await t.test('role, token, disabled user, removed membership and logout terminate in-flight JSON rather than completing it', async () => {
    for (const kind of ['role', 'token', 'disabled', 'membership', 'logout']) {
      const response = await paused(path, users[0].token, kind === 'logout')
      assert.equal(response.statusCode, 200)
      if (kind === 'role') assert.equal((await api(`/workspaces/${wid}/roles/${users[0].roleId}`, 'PATCH', { permissions: [] })).status, 200)
      if (kind === 'token') assert.equal((await api(`/auth/tokens/${users[0].tokenId}`, 'DELETE', undefined, users[0].token)).status, 200)
      if (kind === 'disabled') assert.equal((await api(`/admin/users/${users[0].id}`, 'PATCH', { disabled: true })).status, 200)
      if (kind === 'membership') assert.equal((await api(`/workspaces/${wid}/members/${users[0].id}`, 'DELETE')).status, 200)
      if (kind === 'logout') assert.equal((await api('/auth/logout', 'POST')).status, 200)
      await truncated(response)
      if (kind === 'role') database!.prepare('UPDATE roles SET permissions=? WHERE id=?').run('["items:read"]', users[0].roleId)
      if (kind === 'membership') database!.prepare('INSERT INTO memberships(workspaceId,userId,roleId) VALUES (?,?,?)').run(wid, users[0].id, users[0].roleId)
      if (kind === 'disabled') database!.prepare('UPDATE users SET disabled=0 WHERE id=?').run(users[0].id)
      if (kind === 'disabled' || kind === 'token') database!.prepare('INSERT INTO tokens(id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)').run(users[0].tokenId, users[0].id, 'Restored test token', createHash('sha256').update(users[0].token).digest('hex'), '2099-01-01T00:00:00.000Z', timestamp)
      if (kind === 'logout') {
        const login = await api('/auth/login', 'POST', { email: 'admin@streams.example.test', password: 'stream-test-long-password' })
        assert.equal(login.status, 200); cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
      }
    }
  })

  await t.test('30-second deadline releases a stalled snapshot even with no client reads', { timeout: 40000 }, async () => {
    const response = await paused()
    assert.equal(response.statusCode, 200)
    await sleep(31_000)
    assert.equal((database!.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0].busy, 0)
    await truncated(response)
    const replacement = await paused(); assert.equal(replacement.statusCode, 200); replacement.destroy()
    await sleep(100)
  })

  await t.test('packed chunks preserve multibyte records and an unpadded final chunk', async () => {
    const created: { id: string; description: string }[] = []
    try {
      for (let i = 0; i < 3; i++) {
        const response = await api(path, 'POST', { nodeId: list.id, title: `utf8-pack-${i}`, description: '\u754c'.repeat(11000) + `-${i}` })
        assert.equal(response.status, 201)
        created.push(await response.json() as { id: string; description: string })
      }
      const response = await api(path + '?search=utf8-pack-')
      assert.equal(response.status, 200)
      const raw = await response.text()
      assert.ok(Buffer.byteLength(raw) > 65536)
      assert.equal(raw.includes('\u0000'), false)
      const items = JSON.parse(raw) as { id: string; description: string }[]
      assert.equal(items.length, 3)
      for (const item of items) assert.equal(item.description, created.find((record) => record.id === item.id)?.description)
    } finally {
      for (const item of created) assert.equal((await api(`${path}/${item.id}`, 'DELETE')).status, 200)
    }
  })

  await t.test('oversized/corrupt stored rows fail safely before or after response headers', async () => {
    database!.prepare('UPDATE items SET description=? WHERE id=?').run('x'.repeat(8 * 1024 * 1024), ids[0])
    const response = await paused(path + '?status=done')
    assert.equal(response.statusCode, 500)
    assert.deepEqual(JSON.parse(await text(response)), { error: 'Bulk read failed' })
    database!.prepare('UPDATE items SET description=?,tags=? WHERE id=?').run(description, 'not-json-private-marker', ids[0])
    const corrupt = await paused(path + '?status=done')
    assert.equal(corrupt.statusCode, 500)
    assert.deepEqual(JSON.parse(await text(corrupt)), { error: 'Bulk read failed' })
    database!.prepare("UPDATE items SET tags='[]' WHERE id=?").run(ids[0])
    // Later invalid records must abort an already-started JSON response instead.
    for (const [body, tags] of [['x'.repeat(8 * 1024 * 1024), '[]'], [description, 'not-json-private-marker']]) {
      database!.prepare('UPDATE items SET description=?,tags=? WHERE id=?').run(body, tags, ids[5])
      try {
        const late = await paused(path)
        assert.equal(late.statusCode, 200)
        await truncated(late)
      } finally { database!.prepare("UPDATE items SET description=?,tags='[]' WHERE id=?").run(description, ids[5]) }
    }
    assert.equal((await api(path + '?status=done')).status, 200)
    assert.equal(output.includes('not-json-private-marker'), false)
  })

  await t.test('never-started generators release their connection and admission slot on response finish/close and request abort', async () => {
    process.env.DATA_DIR = directory
    const { streamTasks } = await import('../app/task_streams.js')
    const { db } = await import('../app/database.js')
    const { EventEmitter } = await import('node:events')
    const { Readable } = await import('node:stream')
    const streams: InstanceType<typeof Readable>[] = []
    function context() {
      const raw = Object.assign(new EventEmitter(), { destroyed: false })
      const request = Object.assign(new EventEmitter(), { aborted: false })
      return { params: { wid }, request: { request, header: (name: string) => name === 'authorization' ? `Bearer ${users[0].token}` : undefined, qs: () => ({}), method: () => 'GET' }, response: { response: raw, type() {}, header() {}, stream(value: InstanceType<typeof Readable>) { streams.push(value) } } }
    }
    try {
      for (const event of ['finish', 'close', 'aborted']) {
        const a = context(); const b = context()
        streamTasks(a as any, false); streamTasks(b as any, false)
        assert.throws(() => streamTasks(context() as any, false), /Too many bulk reads/)
        if (event === 'aborted') { a.request.request.emit(event); b.request.request.emit(event) }
        else { a.response.response.emit(event); b.response.response.emit(event) }
        assert.equal((database!.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[])[0].busy, 0)
      }
    } finally { for (const stream of streams) stream.destroy(); db.close() }
  })
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok')
  assert.ok(detail.roles.some((role: any) => role.isOwner))
})
