import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseEnv } from 'node:util'
import { initializeEnvironment } from './init-env.js'

const execute = promisify(execFile)
async function directory(t: { after: (callback: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'hopya-init-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test('Docker initialization generates independent private secrets and keeps integrations/registration off', async (t) => {
  const root = await directory(t)
  const result = await initializeEnvironment({ directory: root, port: 8088 })
  const data = parseEnv(await readFile(result.path, 'utf8'))
  assert.ok(data.APP_KEY && data.SETUP_TOKEN)
  assert.match(data.APP_KEY, /^[a-f0-9]{64}$/)
  assert.match(data.SETUP_TOKEN, /^[a-f0-9]{64}$/)
  assert.notEqual(data.APP_KEY, data.SETUP_TOKEN)
  assert.equal((await lstat(result.path)).mode & 0o777, 0o600)
  assert.equal(data.APP_URL, 'http://localhost:8088')
  assert.equal(data.HTTP_PORT, '8088')
  assert.equal(data.BIND_ADDRESS, '127.0.0.1')
  assert.equal(data.DATA_DIR, '/data')
  assert.equal(data.REGISTRATION_ENABLED, 'false')
  assert.equal(data.OIDC_AUTO_PROVISION, 'false')
  assert.equal(data.OIDC_ALLOW_INSECURE_HTTP, 'false')
  assert.equal(data.STORAGE_DRIVER, 'filesystem')
  for (const key of ['AI_PROVIDER', 'AI_API_KEY', 'OIDC_ISSUER', 'OIDC_CLIENT_SECRET', 'AWS_SECRET_ACCESS_KEY']) assert.equal(data[key], '')
  assert.deepEqual(await readdir(root), ['.env'])
  assert.equal(JSON.stringify(result).includes(data.APP_KEY), false)
})

test('development initialization uses a private host, matching web origin/port and project-relative data', async (t) => {
  const root = await directory(t)
  const result = await initializeEnvironment({ directory: root, mode: 'development', port: 4329 })
  const data = parseEnv(await readFile(result.path, 'utf8'))
  assert.equal(data.APP_URL, 'http://localhost:4329')
  assert.equal(data.PORT, '4329')
  assert.equal(data.API_PORT, '3333')
  assert.equal(data.HOST, '127.0.0.1')
  assert.equal(data.TRUST_PROXY_HOPS, '0')
  assert.equal(data.DATA_DIR, '../../data')
  const config = new URL('../apps/web/astro.config.mjs', import.meta.url).href
  const output = await execute(process.execPath, ['--input-type=module', '-e',
    `const {default:config}=await import(${JSON.stringify(config)}); console.log(JSON.stringify({host:config.server.host,port:config.server.port,api:config.vite.server.proxy['/api'].target}))`],
  { cwd: root, env: { PATH: process.env.PATH, ...data } })
  assert.deepEqual(JSON.parse(output.stdout), { host: '127.0.0.1', port: 4329, api: 'http://127.0.0.1:3333' })
})

test('existing files and symlinks are never overwritten or read as configuration', async (t) => {
  const root = await directory(t)
  const path = join(root, '.env')
  await writeFile(path, 'existing-private-configuration', { mode: 0o600 })
  await assert.rejects(initializeEnvironment({ directory: root }), { code: 'EEXIST' })
  assert.equal(await readFile(path, 'utf8'), 'existing-private-configuration')
  await rm(path)
  const target = join(root, 'target')
  await writeFile(target, 'untouched')
  await symlink(target, path)
  await assert.rejects(initializeEnvironment({ directory: root }), { code: 'EEXIST' })
  assert.equal((await lstat(path)).isSymbolicLink(), true)
  assert.equal(await readFile(target, 'utf8'), 'untouched')
  assert.deepEqual((await readdir(root)).sort(), ['.env', 'target'])
})

test('racing initializers publish exactly one complete configuration and leave no temporary secrets', async (t) => {
  const root = await directory(t)
  const results = await Promise.allSettled([initializeEnvironment({ directory: root }), initializeEnvironment({ directory: root })])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const data = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  assert.ok(data.APP_KEY && data.SETUP_TOKEN)
  assert.match(data.APP_KEY, /^[a-f0-9]{64}$/)
  assert.match(data.SETUP_TOKEN, /^[a-f0-9]{64}$/)
  assert.deepEqual(await readdir(root), ['.env'])
})

test('invalid modes, ports and development port collisions create no files', async (t) => {
  const root = await directory(t)
  for (const port of [0, -1, 65536, 1.5, NaN]) await assert.rejects(initializeEnvironment({ directory: root, port }))
  await assert.rejects(initializeEnvironment({ directory: root, mode: 'invalid' as 'docker' }))
  await assert.rejects(initializeEnvironment({ directory: root, mode: 'development', port: 3333 }))
  assert.deepEqual(await readdir(root), [])
})

test('the dependency-free CLI supports help, private initialization and safe duplicate/argument errors', async (t) => {
  const root = await directory(t)
  await mkdir(join(root, 'ops'))
  const script = join(root, 'ops/init-env.ts')
  await copyFile(fileURLToPath(new URL('./init-env.ts', import.meta.url)), script)
  await copyFile(fileURLToPath(new URL('../.env.example', import.meta.url)), join(root, '.env.example'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  const env = { PATH: process.env.PATH, HOME: root }
  const help = await execute(process.execPath, ['--experimental-strip-types', script, '--help'], { cwd: root, env })
  assert.match(help.stdout, /Usage:/)
  await assert.rejects(lstat(join(root, '.env')), { code: 'ENOENT' })
  await assert.rejects(execute(process.execPath, ['--experimental-strip-types', script, '--port', 'not-a-number'], { cwd: root, env }))
  await assert.rejects(lstat(join(root, '.env')), { code: 'ENOENT' })
  const output = await execute(process.execPath, ['--experimental-strip-types', script, '--development', '--port', '4329'], { cwd: root, env })
  const data = parseEnv(await readFile(join(root, '.env'), 'utf8'))
  assert.ok(data.APP_KEY && data.SETUP_TOKEN)
  assert.match(output.stdout, /no accounts were created/)
  for (const secret of [data.APP_KEY, data.SETUP_TOKEN]) assert.equal((output.stdout + output.stderr).includes(secret), false)
  const before = await readFile(join(root, '.env'), 'utf8')
  await assert.rejects(execute(process.execPath, ['--experimental-strip-types', script], { cwd: root, env }), (error: unknown) => {
    assert.match((error as { stderr: string }).stderr, /already exists and was left unchanged/)
    return true
  })
  assert.equal(await readFile(join(root, '.env'), 'utf8'), before)
})

test('private owner-readable permissions do not depend on the caller umask', async (t) => {
  const root = await directory(t)
  const previous = process.umask(0o777)
  try {
    const result = await initializeEnvironment({ directory: root })
    assert.equal((await lstat(result.path)).mode & 0o777, 0o600)
    assert.ok(parseEnv(await readFile(result.path, 'utf8')).APP_KEY)
  } finally { process.umask(previous) }
})

test('a credential-bearing example is rejected without disclosing or publishing the credential', async (t) => {
  const root = await directory(t)
  await mkdir(join(root, 'ops'))
  const script = join(root, 'ops/init-env.ts')
  await copyFile(fileURLToPath(new URL('./init-env.ts', import.meta.url)), script)
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const marker = 'private-provider-key-fixture'
  await writeFile(join(root, '.env.example'), template.replace(/^AI_API_KEY=.*$/m, `AI_API_KEY=${marker}`))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await assert.rejects(execute(process.execPath, ['--experimental-strip-types', script], { cwd: root, env: { PATH: process.env.PATH, HOME: root } }), (error: unknown) => {
    const output = error as { stdout: string; stderr: string }
    assert.equal((output.stdout + output.stderr).includes(marker), false)
    return true
  })
  await assert.rejects(lstat(join(root, '.env')), { code: 'ENOENT' })
  assert.equal((await readdir(root)).some((name) => name.startsWith('.env.init-')), false)
})
