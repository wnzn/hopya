import { randomBytes, randomUUID } from 'node:crypto'
import { link, open, readFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
type Mode = 'docker' | 'development'

export async function initializeEnvironment(options: { directory?: string; mode?: Mode; port?: number } = {}) {
  const mode = options.mode ?? 'docker'
  if (mode !== 'docker' && mode !== 'development') throw new Error('Choose docker or development mode')
  const port = options.port ?? (mode === 'docker' ? 8888 : 4321)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || mode === 'development' && port === 3333) {
    throw new Error('Choose a valid web port distinct from the development API port 3333')
  }
  const directory = resolve(options.directory || projectRoot)
  const path = join(directory, '.env')
  let template = await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  const example = parseEnv(template)
  for (const key of ['APP_KEY', 'SETUP_TOKEN', 'SMTP_URL', 'AI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'OIDC_CLIENT_SECRET']) {
    if (example[key]) throw new Error('The example configuration must not contain credentials')
  }
  const values = {
    APP_KEY: randomBytes(32).toString('hex'),
    SETUP_TOKEN: randomBytes(32).toString('hex'),
    APP_URL: `http://localhost:${port}`,
    BIND_ADDRESS: '127.0.0.1',
    HTTP_PORT: String(mode === 'docker' ? port : 8080),
    HOST: mode === 'development' ? '127.0.0.1' : '0.0.0.0',
    API_PORT: '3333',
    PORT: String(mode === 'development' ? port : 4321),
    DATA_DIR: mode === 'development' ? '../../data' : '/data',
    TRUST_PROXY_HOPS: '0',
    REGISTRATION_ENABLED: 'false',
    STORAGE_DRIVER: 'filesystem',
    OIDC_ISSUER: '', OIDC_AUTO_PROVISION: 'false', OIDC_ALLOW_INSECURE_HTTP: 'false',
    AI_PROVIDER: '',
  }
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${key}=.*$`, 'gm')
    if (Array.from(template.matchAll(pattern)).length !== 1) throw new Error('Invalid example configuration')
    template = template.replace(pattern, `${key}=${value}`)
  }
  template = `# Generated private ${mode} configuration; no accounts were created.\n` + template
  const temporary = join(directory, `.env.init-${randomUUID()}`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let created = false
  try {
    handle = await open(temporary, 'wx', 0o600)
    created = true
    await handle.chmod(0o600)
    await handle.writeFile(template, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    // A same-directory hard link publishes only complete bytes and never replaces
    // an existing file, directory or symlink, including racing initializers.
    await link(temporary, path)
  } finally {
    await handle?.close()
    if (created) await unlink(temporary)
  }
  return { path, mode, url: values.APP_URL, port }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = 'Usage: npm run init:env -- [--docker | --development] [--port PORT]'
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--help') console.log(usage)
    else {
      let mode: Mode | undefined
      let port: number | undefined
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if ((arg === '--docker' || arg === '--development') && mode === undefined) mode = arg === '--docker' ? 'docker' : 'development'
        else if (arg === '--port' && port === undefined && /^\d{1,5}$/.test(args[i + 1] || '')) port = Number(args[++i])
        else throw new Error(usage)
      }
      const result = await initializeEnvironment({ mode, port })
      console.log(`Created private .env for ${result.mode} at ${result.url}. Generated secrets were not printed; no accounts were created.`)
      console.log(result.mode === 'docker' ? 'Next: docker compose up -d --build --wait' : 'Next: npm ci, then npm run dev')
      console.log('Complete administrator setup at /login using SETUP_TOKEN from the private .env. Keep that file out of logs and source control.')
    }
  } catch (error) {
    console.error((error as NodeJS.ErrnoException)?.code === 'EEXIST'
      ? 'An .env already exists and was left unchanged. Review it instead of regenerating live secrets.'
      : `Configuration initialization failed. Check arguments, template and directory permissions. ${usage}`)
    process.exitCode = 1
  }
}
