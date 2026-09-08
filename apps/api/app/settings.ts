import { randomBytes } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Cause, Effect, Exit } from 'effect'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
// Both source app/ and compiled build/app/ resolve the same API project directory.
export const apiRoot = resolve(moduleDirectory, moduleDirectory.endsWith('/build/app') ? '../..' : '..')
export const dataDir = resolve(apiRoot, process.env.DATA_DIR || '../../data')
export const production = process.env.NODE_ENV === 'production'

// Typed config failures, kept as values inside the loading pipeline and
// mapped to the pre-existing Error messages at the module boundary below.
class ConfigError {
  readonly _tag = 'ConfigError'
  constructor(readonly message: string) {}
}

const loadAppUrl = Effect.try({
  try: () => {
    const url = new URL(process.env.APP_URL || 'http://localhost:4321')
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('APP_URL must use HTTP or HTTPS')
    return url
  },
  catch: (cause) => new ConfigError(cause instanceof Error ? cause.message : 'Invalid APP_URL'),
})

const loadAppKey = Effect.try({
  try: () => {
    if ((production && !process.env.APP_KEY) || (process.env.APP_KEY !== undefined && process.env.APP_KEY.length < 32)) {
      throw new Error('APP_KEY must contain at least 32 characters of random secret material; production requires an explicit key')
    }
    return process.env.APP_KEY || randomBytes(32).toString('hex')
  },
  catch: (cause) => new ConfigError(cause instanceof Error ? cause.message : 'Invalid APP_KEY'),
})

const configEffect = Effect.gen(function* () {
  const url = yield* loadAppUrl
  const key = yield* loadAppKey
  return { url, key }
})

const loadConfig = (): { url: URL; key: string } => {
  const exit = Effect.runSyncExit(configEffect)
  if (Exit.isSuccess(exit)) return exit.value
  // Reproduce the pre-existing plain Error messages at the module boundary
  // (runSync would wrap the ConfigError in FiberFailure). Local unwrap: the
  // shared helper lives in database.js, which imports this module.
  const failure = Cause.failureOption(exit.cause)
  if (failure._tag === 'Some' && failure.value instanceof ConfigError) throw new Error(failure.value.message)
  const defect = Cause.dieOption(exit.cause)
  if (defect._tag === 'Some') throw defect.value
  throw exit.cause
}
const { url: appUrl, key: appKey } = loadConfig()
export { appUrl, appKey }
export const registrationEnabled = process.env.REGISTRATION_ENABLED === 'true'
export const sessionSeconds = 60 * 60 * 24 * 7
// Dev-only escape hatch: accept cross-origin browser requests from any origin
// (same-origin mutation checks off, CORS preflights answered). Never enable on
// a reachable production instance: it reopens cookie-based CSRF.
export const allowAnyOrigin = process.env.ALLOW_ANY_ORIGIN === 'true'
if (allowAnyOrigin) console.warn('[hopya] ALLOW_ANY_ORIGIN=true: accepting cross-origin requests from any origin')
