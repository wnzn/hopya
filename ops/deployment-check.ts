import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'

// Every Docker resource has a random name and an ownership label. Never load the
// operator's .env/Compose overrides, print credentials, or clean up by name alone.
const root = fileURLToPath(new URL('../', import.meta.url))
const owner = randomUUID()
const project = `hopya-deploy-check-${owner}`
const label = 'io.hopya.deployment-check'
const sourceVolume = `${project}_data`
const restoreVolume = `${project}_restore`
const images = { api: `${project}-api:check`, web: `${project}-web:check` }
const controller = new AbortController()
const interrupt = () => controller.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
const env: NodeJS.ProcessEnv = {}
for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR']) {
  if (process.env[key] !== undefined) env[key] = process.env[key]
}
let environmentDirectory: string | undefined
let origin = ''
let activeVolume = sourceVolume
let cookie = ''
let browser: { close(): Promise<void> } | undefined
let phase = 'preflight'
let failed = false
const ownedVolumes = new Set<string>()

async function docker(args: string[], input?: string | Buffer, cleanup = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, {
      cwd: root, env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
      timeout: 300000, signal: cleanup ? undefined : controller.signal,
    }, (error, stdout, stderr) => {
      // Child errors can embed output/environment. Do not expose them in a test log.
      if (error) {
        let detail = ''
        if (phase === 'Compose startup') {
          const secrets = ['APP_KEY', 'SETUP_TOKEN', 'SMTP_URL', 'AI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'OIDC_CLIENT_SECRET']
            .map(key => env[key]).filter((value): value is string => Boolean(value))
          detail = stderr.toString().trim().slice(0, 2000)
          for (const secret of secrets) detail = detail.replaceAll(secret, '[REDACTED]')
        }
        reject(new Error(`Docker ${args[0]} failed during ${phase}; raw output withheld to protect secrets${detail ? `; sanitized diagnostic: ${detail}` : ''}`))
      }
      else resolve(stdout)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

function compose(...args: string[]): Promise<Buffer> {
  const override = JSON.stringify({
    services: Object.fromEntries(['api', 'web', 'proxy'].map(service => [service, {
      labels: { [label]: owner },
      ...(service === 'api' ? { volumes: ['data:/data'] } : {}),
      ...(service === 'proxy' ? {} : {
        image: images[service as keyof typeof images],
        build: { labels: { [label]: owner } },
      }),
    }])),
    volumes: { data: { external: true, name: activeVolume } },
    networks: { default: { labels: { [label]: owner } } },
  })
  return docker(['compose', '--env-file', '/dev/null', '-p', project, '-f', 'docker-compose.yml', '-f', '-', ...args], override)
}

async function request(path: string, method = 'GET', body?: unknown, expected = 200, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]), redirect: 'error',
  })
  assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status`)
  return response
}

function session(response: Response): string {
  const value = response.headers.getSetCookie().find(value => value.startsWith('hopya_session='))
  assert.ok(value, 'Session cookie missing')
  assert.ok(/HttpOnly/i.test(value), 'Session cookie must be HttpOnly')
  assert.ok(/SameSite=Lax/i.test(value), 'Session cookie must be SameSite=Lax')
  return value.split(';')[0]!
}

try {
  await docker(['version'])
  const listener = createServer()
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  environmentDirectory = await mkdtemp(join(tmpdir(), 'hopya-deployment-env-'))
  await mkdir(join(environmentDirectory, 'ops'))
  await copyFile(join(root, 'ops/init-env.ts'), join(environmentDirectory, 'ops/init-env.ts'))
  await copyFile(join(root, '.env.example'), join(environmentDirectory, '.env.example'))
  await writeFile(join(environmentDirectory, 'package.json'), '{"type":"module"}')
  phase = 'private configuration initializer'
  const initialize = ['run', '--rm', '--name', `${project}-init`, '--label', `${label}=${owner}`, '--network', 'none',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--mount', `type=bind,src=${environmentDirectory},dst=/work`, '--workdir', '/work',
      'node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e',
    'node', '--experimental-strip-types', 'ops/init-env.ts', '--port', String(address.port)]
  const initializationOutput = (await docker(initialize)).toString()
  const environmentPath = join(environmentDirectory, '.env')
  assert.equal((await stat(environmentPath)).mode & 0o777, 0o600)
  const generated = await readFile(environmentPath, 'utf8')
  Object.assign(env, parseEnv(generated))
  origin = env.APP_URL!
  for (const value of [env.APP_KEY!, env.SETUP_TOKEN!]) assert.equal(initializationOutput.includes(value), false)
  await assert.rejects(() => docker(initialize))
  assert.equal(await readFile(environmentPath, 'utf8'), generated)
  console.log('Verified dependency-free Docker initializer, private secrets and no-overwrite behavior; no operator .env was read or changed')
  // A port race makes Docker fail safely; it must never reuse another service.
  for (const volume of [sourceVolume, restoreVolume]) {
    assert.equal((await docker(['volume', 'ls', '-q', '--filter', `name=^${volume}$`])).toString().trim(), '', 'Refusing existing test volume')
    await docker(['volume', 'create', '--label', `${label}=${owner}`, volume])
    ownedVolumes.add(volume)
  }
  phase = 'lockfile image builds'
  console.log('Building isolated API/web images with npm ci and TypeScript compilation')
  await compose('config', '--quiet')
  await compose('build', '--pull', 'api', 'web')
  phase = 'Compose startup'
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
  console.log(`Healthy isolated stack: ${origin}`)
  for (const service of ['api', 'web', 'proxy']) {
    const id = (await compose('ps', '-q', service)).toString().trim()
    const info = JSON.parse((await docker(['inspect', id])).toString())[0]
    assert.equal(info.Config.Labels[label], owner)
    assert.equal(info.HostConfig.ReadonlyRootfs, true)
    assert.deepEqual(info.HostConfig.CapDrop, ['ALL'])
    assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'))
    assert.ok(!['', 'root', '0', '0:0'].includes(info.Config.User), `${service} must be non-root`)
    if (service !== 'proxy') assert.equal(Object.keys(info.HostConfig.PortBindings || {}).length, 0)
    if (service === 'proxy') assert.equal(info.HostConfig.PortBindings['8080/tcp'][0].HostIp, '127.0.0.1')
    if (service === 'api') assert.ok(info.Config.Env.includes('TRUST_PROXY_HOPS=1'))
    if (service === 'web') assert.ok(!info.Config.Env.some((value: string) => /^(APP_KEY|SETUP_TOKEN|AI_API_KEY|OIDC_CLIENT_SECRET|AWS_SECRET_ACCESS_KEY)=/.test(value)), 'Web received a private secret variable')
  }
  assert.equal((await compose('exec', '-T', 'api', 'id', '-u')).toString().trim(), '1000')
  assert.equal((await compose('exec', '-T', 'api', 'stat', '-c', '%u:%g:%a', '/data')).toString().trim(), '1000:1000:700')
  await compose('exec', '-T', 'proxy', 'nginx', '-t')
  await compose('exec', '-T', 'api', 'node', '-e', "const fs=require('node:fs');fs.writeFileSync('/tmp/hopya-check','temporary');try{fs.writeFileSync('/app/hopya-check','must fail');process.exit(1)}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}")
  console.log('Verified non-root/read-only controls, private ports, data ownership and Nginx config')

  phase = 'setup and authorization'
  const password = randomBytes(24).toString('base64url')
  const email = `deployment-${owner}@example.test`
  cookie = session(await request('/auth/setup', 'POST', { name: 'Deployment check', email, password, setupToken: env.SETUP_TOKEN }, 201))
  await request('/workspaces', 'POST', { name: 'Must reject' }, 403, { Origin: 'https://not-hopya.example' })
  const workspace = await (await request('/workspaces', 'POST', { name: 'Deployment verification' }, 201)).json() as { id: string }
  const path = `/workspaces/${workspace.id}`
  const projectNode = await (await request(`${path}/nodes`, 'POST', { name: 'Restore project', kind: 'project', parentId: null }, 201)).json() as { id: string }
  const list = await (await request(`${path}/nodes`, 'POST', { name: 'Restore list', kind: 'list', parentId: projectNode.id }, 201)).json() as { id: string }
  const item = await (await request(`${path}/items`, 'POST', { title: 'Survives cold restore', nodeId: list.id, dueDate: '2026-09-10' }, 201)).json() as { id: string; title: string }
  const itemPath = `${path}/items/${item.id}`
  const bytes = randomBytes(10 * 1024 * 1024)
  const checksum = createHash('sha256').update(bytes).digest('hex')
  const attachment = await (await request(`${itemPath}/attachments`, 'POST', { name: 'restore.bin', contentType: 'application/octet-stream', data: bytes.toString('base64') }, 201)).json() as { id: string }
  const attachmentPath = `${itemPath}/attachments/${attachment.id}`
  const download = await request(attachmentPath)
  assert.ok(download.headers.get('content-disposition')?.startsWith('attachment;'))
  assert.equal(download.headers.get('cache-control'), 'private, no-store')
  assert.equal(createHash('sha256').update(Buffer.from(await download.arrayBuffer())).digest('hex'), checksum)
  await request(attachmentPath, 'GET', undefined, 401, { Cookie: '' })
  const otherEmail = `other-${owner}@example.test`
  await request('/admin/users', 'POST', { name: 'Nonmember', email: otherEmail, password }, 201)
  const otherCookie = session(await request('/auth/login', 'POST', { email: otherEmail, password }, 200, { Cookie: '' }))
  await request(attachmentPath, 'GET', undefined, 403, { Cookie: otherCookie })
  console.log('Verified same-origin checks and private 10 MiB binary attachment through the proxy')

  phase = 'forwarded IP spoofing'
  for (let attempt = 0; attempt < 12; attempt++) {
    const spoofed = { Cookie: '', 'X-Forwarded-For': `198.51.100.${attempt + 1}, 203.0.113.${attempt + 1}`, 'X-Real-IP': `192.0.2.${attempt + 1}`, Forwarded: `for=192.0.2.${attempt + 1}` }
    const login = await request('/auth/login', 'POST', { email: `throttle-${owner}@example.test`, password }, attempt < 10 ? 401 : 429, spoofed)
    if (attempt >= 10) assert.ok(Number(login.headers.get('retry-after')) > 0)
    await request('/auth/sso', 'GET', undefined, attempt < 10 ? 503 : 429, spoofed)
  }
  await request('/auth/login', 'POST', { email: `unrelated-${owner}@example.test`, password }, 401, { Cookie: '' })
  console.log('Verified rotating forged XFF/Real-IP/Forwarded cannot bypass login or SSO throttles; unrelated login account is not blocked')

  if (process.env.HOPYA_DEPLOYMENT_BROWSER === 'true') {
    phase = 'desktop/mobile browser'
    const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url))
    const { chromium } = webRequire('playwright')
    const { expect } = webRequire('@playwright/test')
    const launched = await chromium.launch()
    browser = launched
    const context = await launched.newContext({ viewport: { width: 1440, height: 950 } })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error: Error) => errors.push(error.name))
    await page.goto(`${origin}/login`)
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForURL(`${origin}/app`)
    await page.getByText(item.title, { exact: true }).waitFor()
    phase = 'desktop keyboard status change'
    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    const updated = page.waitForResponse((response: { url(): string; request(): { method(): string }; status(): number }) => response.url().endsWith(itemPath) && response.request().method() === 'PATCH' && response.status() === 200)
    const statusControl = page.getByLabel(`Move ${item.title} to status`)
    assert.equal(await statusControl.inputValue(), 'todo')
    await statusControl.press('ArrowDown')
    await page.keyboard.press('Enter')
    await updated
    assert.equal((await (await request(itemPath)).json()).status, 'backlog')
    phase = 'mobile task editor save'
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('tab', { name: 'List', exact: true }).click()
    await page.getByText(item.title, { exact: true }).waitFor()
    const beforeMobile = await (await request(itemPath)).json()
    await page.getByRole('button', { name: item.title, exact: true }).click()
    const mobileDescription = 'Persisted from the 390px mobile task editor'
    const bodyEditor = page.getByRole('textbox', { name: 'Body', exact: true })
    await bodyEditor.click()
    await bodyEditor.fill(mobileDescription)
    const mobileSave = page.waitForResponse((response: { url(): string; request(): { method(): string }; status(): number }) => response.url().endsWith(itemPath) && response.request().method() === 'PATCH' && response.status() === 200)
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await mobileSave
    const afterMobile = await (await request(itemPath)).json()
    assert.equal(afterMobile.description, mobileDescription)
    assert.notEqual(afterMobile.updatedAt, beforeMobile.updatedAt)
    phase = 'mobile task reload persistence'
    await page.reload()
    await page.getByRole('dialog', { name: 'Task details' }).waitFor()
    phase = 'mobile persisted description'
    await expect(page.getByRole('dialog', { name: 'Task details' }).getByRole('textbox', { name: 'Body', exact: true })).toHaveText(mobileDescription, { useInnerText: true })
    await page.keyboard.press('Escape')
    phase = 'mobile document bounds'
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile document overflow')
    phase = 'mobile browser errors'
    assert.equal(errors.length, 0, 'Browser JavaScript errors occurred')
    await browser!.close()
    browser = undefined
    console.log('Verified desktop login, real keyboard status change, mobile task edit/reload persistence and no document overflow')
  } else console.log('SKIPPED browser checks: set HOPYA_DEPLOYMENT_BROWSER=true to require Chromium')

  phase = 'log secret redaction'
  const querySecret = randomBytes(24).toString('hex')
  const health = await fetch(`${origin}/health?code=${querySecret}`, { signal: AbortSignal.timeout(5000) })
  assert.equal(health.status, 200)
  const logs = (await compose('logs', '--no-color')).toString()
  for (const secret of [env.APP_KEY!, env.SETUP_TOKEN!, password, cookie.slice(cookie.indexOf('=') + 1), querySecret]) {
    assert.ok(!logs.includes(secret), 'Raw secret found in container logs')
  }
  console.log('Verified generated credentials, session value and query secret are absent from container logs')

  phase = 'runtime landing and DNS refresh'
  const defaultLanding = await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  assert.equal(defaultLanding.status, 302)
  assert.equal(defaultLanding.headers.get('location'), '/login')
  await request('/site/settings', 'PATCH', { landingDisabled: false })
  assert.equal((await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })).status, 302)
  console.log('Verified the landing page defaults off and an administrator cannot override the operator gate')
  env.LANDING_ENABLED = 'true'
  await compose('up', '-d', '--no-build', '--force-recreate', '--wait', 'api', 'web')
  let enabledLanding = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const [response, configResponse] = await Promise.all([
        fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) }),
        fetch(`${origin}/api/v1/config`, { signal: AbortSignal.timeout(5000) }),
      ])
      enabledLanding = response.status === 200 && configResponse.ok && (await configResponse.json()).landingEnabled === true
      if (enabledLanding) break
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(enabledLanding, 'Operator landing opt-in did not reach both upstreams')
  await request('/site/settings', 'PATCH', { landingDisabled: true })
  const disabledLanding = await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  assert.equal(disabledLanding.status, 302)
  assert.equal(disabledLanding.headers.get('location'), '/login')
  await request('/site/settings', 'PATCH', { landingDisabled: false })
  assert.equal((await fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })).status, 200)
  console.log('Verified administrator landing visibility applies without rebuilding')
  env.LANDING_ENABLED = 'false'
  await compose('up', '-d', '--no-build', '--force-recreate', '--wait', 'api', 'web')
  let redirected = false
  let apiRefreshed = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const [response, configResponse] = await Promise.all([
        fetch(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) }),
        fetch(`${origin}/api/v1/config`, { signal: AbortSignal.timeout(5000) }),
      ])
      redirected ||= response.status === 302 && response.headers.get('location') === '/login'
      if (configResponse.status === 200) {
        const config = await configResponse.json() as { landingEnabled?: boolean }
        apiRefreshed ||= config.landingEnabled === false
      }
      if (redirected && apiRefreshed) break
    } catch {
      // Recreated upstream sockets can close while Nginx refreshes Docker DNS.
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  assert.ok(redirected, 'Runtime landing redirect missing after recreation')
  assert.ok(apiRefreshed, 'Runtime API config missing after recreation')
  console.log('Verified runtime landing toggle and proxy upstream DNS refresh without rebuilding')

  phase = 'cold archive and restore'
  await compose('stop', 'proxy', 'api')
  const helper = ['run', '--rm', '--label', `${label}=${owner}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true']
  const archive = await docker([...helper, '--mount', `type=volume,src=${sourceVolume},dst=/data,readonly`, images.api, 'tar', '-czf', '-', '-C', '/data', '.'])
  await docker([...helper, '-i', '--mount', `type=volume,src=${restoreVolume},dst=/data`, images.api, 'tar', '--no-same-owner', '-xzf', '-', '-C', '/data'], archive)
  await docker([...helper, '--mount', `type=volume,src=${restoreVolume},dst=/data`, '--workdir', '/app/apps/api', images.api, 'node', '-e', "const Database=require('better-sqlite3');const db=new Database('/data/hopya.sqlite');const result=db.pragma('integrity_check');if(result.length!==1||result[0].integrity_check!=='ok')process.exit(1);if(db.pragma('foreign_key_check').length)process.exit(2);if(db.prepare('SELECT count(*) AS n FROM attachments').get().n!==1)process.exit(3);db.close()"])
  activeVolume = restoreVolume
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120')
  phase = 'restored application checks'
  // The original signed cookie must still work, not just a newly created login.
  await request('/auth/me')
  assert.equal((await (await request(itemPath)).json()).title, item.title)
  const restored = Buffer.from(await (await request(attachmentPath)).arrayBuffer())
  assert.equal(restored.length, bytes.length)
  assert.equal(createHash('sha256').update(restored).digest('hex'), checksum)
  await request(attachmentPath, 'GET', undefined, 401, { Cookie: '' })
  await request(attachmentPath, 'GET', undefined, 403, { Cookie: otherCookie })
  cookie = session(await request('/auth/login', 'POST', { email, password }, 200, { Cookie: '' }))
  await request(itemPath, 'PATCH', { title: 'Restored writer works' })
  await request(attachmentPath, 'DELETE')
  await request(attachmentPath, 'GET', undefined, 404)
  console.log('Verified cold SQLite + real attachment recovery, original APP_KEY/session, exact bytes, denied access, login, writes and deletion')
} catch (error) {
  failed = true
  const kind = error instanceof assert.AssertionError ? 'assertion' : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'runtime'
  console.error(`Deployment verification FAILED during ${phase} (${kind}). Raw errors/responses withheld to protect secrets.`)
  if (phase === 'Compose startup' && error instanceof Error) console.error(error.message)
  if (phase === 'Compose startup') {
    for (const service of ['api', 'web', 'proxy']) {
      try {
        const id = (await compose('ps', '--all', '-q', service)).toString().trim()
        if (!id) { console.error(`${service}: container was not created`); continue }
        const state = JSON.parse((await docker(['inspect', '--format', '{{json .State}}', id], undefined, true)).toString()) as {
          Status?: string; ExitCode?: number; Health?: { Status?: string }
        }
        console.error(`${service}: status=${state.Status || 'unknown'}, exit=${state.ExitCode ?? 'unknown'}, health=${state.Health?.Status || 'none'}`)
      } catch { console.error(`${service}: status unavailable`) }
    }
  }
  process.exitCode = 1
} finally {
  phase = 'owned-resource cleanup'
  try {
    await browser?.close()
    const containers = (await docker(['ps', '-aq', '--filter', `label=${label}=${owner}`], undefined, true)).toString().trim().split(/\s+/).filter(Boolean)
    for (const id of containers) {
      const info = JSON.parse((await docker(['inspect', id], undefined, true)).toString())[0]
      assert.equal(info.Config.Labels[label], owner)
      await docker(['rm', '-f', id], undefined, true)
    }
    const networks = (await docker(['network', 'ls', '-q', '--filter', `label=${label}=${owner}`], undefined, true)).toString().trim().split(/\s+/).filter(Boolean)
    for (const id of networks) {
      const info = JSON.parse((await docker(['network', 'inspect', id], undefined, true)).toString())[0]
      assert.equal(info.Labels[label], owner)
      await docker(['network', 'rm', id], undefined, true)
    }
    for (const volume of ownedVolumes) {
      const info = JSON.parse((await docker(['volume', 'inspect', volume], undefined, true)).toString())[0]
      assert.equal(info.Labels[label], owner)
      await docker(['volume', 'rm', volume], undefined, true)
    }
    for (const image of Object.values(images)) {
      const found = (await docker(['image', 'ls', '-q', image], undefined, true)).toString().trim()
      if (!found) continue
      const info = JSON.parse((await docker(['image', 'inspect', image], undefined, true)).toString())[0]
      assert.equal(info.Config.Labels[label], owner)
      await docker(['image', 'rm', image], undefined, true)
    }
    console.log(`Removed only this run's labeled containers, network, volumes and image tags (${project})`)
  } catch {
    process.exitCode = 1
    failed = true
    console.error(`Cleanup incomplete; inspect resources labeled ${label}=${owner}. No unlabeled resource is eligible for cleanup.`)
  }
  try { if (environmentDirectory) await rm(environmentDirectory, { recursive: true, force: true }) }
  catch { process.exitCode = 1; failed = true; console.error('Temporary configuration cleanup failed; inspect this test run only.') }
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  if (!failed) console.log('Deployment verification PASSED')
}
