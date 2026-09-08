import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HttpContext } from '@adonisjs/core/http'

const directory = mkdtempSync(join(tmpdir(), 'hopya-limiter-'))
process.env.DATA_DIR = directory
const { rateLimit } = await import('../app/security.js')
const { db, HttpError } = await import('../app/core.js')
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })

function context(ip: string, email: unknown) {
  const headers = new Map<string, string>()
  return { headers, ctx: {
    request: { ip: () => ip, input: () => email },
    response: { header: (name: string, value: string) => headers.set(name, value) },
  } as unknown as HttpContext }
}
const limited = (operation: () => void) => assert.throws(operation, (error: unknown) => error instanceof HttpError && error.status === 429)

test('login windows keep account limits, aggregate invalid attempts, expire, and return retry timing', (t) => {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const first = context('192.0.2.1', ' Alice@Example.test ')
  for (let i = 0; i < 10; i++) rateLimit(first.ctx, 'login')
  limited(() => rateLimit(context('192.0.2.1', 'alice@example.test').ctx, 'login'))
  limited(() => rateLimit(context('192.0.2.1', `${' '.repeat(300)}ALICE@example.test${' '.repeat(300)}`).ctx, 'login'))
  rateLimit(context('192.0.2.1', 'bob@example.test').ctx, 'login')
  for (let i = 13; i < 100; i++) rateLimit(context('192.0.2.1', `${i}@example.test`).ctx, 'login')
  const next = context('192.0.2.1', 'new@example.test')
  limited(() => rateLimit(next.ctx, 'login'))
  assert.equal(next.headers.get('Retry-After'), '900')
  now += 1000
  limited(() => rateLimit(next.ctx, 'login'))
  assert.equal(next.headers.get('Retry-After'), '899')
  rateLimit(context('192.0.2.2', 'alice@example.test').ctx, 'login')
  rateLimit(first.ctx, 'password')
  now += 899000
  rateLimit(first.ctx, 'login')
})

test('login address capacity fails closed without consuming non-login slots and frees expired windows', (t) => {
  let now = Date.now() + 1800000
  t.mock.method(Date, 'now', () => now)
  for (let i = 0; i < 1000; i++) rateLimit(context(`test-address-${i}`, 'test@example.test').ctx, 'login')
  const overflow = context('new-test-address', 'test@example.test')
  limited(() => rateLimit(overflow.ctx, 'login'))
  assert.equal(overflow.headers.get('Retry-After'), '900')
  rateLimit(overflow.ctx, 'setup')
  rateLimit(overflow.ctx, 'oidc-start')
  now += 900000
  rateLimit(overflow.ctx, 'login')
})
