import { test } from './japa.js'
import assert from 'node:assert/strict'
import { integrationServer } from './storage-sso-fixture.js'

test('management-only members receive filtered metadata and can manage without reading tasks', async (t) => {
  const api = await integrationServer(t)
  const owner = await api.user(true)
  const task = await api.item(owner.token)
  const base = `/workspaces/${task.wid}`
  const field = await api.request(`${base}/fields`, { method: 'POST', token: owner.token, body: { name: 'Private field definition', type: 'text' } })
  assert.equal(field.status, 201)
  for (const permission of ['workspace:manage', 'structure:write', 'members:manage', 'roles:manage', 'items:write', 'none']) {
    const member = await api.user()
    const permissions = permission === 'none' ? [] : [permission]
    const roleResult = await api.request(`${base}/roles`, { method: 'POST', token: owner.token, body: { name: permission, permissions } })
    assert.equal(roleResult.status, 201)
    const role = await roleResult.json() as { id: string }
    assert.equal((await api.request(`${base}/members`, { method: 'POST', token: owner.token, body: { email: member.email, roleId: role.id } })).status, 201)
    const result = await api.request(base, { token: member.token })
    assert.equal(result.status, 200)
    const detail = await result.json() as { workspace: { id: string }; role: { id: string }; permissions: string[]; nodes: unknown[]; fields: unknown[]; members: unknown[]; roles: unknown[] }
    assert.equal(detail.workspace.id, task.wid)
    assert.equal(detail.role.id, role.id)
    assert.deepEqual(detail.permissions, permissions)
    assert.equal(detail.nodes.length > 0, permission === 'structure:write')
    assert.equal(detail.fields.length > 0, permission === 'structure:write')
    assert.equal(detail.members.length > 0, permission === 'members:manage')
    assert.equal(detail.roles.length > 1, permission === 'roles:manage' || permission === 'members:manage')
    for (const suffix of ['/items', `/items/${task.id}`, '/export']) assert.equal((await api.request(base + suffix, { token: member.token })).status, 403)
    assert.equal((await api.request(`${base}/items/${task.id}`, { method: 'PATCH', token: member.token, body: {} })).status, 403)
    for (const suffix of ['/nodes', '/fields']) assert.equal((await api.request(base + suffix, { token: member.token })).status, permission === 'structure:write' ? 200 : 403)
    if (permission === 'workspace:manage') assert.equal((await api.request(base, { method: 'PATCH', token: member.token, body: { name: 'Renamed without reading tasks' } })).status, 200)
    if (permission === 'structure:write') assert.equal((await api.request(`${base}/fields`, { method: 'POST', token: member.token, body: { name: 'Managed definition', type: 'number' } })).status, 201)
    if (permission === 'roles:manage') assert.equal((await api.request(`${base}/roles`, { method: 'POST', token: member.token, body: { name: 'No task access', permissions: [] } })).status, 201)
    if (permission === 'members:manage') {
      const added = await api.user()
      assert.equal((await api.request(`${base}/members`, { method: 'POST', token: member.token, body: { email: added.email, roleId: role.id } })).status, 201)
      const ownerRole = (await (await api.request(base, { token: owner.token })).json() as { role: { id: string } }).role.id
      assert.equal((await api.request(`${base}/members/${added.id}`, { method: 'PATCH', token: member.token, body: { roleId: ownerRole } })).status, 403)
    }
    await api.db.run('DELETE FROM memberships WHERE workspaceId=? AND userId=?', task.wid, member.id)
    assert.equal((await api.request(base, { token: member.token })).status, 403)
  }
})
