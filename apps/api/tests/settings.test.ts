import { test } from './japa.js'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('../', import.meta.url))
function settings(environment: Record<string, string | undefined>) {
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const s = await import('./app/settings.ts'); console.log(JSON.stringify({dataDir:s.dataDir,appUrl:s.appUrl.origin,keyLength:s.appKey.length,registrationEnabled:s.registrationEnabled}))`], {
    cwd, env: { ...process.env, APP_KEY: undefined, DATA_DIR: undefined, APP_URL: undefined, REGISTRATION_ENABLED: undefined, ...environment }, encoding: 'utf8',
  })
}
test('production rejects missing or short keys; development generates an ephemeral key', () => {
  assert.notEqual(settings({ NODE_ENV: 'production' }).status, 0)
  assert.notEqual(settings({ NODE_ENV: 'production', APP_KEY: 'short' }).status, 0)
  assert.notEqual(settings({ NODE_ENV: 'development', APP_KEY: 'short' }).status, 0)
  const development = settings({ NODE_ENV: 'development' })
  assert.equal(development.status, 0, development.stderr)
  const config = JSON.parse(development.stdout)
  assert.ok(config.keyLength >= 32)
  assert.equal(config.appUrl, 'http://localhost:4321')
  assert.equal(config.dataDir, fileURLToPath(new URL('../../../data', import.meta.url)))
  assert.equal(config.registrationEnabled, false)
  assert.equal(settings({ NODE_ENV: 'production', APP_KEY: 'random-secret-material-for-tests-only-123456' }).status, 0)
})
test('only explicit registration enablement and HTTP application URLs are accepted', () => {
  assert.equal(JSON.parse(settings({ REGISTRATION_ENABLED: 'true' }).stdout).registrationEnabled, true)
  assert.equal(JSON.parse(settings({ REGISTRATION_ENABLED: '1' }).stdout).registrationEnabled, false)
  assert.notEqual(settings({ APP_URL: 'file:///etc/passwd' }).status, 0)
})
