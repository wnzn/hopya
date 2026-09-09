import { test } from './japa.js'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync, symlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { integrationServer } from './storage-sso-fixture.js'

test('filesystem attachments over real Adonis HTTP: auth, bounds, private bytes, cascade GC', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t)
  const owner = await f.user(true); const other = await f.user(true)
  const item = await f.item(owner.token); const foreign = await f.item(other.token)
  const payload = { name: 'report.html', contentType: 'text/html', data: Buffer.from('<script>alert(1)</script>').toString('base64') }
  const upload = (body: unknown = payload, token = owner.token) => f.request(item.path, { method: 'POST', token, body })
  assert.equal((await f.request(item.path)).status, 401)
  assert.equal((await upload(payload, other.token)).status, 403)
  assert.equal((await f.request(item.path, { method: 'POST', token: owner.token, origin: 'https://evil.test', body: payload })).status, 403)
  for (const body of [{ ...payload, name: '../secret' }, { ...payload, name: 'bad\r\nheader' }, { ...payload, contentType: 'text/plain\r\nX-Bad: true' },
    { ...payload, name: '\ud800' }, { ...payload, data: 'Zm9v!!' }, { ...payload, data: 'Zh==' }, { ...payload, objectKey: '../secret' }]) assert.equal((await upload(body)).status, 400)
  const result = await upload()
  assert.equal(result.status, 201, await result.clone().text())
  const attachment = await result.json() as { id: string; name: string; size: number; contentType: string; createdAt: string }
  assert.deepEqual(Object.keys(attachment).sort(), ['contentType', 'createdAt', 'id', 'name', 'size'])
  assert.equal(attachment.size, Buffer.from(payload.data, 'base64').length)
  const row = await f.db.get<{ objectKey: string }>('SELECT * FROM attachments WHERE id=?', attachment.id)
  assert.ok(row)
  assert.notEqual(row.objectKey, attachment.id)
  assert.match(row.objectKey, /^[a-f0-9-]{36}$/)
  assert.equal(statSync(join(f.directory, 'objects')).mode & 0o777, 0o700)
  assert.equal(statSync(join(f.directory, 'objects', row.objectKey)).mode & 0o777, 0o600)
  assert.equal(readFileSync(join(f.directory, 'objects', row.objectKey), 'utf8'), '<script>alert(1)</script>')
  assert.deepEqual(await (await f.request(item.path, { token: owner.token })).json(), [attachment])
  const download = await f.request(`${item.path}/${attachment.id}`, { token: owner.token })
  assert.equal(download.status, 200)
  assert.equal(await download.text(), '<script>alert(1)</script>')
  assert.match(download.headers.get('content-disposition')!, /^attachment;.*filename\*=UTF-8''report.html$/)
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(download.headers.get('content-type'), 'application/octet-stream')
  assert.equal((await f.request(`${foreign.path}/${attachment.id}`, { token: other.token })).status, 404)
  assert.equal((await f.request(`${item.path}/${attachment.id}`, { token: other.token })).status, 403)
  const viewer = await f.user()
  const role = await f.db.get<{ id: string }>("SELECT id FROM roles WHERE workspaceId=? AND name='Viewer'", item.wid)
  assert.ok(role)
  await f.db.run('INSERT INTO memberships (workspaceId,userId,roleId) VALUES (?,?,?)', item.wid, viewer.id, role.id)
  assert.equal((await f.request(item.path, { token: viewer.token })).status, 200)
  assert.equal((await upload(payload, viewer.token)).status, 403)
  assert.equal((await f.request(`${item.path}/${attachment.id}`, { method: 'DELETE', token: viewer.token })).status, 403)
  const maximum = await upload({ ...payload, data: Buffer.alloc(10 * 1024 * 1024).toString('base64') })
  assert.equal(maximum.status, 201, await maximum.clone().text())
  assert.equal((await upload({ ...payload, data: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') })).status, 413)
  const deleted = await f.request(`${item.path}/${attachment.id}`, { method: 'DELETE', token: owner.token })
  assert.deepEqual(await deleted.json(), { success: true, cleanupPending: false })
  assert.equal(existsSync(join(f.directory, 'objects', row.objectKey)), false)
  assert.equal((await f.request(`${item.path}/${attachment.id}`, { token: owner.token })).status, 404)
  assert.equal((await f.request(`/workspaces/${item.wid}/items/${item.id}`, { method: 'DELETE', token: owner.token })).status, 200)
  assert.equal((await f.db.get<{ count: number }>('SELECT count(*) AS count FROM attachments'))?.count, 0)
  assert.deepEqual(await f.collect(), { scanned: 0, deleted: 0, failed: 0 })
  await f.db.run('UPDATE storage_objects SET createdAt=?', '2000-01-01T00:00:00.000Z')
  assert.deepEqual(await f.collect(), { scanned: 1, deleted: 1, failed: 0 })
  assert.deepEqual(readdirSync(join(f.directory, 'objects')), [])
  const audit = JSON.stringify(await f.db.all("SELECT * FROM audit_logs WHERE action LIKE 'attachment.%'"))
  assert.ok(audit.includes('attachment.create'))
  assert.ok(audit.includes('attachment.delete'))
  assert.equal(audit.includes(payload.data), false)
  assert.deepEqual(await f.db.all('PRAGMA foreign_key_check'), [])
})

test('filesystem refuses a symlinked object directory without disclosing local files', { timeout: 30000 }, async (t) => {
  const f = await integrationServer(t)
  const owner = await f.user(); const item = await f.item(owner.token)
  symlinkSync(f.directory, join(f.directory, 'objects'))
  const result = await f.request(item.path, { method: 'POST', token: owner.token, body: { name: 'bad', contentType: 'text/plain', data: 'aGk=' } })
  assert.equal(result.status, 503)
  assert.deepEqual(await result.json(), { error: 'Attachment storage unavailable' })
  assert.equal((await f.db.get<{ count: number }>('SELECT count(*) AS count FROM attachments'))?.count, 0)
  assert.equal(readdirSync(f.directory).filter((name) => /^[a-f0-9-]{36}$/.test(name)).length, 0)
})

test('AWS SDK against a local S3 mock: private signed requests, revocation races, compensation and GC', { timeout: 60000 }, async (t) => {
  const objects = new Map<string, Buffer>()
  let failPut = false; let failDelete = false; let oversized = false
  let onPut = async () => {}; let onGet = async () => {}; let onDelete = async () => {}
  const seen: Array<{ method: string; url: string; authorization: string; acl?: string }> = []
  const server = createServer(async (request, response) => {
    const key = new URL(request.url!, 'http://localhost').pathname
    seen.push({ method: request.method!, url: key, authorization: String(request.headers.authorization), acl: request.headers['x-amz-acl'] as string | undefined })
    if (request.method === 'PUT') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      if (failPut) { response.writeHead(503); response.end('<Error><Code>Unavailable</Code><Message>secret mock credential</Message></Error>'); return }
      objects.set(key, Buffer.concat(chunks)); await onPut(); response.writeHead(200); response.end()
    } else if (request.method === 'GET') {
      await onGet()
      if (!objects.has(key)) { response.writeHead(404); response.end(); return }
      response.writeHead(200); response.end(oversized ? Buffer.alloc(10 * 1024 * 1024 + 1) : objects.get(key))
    } else if (request.method === 'DELETE') {
      await onDelete()
      if (failDelete) { response.writeHead(503); response.end('<Error><Code>Unavailable</Code></Error>'); return }
      objects.delete(key); response.writeHead(204); response.end()
    } else { response.writeHead(404); response.end() }
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const f = await integrationServer(t, { STORAGE_DRIVER: 's3', S3_BUCKET: 'private-test', S3_REGION: 'us-east-1', S3_ENDPOINT: endpoint,
    S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'mock-access', AWS_SECRET_ACCESS_KEY: 'mock-secret', AWS_EC2_METADATA_DISABLED: 'true' })
  const owner = await f.user(); const item = await f.item(owner.token)
  const payload = { name: 'private.txt', contentType: 'text/plain', data: 'aGk=' }
  const upload = () => f.request(item.path, { method: 'POST', token: owner.token, body: payload })
  let response = await upload()
  assert.equal(response.status, 201, await response.clone().text())
  const saved = await response.json() as { id: string }
  assert.equal(await (await f.request(`${item.path}/${saved.id}`, { token: owner.token })).text(), 'hi')
  assert.ok(seen.every((request) => request.url.startsWith('/private-test/') && request.authorization.startsWith('AWS4-HMAC-SHA256 ') && request.acl === undefined))
  oversized = true
  assert.equal((await f.request(`${item.path}/${saved.id}`, { token: owner.token })).status, 503)
  oversized = false
  onGet = async () => { await f.db.run('UPDATE users SET disabled=1 WHERE id=?', owner.id) }
  assert.equal((await f.request(`${item.path}/${saved.id}`, { token: owner.token })).status, 401)
  onGet = async () => {}; await f.db.run('UPDATE users SET disabled=0 WHERE id=?', owner.id)
  onPut = async () => { await f.db.run('UPDATE users SET disabled=1 WHERE id=?', owner.id) }
  assert.equal((await upload()).status, 401)
  assert.equal(objects.size, 1)
  onPut = async () => {}; await f.db.run('UPDATE users SET disabled=0 WHERE id=?', owner.id)
  const membership = await f.db.get<{ roleId: string }>('SELECT roleId FROM memberships WHERE userId=? AND workspaceId=?', owner.id, item.wid)
  const viewer = await f.db.get<{ id: string }>("SELECT id FROM roles WHERE workspaceId=? AND name='Viewer'", item.wid)
  assert.ok(membership)
  assert.ok(viewer)
  onPut = async () => { await f.db.run('UPDATE memberships SET roleId=? WHERE userId=? AND workspaceId=?', viewer.id, owner.id, item.wid) }
  assert.equal((await upload()).status, 403)
  assert.equal(objects.size, 1)
  onPut = async () => {}
  await f.db.run('UPDATE memberships SET roleId=? WHERE userId=? AND workspaceId=?', membership.roleId, owner.id, item.wid)
  onGet = async () => { await f.db.run('DELETE FROM memberships WHERE userId=? AND workspaceId=?', owner.id, item.wid) }
  assert.equal((await f.request(`${item.path}/${saved.id}`, { token: owner.token })).status, 403)
  onGet = async () => {}
  await f.db.run('INSERT INTO memberships (workspaceId,userId,roleId) VALUES (?,?,?)', item.wid, owner.id, membership.roleId)
  failPut = true
  assert.equal((await upload()).status, 503)
  assert.equal((await f.db.get<{ count: number }>('SELECT count(*) AS count FROM storage_objects'))?.count, 2)
  failDelete = true
  response = await upload()
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'Attachment storage unavailable' })
  assert.equal((await f.db.get<{ count: number }>('SELECT count(*) AS count FROM storage_objects'))?.count, 3)
  failPut = false
  response = await f.request(`${item.path}/${saved.id}`, { method: 'DELETE', token: owner.token })
  assert.deepEqual(await response.json(), { success: true, cleanupPending: true })
  assert.equal((await f.request(`${item.path}/${saved.id}`, { token: owner.token })).status, 404)
  failDelete = false
  await f.db.run('UPDATE storage_objects SET createdAt=?', '2000-01-01T00:00:00.000Z')
  assert.deepEqual(await f.collect(), { scanned: 3, deleted: 3, failed: 0 })
  assert.equal(objects.size, 0)
  const disappearing = await f.item(owner.token)
  onPut = async () => { await f.db.run('DELETE FROM items WHERE id=?', disappearing.id) }
  assert.equal((await f.request(disappearing.path, { method: 'POST', token: owner.token, body: payload })).status, 404)
  assert.equal(objects.size, 0)
  onPut = async () => {}
  response = await upload()
  const removed = await response.json() as { id: string }
  onDelete = async () => { await f.db.run('DELETE FROM tokens WHERE userId=?', owner.id) }
  assert.equal((await f.request(`${item.path}/${removed.id}`, { method: 'DELETE', token: owner.token })).status, 401)
  assert.equal(f.output().includes('mock-secret'), false)
})
