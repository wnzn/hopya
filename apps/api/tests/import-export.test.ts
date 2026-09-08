import { test } from 'node:test'
import assert from 'node:assert/strict'
import { integrationServer } from './storage-sso-fixture.js'

// Covers the distinct import/export failure modes: permission boundaries,
// row validation with row numbers, the 500-row cap, all-or-nothing inserts,
// export filters, CSV round-tripping and oversized payloads.
test('task import/export endpoints', async (t) => {
  const api = await integrationServer(t)
  const owner = api.user(true)
  const outsider = api.user(true)
  const post = async (path: string, body: unknown, token = owner.token) => {
    const response = await api.request(path, { method: 'POST', body, token })
    assert.ok(response.status === 200 || response.status === 201, `${path}: ${response.status} ${await response.clone().text()}`)
    return response.json() as Promise<Record<string, unknown> & { id: string }>
  }
  const workspace = await post('/workspaces', { name: 'ImportExport' })
  const wid = workspace.id
  const base = `/workspaces/${wid}`
  const project = await post(`${base}/nodes`, { name: 'Project', kind: 'project' })
  const list = await post(`${base}/nodes`, { name: 'Backlog', kind: 'list', parentId: project.id })
  const other = await post(`${base}/nodes`, { name: 'Other', kind: 'list', parentId: project.id })
  const folder = await post(`${base}/nodes`, { name: 'Folder', kind: 'folder', parentId: project.id })
  const sublist = await post(`${base}/nodes`, { name: 'Sub', kind: 'list', parentId: folder.id })

  const channel = await post(`${base}/fields`, { name: 'Channel', type: 'text' })
  const effort = await post(`${base}/fields`, { name: 'Effort', type: 'number' })
  const flag = await post(`${base}/fields`, { name: 'Flag', type: 'checkbox' })
  const severity = await post(`${base}/fields`, { name: 'Severity', type: 'select', options: ['low', 'high'] })
  const stars = await post(`${base}/fields`, { name: 'Stars', type: 'rating', settings: { maxRating: 3 } })

  const viewer = api.user()
  const memberUser = api.user()
  await post(`${base}/roles`, { name: 'Reader', permissions: ['items:read'] })
  const roles = await (await api.request(`${base}/roles`, { token: owner.token })).json() as { id: string; name: string }[]
  await post(`${base}/members`, { email: viewer.email, roleId: roles.find((role) => role.name === 'Reader')!.id })
  await post(`${base}/members`, { email: memberUser.email, roleId: roles.find((role) => role.name === 'Member')!.id })

  const importPath = `${base}/items/import`
  const exportPath = `${base}/items/export`
  const importAs = (body: unknown, token = owner.token) => api.request(importPath, { method: 'POST', body, token })
  const exportJson = async (query: string, token = owner.token) => {
    const response = await api.request(`${exportPath}${query}`, { token })
    assert.equal(response.status, 200, `${query}: ${response.status}`)
    return response.json() as Promise<Record<string, unknown>[]>
  }

  await t.test('permission boundaries: outsider denied both, viewer denied import but allowed export', async () => {
    const payload = { nodeId: list.id, format: 'json', data: JSON.stringify([{ title: 'Nope' }]) }
    assert.equal((await importAs(payload, outsider.token)).status, 403)
    assert.equal((await api.request(`${exportPath}?format=json`, { token: outsider.token })).status, 403)
    assert.equal((await importAs(payload, viewer.token)).status, 403)
    const readerExport = await api.request(`${exportPath}?format=json`, { token: viewer.token })
    assert.equal(readerExport.status, 200)
    assert.ok(Array.isArray(await readerExport.json()))
  })

  await t.test('JSON import happy path with assignee, tags and custom fields', async () => {
    const data = JSON.stringify([
      { title: 'JSON one', description: 'First', status: 'todo', priority: 'medium', tags: ['x', 'y', 'x'], assignee: memberUser.email, customFields: { [channel.id]: 'email', Effort: 5 } },
      { title: 'JSON two', status: 'Done', 'custom:Stars': 3, 'custom:Flag': true, 'custom:Severity': 'high' },
    ])
    const response = await importAs({ nodeId: list.id, format: 'json', data })
    assert.equal(response.status, 201)
    const result = await response.json() as { imported: number; ids: string[] }
    assert.equal(result.imported, 2)
    assert.equal(result.ids.length, 2)
    const first = await (await api.request(`${base}/items/${result.ids[0]}`, { token: owner.token })).json() as Record<string, unknown>
    assert.equal(first.title, 'JSON one')
    assert.deepEqual(first.tags, ['x', 'y'])
    assert.equal(first.assigneeId, memberUser.id)
    assert.deepEqual(first.customFields, { [channel.id]: 'email', [effort.id]: 5 })
    const second = await (await api.request(`${base}/items/${result.ids[1]}`, { token: owner.token })).json() as Record<string, unknown>
    assert.equal(second.status, 'done')
    assert.deepEqual(second.customFields, { [stars.id]: 3, [flag.id]: true, [severity.id]: 'high' })
  })

  await t.test('CSV import handles quoted commas, newlines and semicolon tags', async () => {
    const data = [
      'title,description,status,priority,startDate,dueDate,tags,assignee,custom:Channel,custom:Effort,custom:Flag,custom:Severity,custom:Stars',
      `"Report, Q3","line1\nline2",Done,high,2026-01-05,2026-01-10,"alpha; beta;alpha",${memberUser.email},web,3,yes,high,2`,
      'Plain,,todo,none,,,,,,,no,,',
    ].join('\r\n')
    const response = await importAs({ nodeId: list.id, format: 'csv', data })
    assert.equal(response.status, 201, await response.clone().text())
    const result = await response.json() as { imported: number; ids: string[] }
    assert.equal(result.imported, 2)
    const item = await (await api.request(`${base}/items/${result.ids[0]}`, { token: owner.token })).json() as Record<string, unknown>
    assert.equal(item.title, 'Report, Q3')
    assert.equal(item.description, 'line1\nline2')
    assert.equal(item.status, 'done')
    assert.deepEqual(item.tags, ['alpha', 'beta'])
    assert.equal(item.assigneeId, memberUser.id)
    assert.deepEqual(item.customFields, { [channel.id]: 'web', [effort.id]: 3, [flag.id]: true, [severity.id]: 'high', [stars.id]: 2 })
  })

  await t.test('row errors name the 1-based row number and reason', async () => {
    const cases: [string, RegExp][] = [
      [JSON.stringify([{ title: 'Bad status', status: 'nope' }]), /Row 1:.*status/i],
      [JSON.stringify([{ title: 'Bad field', 'custom:Nope': 1 }]), /Row 1:.*custom field 'Nope'/],
      [JSON.stringify([{ title: '   ' }]), /Row 1:.*title/],
      [JSON.stringify([{ title: 'Bad dates', startDate: '2026-02-01', dueDate: '2026-01-01' }]), /Row 1:.*startDate/],
      [JSON.stringify([{ title: 'Ok' }, { title: 'Bad date', startDate: '2026-13-99' }]), /Row 2:.*startDate/],
      [JSON.stringify([{ title: 'Bad member', assignee: 'ghost@example.test' }]), /Row 1:.*assignee/],
    ]
    for (const [data, pattern] of cases) {
      const response = await importAs({ nodeId: list.id, format: 'json', data })
      assert.equal(response.status, 400, data)
      const body = await response.json() as { error: string }
      assert.match(body.error, pattern, data)
    }
    const csvResponse = await importAs({ nodeId: list.id, format: 'csv', data: 'name,other\nx,y' })
    assert.equal(csvResponse.status, 400)
    assert.match(((await csvResponse.json()) as { error: string }).error, /title/)
  })

  await t.test('row cap of 500 is enforced', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ title: `Bulk ${index}` }))
    const response = await importAs({ nodeId: list.id, format: 'json', data: JSON.stringify(rows) })
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /500/)
  })

  await t.test('failed imports insert nothing', async () => {
    const before = (await exportJson(`?format=json&nodeId=${list.id}&limit=5000`)).length
    const data = JSON.stringify([{ title: 'Good one' }, { title: 'Bad one', status: 'nope' }, { title: 'Good two' }])
    assert.equal((await importAs({ nodeId: list.id, format: 'json', data })).status, 400)
    const after = (await exportJson(`?format=json&nodeId=${list.id}&limit=5000`)).length
    assert.equal(after, before)
  })

  await t.test('export filters by subtree, status and literal search', async () => {
    await post(`${base}/items`, { title: 'Alpha release marker', status: 'done', nodeId: list.id })
    await post(`${base}/items`, { title: 'Beta 100% draft marker', status: 'todo', nodeId: other.id })
    await post(`${base}/items`, { title: '100X decoy marker', status: 'todo', nodeId: other.id })
    await post(`${base}/items`, { title: 'Gamma nested marker', status: 'done', nodeId: sublist.id })
    const scoped = await exportJson(`?format=json&nodeId=${folder.id}&search=marker&limit=5000`)
    assert.deepEqual(scoped.map((item) => item.title), ['Gamma nested marker'])
    const listed = await exportJson(`?format=json&nodeId=${list.id}&search=Alpha release marker&limit=5000`)
    assert.equal(listed.length, 1)
    const done = await exportJson(`?format=json&status=done&search=marker&limit=5000`)
    assert.deepEqual(done.map((item) => item.title).sort(), ['Alpha release marker', 'Gamma nested marker'])
    const literal = await exportJson(`?format=json&search=100%25 draft marker&limit=5000`)
    assert.deepEqual(literal.map((item) => item.title), ['Beta 100% draft marker'])
    const limited = await exportJson(`?format=json&search=marker&limit=1`)
    assert.equal(limited.length, 1)
    assert.equal((await api.request(`${exportPath}?format=json&limit=5001`, { token: owner.token })).status, 400)
    assert.equal((await api.request(`${exportPath}?format=json&nodeId=${list.id}&status=bogus`, { token: owner.token })).status, 200)
    assert.equal((await api.request(`${exportPath}?format=json&nodeId=00000000-0000-4000-8000-000000000000`, { token: owner.token })).status, 404)
  })

  await t.test('exported CSV round-trips through the importer', async () => {
    const expected = await exportJson(`?format=json&nodeId=${list.id}&limit=5000`)
    assert.ok(expected.length > 0)
    const response = await api.request(`${exportPath}?format=csv&nodeId=${list.id}&limit=5000`, { token: owner.token })
    assert.equal(response.status, 200)
    const csv = await response.text()
    const header = csv.split(/\r?\n/)[0]!
    for (const column of ['id', 'title', 'description', 'status', 'tags', 'assigneeEmail', 'nodePath', 'custom:Channel']) {
      assert.ok(header.split(',').some((cell) => cell.replaceAll('"', '') === column || cell.replaceAll('"', '').startsWith(`${column}`)), `header has ${column}: ${header}`)
    }
    const dataRows = csv.trim().split(/\r?\n/).length - 1
    assert.ok(dataRows >= expected.length, 'embedded newlines stay inside quoted cells')
    const target = await post(`${base}/nodes`, { name: 'Roundtrip', kind: 'list', parentId: project.id })
    const importResponse = await importAs({ nodeId: target.id, format: 'csv', data: csv })
    assert.equal(importResponse.status, 201, await importResponse.clone().text())
    const imported = await (await api.request(`${exportPath}?format=json&nodeId=${target.id}&limit=5000`, { token: owner.token })).json() as Record<string, unknown>[]
    assert.equal(imported.length, expected.length)
    const byTitle = new Map(imported.map((item) => [item.title, item]))
    assert.deepEqual(byTitle.get('Report, Q3')!.tags, ['alpha', 'beta'])
    assert.equal(byTitle.get('Report, Q3')!.status, 'done')
    assert.equal(byTitle.get('Report, Q3')!.assigneeId, memberUser.id)
    assert.deepEqual(byTitle.get('JSON one')!.customFields, { [channel.id]: 'email', [effort.id]: 5, [flag.id]: null, [severity.id]: null, [stars.id]: null })
  })

  await t.test('oversized payloads are rejected', async () => {
    const response = await importAs({ nodeId: list.id, format: 'json', data: `{"x":"${'y'.repeat(1_000_001)}"}` })
    assert.ok(response.status === 400 || response.status === 413, `status ${response.status}`)
  })

  await t.test('export sets attachment headers and content types', async () => {
    const csvResponse = await api.request(`${exportPath}?format=csv&limit=5`, { token: owner.token })
    assert.equal(csvResponse.status, 200)
    assert.match(csvResponse.headers.get('content-type') ?? '', /text\/csv/)
    assert.equal(csvResponse.headers.get('content-disposition'), `attachment; filename="hopya-export-${wid.slice(0, 8)}.csv"`)
    const jsonResponse = await api.request(`${exportPath}?format=json&limit=5`, { token: owner.token })
    assert.equal(jsonResponse.status, 200)
    assert.match(jsonResponse.headers.get('content-type') ?? '', /application\/json/)
    assert.equal(jsonResponse.headers.get('content-disposition'), `attachment; filename="hopya-export-${wid.slice(0, 8)}.json"`)
  })
})
