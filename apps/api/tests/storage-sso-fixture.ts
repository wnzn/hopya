import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { TestContext } from './japa.js'
import { openTestDatabase } from './helpers/database.js'
import { runMigrations } from './helpers/migrate.js'

export async function integrationServer(t: TestContext, env: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'hopya-storage-sso-'))
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = (socket.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()))
  const base = `http://127.0.0.1:${port}`
  const environment = { ...process.env, DATA_DIR: directory, API_PORT: String(port), HOST: '127.0.0.1', APP_URL: base,
    NODE_ENV: 'test', APP_KEY: 'storage-sso-test-key-not-for-deployment-123456789', REGISTRATION_ENABLED: 'false',
    AI_PROVIDER: '', OIDC_ISSUER: '', OIDC_AUTO_PROVISION: 'false', OIDC_ALLOW_INSECURE_HTTP: 'false', STORAGE_DRIVER: 'filesystem', LOG_LEVEL: 'fatal', ...env }
  runMigrations(environment)
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/storage-sso-server.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
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
  const db = database = openTestDatabase(join(directory, 'hopya.sqlite'))
  await db.run('PRAGMA foreign_keys = ON')
  await db.run('PRAGMA busy_timeout = 5000')
  const request = (path: string, options: { method?: string; body?: unknown; token?: string; cookie?: string; origin?: string; headers?: Record<string, string> } = {}) => fetch(`${base}/api/v1${path}`, {
    method: options.method || 'GET', redirect: 'manual',
    headers: { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}), ...options.headers },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  async function user(isAdmin = false, email = `${randomUUID()}@example.test`) {
    const id = randomUUID(); const token = randomBytes(32).toString('base64url')
    await db.transaction(async (transaction) => {
      await transaction.run('INSERT INTO users (id,name,email,isAdmin,createdAt) VALUES (?,?,?,?,?)', id, 'Integration User', email, Number(isAdmin), new Date().toISOString())
      await transaction.run('INSERT INTO tokens (id,userId,name,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?)', randomUUID(), id, 'Test token', createHash('sha256').update(token).digest('hex'), new Date(Date.now() + 3600000).toISOString(), new Date().toISOString())
    })
    return { id, token, email }
  }
  async function item(token: string) {
    async function post(path: string, body: unknown) {
      const response = await request(path, { method: 'POST', body, token })
      assert.equal(response.status, 201, await response.clone().text())
      return response.json() as Promise<{ id: string }>
    }
    const workspace = await post('/workspaces', { name: 'Attachments' })
    const project = await post(`/workspaces/${workspace.id}/nodes`, { name: 'Project', kind: 'project' })
    const list = await post(`/workspaces/${workspace.id}/nodes`, { name: 'List', kind: 'list', parentId: project.id })
    const item = await post(`/workspaces/${workspace.id}/items`, { title: 'Attachment target', nodeId: list.id })
    return { wid: workspace.id, id: item.id, path: `/workspaces/${workspace.id}/items/${item.id}/attachments` }
  }
  async function collect() {
    const compiled = process.env.HOPYA_TEST_BUILD === 'true'
    const collector = spawn(process.execPath, [...(compiled ? [] : ['--import', 'tsx']), '--input-type=module', '-e',
      `import 'reflect-metadata'; const {pathToFileURL}=await import('node:url'); const {Ignitor}=await import('@adonisjs/core'); const root=pathToFileURL(process.cwd()+'/${compiled ? 'build/' : ''}'); const app=new Ignitor(root,{importer:(path)=>import(path.startsWith('.')?new URL(path,root).href:path)}).createApp('test'); await app.init(); await app.boot(); try { const {collectStorageGarbage}=await import(new URL('app/integrations/storage.js',root).href); console.log(JSON.stringify(await collectStorageGarbage())) } finally { await app.terminate() }`], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let result = ''; let errors = ''
    collector.stdout.on('data', (chunk) => { result += String(chunk) })
    collector.stderr.on('data', (chunk) => { errors += String(chunk) })
    const [code] = await once(collector, 'exit')
    assert.equal(code, 0, errors)
    return JSON.parse(result) as { scanned: number; deleted: number; failed: number }
  }
  return { base, directory, db, request, user, item, collect, output: () => output }
}

export const responseCookie = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
