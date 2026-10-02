import { test } from './japa.js'
import assert from 'node:assert/strict'
import { readFileSync, statSync, existsSync, symlinkSync, readdirSync, writeFileSync } from 'node:fs'
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
  // HTML/script bytes cannot be promoted to an inline image by a URL suffix.
  assert.equal((await f.request(`${item.path}/${attachment.id}/inline`, { token: owner.token })).status, 415)
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
  await f.db.run("CREATE TRIGGER refuse_ledger_delete BEFORE DELETE ON storage_objects BEGIN SELECT RAISE(ABORT, 'test cleanup failure'); END")
  assert.deepEqual(await f.collect(), { scanned: 1, deleted: 0, failed: 1 })
  await f.db.run('DROP TRIGGER refuse_ledger_delete')
  assert.deepEqual(await f.collect(), { scanned: 1, deleted: 1, failed: 0 })
  assert.deepEqual(readdirSync(join(f.directory, 'objects')), [])
  const audit = JSON.stringify(await f.db.all("SELECT * FROM audit_logs WHERE action LIKE 'attachment.%'"))
  assert.ok(audit.includes('attachment.create'))
  assert.ok(audit.includes('attachment.delete'))
  assert.equal(audit.includes(payload.data), false)
  assert.deepEqual(await f.db.all('PRAGMA foreign_key_check'), [])
})

// Distinct failure protected: private image drafts cannot cross accounts/resources,
// body/comment commit is atomic, and tombstones/cascades revoke bytes without leaks.
test('private raster drafts commit with new tasks and comments, preserve safe export metadata, and expire through the ledger', { timeout: 60000 }, async (t) => {
  const f = await integrationServer(t)
  const owner = await f.user(); const reader = await f.user(); const outsider = await f.user()
  const item = await f.item(owner.token); const foreign = await f.item(outsider.token)
  const base = `/workspaces/${item.wid}`
  const role = await f.db.get<{ id: string }>("SELECT id FROM roles WHERE workspaceId=? AND name='Viewer'", item.wid)
  await f.db.run('INSERT INTO memberships(workspaceId,userId,roleId) VALUES (?,?,?)', item.wid, reader.id, role!.id)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1foAAAAASUVORK5CYII='
  const payload = { kind: 'task-body', name: 'private.png', contentType: 'image/png', data: png }
  const post = (path: string, body: unknown, token = owner.token) => f.request(path, { method: 'POST', body, token })
  const upload = (body: unknown = payload, token = owner.token) => post(`${base}/images`, body, token)
  const read = (url: string, token = owner.token) => f.request(url.replace(/^\/api\/v1/, ''), { token })
  assert.equal((await f.request(`${base}/images`, { method: 'POST', body: payload, origin: f.base })).status, 401)
  assert.equal((await upload(payload, reader.token)).status, 403)
  assert.equal((await upload(payload, outsider.token)).status, 403)
  assert.equal((await f.request(`${base}/images`, { method: 'POST', body: payload, token: owner.token, origin: 'https://evil.test' })).status, 403)
  for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from('<html>hi</html>'), Buffer.from(png, 'base64').subarray(0, 36), Buffer.from([0xff, 0xd8, ...Array<number>(20).fill(0xff), 0xd9])]) {
    assert.equal((await upload({ ...payload, data: bytes.toString('base64') })).status, 415)
  }
  const hugeDimensions = Buffer.from(png, 'base64'); hugeDimensions.writeUInt32BE(65535, 16)
  assert.equal((await upload({ ...payload, data: hugeDimensions.toString('base64') })).status, 415)
  assert.equal((await upload({ ...payload, objectKey: '../../secret' })).status, 400)
  const pendingResponse = await upload()
  assert.equal(pendingResponse.status, 201, await pendingResponse.clone().text())
  const pending = await pendingResponse.json() as { id: string; url: string; downloadUrl: string }
  assert.equal((await read(pending.url, reader.token)).status, 404)
  assert.equal((await read(pending.url, outsider.token)).status, 403)
  const preview = await read(pending.url)
  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get('content-type'), 'image/png')
  assert.equal(preview.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(preview.headers.get('cache-control'), 'private, no-store')
  assert.match(preview.headers.get('content-disposition')!, /^inline;/)
  assert.match(preview.headers.get('content-security-policy')!, /sandbox/)
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), Buffer.from(png, 'base64'))
  await f.db.run('UPDATE storage_objects SET createdAt=?', '2000-01-01T00:00:00.000Z')
  assert.deepEqual(await f.collect(), { scanned: 0, deleted: 0, failed: 0 }, 'Live drafts protect their ledger objects even when a sweep runs before commit')
  assert.equal((await read(pending.downloadUrl)).headers.get('content-type'), 'application/octet-stream')
  const target = await (await f.request(`${base}/items/${item.id}`, { token: owner.token })).json() as { nodeId: string }
  const markdown = `Context\n\n![Private image](${pending.url})`
  const invalid = await post(`${base}/items`, { title: 'Retain draft', nodeId: foreign.id, description: markdown })
  assert.equal(invalid.status, 404)
  assert.equal((await f.db.get<{ committedAt: string | null }>('SELECT committedAt FROM rich_text_images WHERE id=?', pending.id))!.committedAt, null)
  await f.db.run("CREATE TRIGGER refuse_image_audit BEFORE INSERT ON audit_logs WHEN NEW.action='image.commit' BEGIN SELECT RAISE(ABORT, 'test image audit failure'); END")
  const rollback = await post(`${base}/items`, { title: 'Rollback image claim', nodeId: target.nodeId, description: markdown })
  assert.equal(rollback.status, 409) // The HTTP boundary maps SQL constraint failures to conflict.
  assert.equal((await f.db.get<{ committedAt: string | null }>('SELECT committedAt FROM rich_text_images WHERE id=?', pending.id))!.committedAt, null)
  assert.equal(await f.db.get('SELECT id FROM attachments WHERE id=?', pending.id), undefined)
  assert.equal(await f.db.get("SELECT id FROM items WHERE title='Rollback image claim' AND workspaceId=?", item.wid), undefined)
  await f.db.run('DROP TRIGGER refuse_image_audit')
  const creation = await post(`${base}/items`, { title: 'With an image from its draft', nodeId: target.nodeId, description: markdown })
  assert.equal(creation.status, 201, await creation.clone().text())
  const created = await creation.json() as { id: string; description: string }
  assert.equal(created.description, markdown)
  assert.equal((await read(pending.url, reader.token)).status, 200)
  assert.ok(await f.db.get('SELECT id FROM attachments WHERE id=? AND itemId=?', pending.id, created.id))
  assert.equal((await f.request(`${base}/items/${created.id}/attachments/${pending.id}/inline`, { token: owner.token })).status, 200)
  const wrongResource = await f.request(`${base}/items/${item.id}`, { method: 'PATCH', token: owner.token, body: { description: markdown } })
  assert.equal(wrongResource.status, 400)
  const foreignUrl = pending.url.replace(item.wid, foreign.wid)
  assert.equal((await read(foreignUrl, outsider.token)).status, 404)

  // A role with comments:create but no task-write can upload and post a reply image.
  const commenterRole = await post(`${base}/roles`, { name: 'Image commenter', permissions: ['items:read', 'documents:read', 'comments:create'] })
  assert.equal(commenterRole.status, 201)
  const commenter = await commenterRole.json() as { id: string }
  await f.db.run('UPDATE memberships SET roleId=? WHERE workspaceId=? AND userId=?', commenter.id, item.wid, reader.id)
  const commentUpload = await upload({ ...payload, kind: 'task-comment', resourceId: created.id }, reader.token)
  assert.equal(commentUpload.status, 201)
  const commentImage = await commentUpload.json() as typeof pending
  const parentResponse = await post(`${base}/items/${created.id}/comments`, { body: 'Parent' })
  const parent = await parentResponse.json() as { id: string }
  assert.equal((await post(`${base}/items/${created.id}/comments`, { body: `![Someone else's draft](${commentImage.url})` })).status, 403)
  assert.equal((await post(`${base}/items/${item.id}/comments`, { body: `![Wrong task](${commentImage.url})` }, reader.token)).status, 400)
  const reply = await post(`${base}/items/${created.id}/comments`, { body: `![Reply](${commentImage.url})`, parentId: parent.id }, reader.token)
  assert.equal(reply.status, 201, await reply.clone().text())
  const replyData = await reply.json() as { id: string }
  assert.equal((await read(commentImage.url)).status, 200)
  const documentResponse = await post(`${base}/documents`, { title: 'Image discussion' })
  const document = await documentResponse.json() as { id: string }
  const docUpload = await upload({ ...payload, kind: 'document-comment', resourceId: document.id }, reader.token)
  assert.equal(docUpload.status, 201)
  const docImage = await docUpload.json() as typeof pending
  const docCommentResponse = await post(`${base}/documents/${document.id}/comments`, { body: `![Document](${docImage.url})` }, reader.token)
  assert.equal(docCommentResponse.status, 201)
  const docComment = await docCommentResponse.json() as { id: string }
  const exported = await (await f.request(`${base}/export`, { token: owner.token })).json() as { version: number; images: Array<Record<string, unknown>> }
  assert.equal(exported.version, 8)
  assert.equal(exported.images.length, 3)
  assert.deepEqual(Object.keys(exported.images[0]).sort(), ['attachmentId', 'commentId', 'committedAt', 'contentType', 'createdAt', 'documentCommentId', 'documentId', 'id', 'itemId', 'kind', 'name', 'size'])
  await f.db.run('UPDATE roles SET permissions=? WHERE id=?', JSON.stringify(['items:read', 'comments:create']), commenter.id)
  assert.equal((await read(docImage.url, reader.token)).status, 403)
  const limitedExport = await (await f.request(`${base}/export`, { token: reader.token })).json() as typeof exported
  assert.equal(limitedExport.images.length, 2)
  assert.equal((await f.request(`${base}/items/${created.id}/comments/${parent.id}`, { method: 'DELETE', token: owner.token })).status, 200)
  assert.equal((await read(commentImage.url)).status, 200) // Parent tombstone preserves reply bytes.
  assert.equal((await f.request(`${base}/items/${created.id}/comments/${replyData.id}`, { method: 'DELETE', token: reader.token })).status, 200)
  assert.equal((await read(commentImage.url)).status, 404)
  assert.equal((await f.request(`${base}/documents/${document.id}/comments/${docComment.id}`, { method: 'DELETE', token: owner.token })).status, 200)
  assert.equal((await read(docImage.url)).status, 404)
  assert.equal((await f.request(`${base}/documents/${document.id}/comments/${docComment.id}`, { method: 'DELETE', token: owner.token })).status, 200)
  const docDraft = await (await upload({ ...payload, kind: 'document-comment', resourceId: document.id })).json() as typeof pending
  assert.equal((await f.request(`${base}/documents/${document.id}`, { method: 'DELETE', token: owner.token })).status, 200)
  assert.equal((await read(docDraft.url)).status, 404)
  // Rechecking bytes prevents a corrupted object/MIME declaration bypass.
  const stored = await f.db.get<{ objectKey: string }>('SELECT objectKey FROM rich_text_images WHERE id=?', pending.id)
  writeFileSync(join(f.directory, 'objects', stored!.objectKey), Buffer.alloc(Buffer.from(png, 'base64').length, '<'))
  assert.equal((await read(pending.url)).status, 415)
  const unused = await (await upload()).json() as typeof pending
  await f.db.run('UPDATE rich_text_images SET expiresAt=? WHERE id=?', '2000-01-01T00:00:00.000Z', unused.id)
  assert.equal((await read(unused.url)).status, 404)
  const expiredClaim = await post(`${base}/items`, { title: 'Expired draft', nodeId: target.nodeId, description: `![Expired](${unused.url})` })
  assert.equal(expiredClaim.status, 409)
  await f.request(`${base}/items/${created.id}`, { method: 'DELETE', token: owner.token })
  assert.equal((await read(pending.url)).status, 404)
  await f.db.run('UPDATE storage_objects SET createdAt=?', '2000-01-01T00:00:00.000Z')
  assert.deepEqual(await f.collect(), { scanned: 5, deleted: 5, failed: 0 })
  assert.equal((await f.db.get<{ count: number }>('SELECT count(*) AS count FROM rich_text_images'))!.count, 0)
  assert.deepEqual(readdirSync(join(f.directory, 'objects')), [])
  const workspaceDraft = await (await upload()).json() as typeof pending
  assert.equal((await f.request(base, { method: 'DELETE', token: owner.token })).status, 200)
  assert.equal((await read(workspaceDraft.url)).status, 403)
  await f.db.run('UPDATE storage_objects SET createdAt=?', '2000-01-01T00:00:00.000Z')
  assert.deepEqual(await f.collect(), { scanned: 1, deleted: 1, failed: 0 })
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
  const imageResponse = await f.request(`/workspaces/${item.wid}/images`, { method: 'POST', token: owner.token, body: {
    kind: 'task-body', resourceId: item.id, name: 'pixel.gif', contentType: 'image/gif', data: 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  } })
  assert.equal(imageResponse.status, 201)
  const image = await imageResponse.json() as { id: string; url: string }
  onGet = async () => { await f.db.run('UPDATE users SET disabled=1 WHERE id=?', owner.id) }
  assert.equal((await f.request(image.url.replace(/^\/api\/v1/, ''), { token: owner.token })).status, 401)
  onGet = async () => {}; await f.db.run('UPDATE users SET disabled=0 WHERE id=?', owner.id)
  assert.equal((await f.request(`/workspaces/${item.wid}/items/${item.id}`, { method: 'PATCH', token: owner.token, body: { description: `![Private pixel](${image.url})` } })).status, 200)
  assert.equal((await f.request(`${item.path}/${image.id}`, { method: 'DELETE', token: owner.token })).status, 200)
  assert.equal(objects.size, 1)
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
