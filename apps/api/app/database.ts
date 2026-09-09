import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Cause, Effect, Exit } from 'effect'
import { dataDir } from './settings.js'

mkdirSync(dataDir, { recursive: true, mode: 0o700 })
export const db = new Database(join(dataDir, 'hopya.sqlite'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

// Typed database failures, kept as values so callers compose audit writes and
// mutations with Effect combinators instead of try/catch. The public audit()
// below unwraps the original cause so transaction rollback semantics are
// unchanged for existing callers and tests.
export class DbFailure {
  readonly _tag = 'DbFailure'
  constructor(readonly message: string, readonly cause?: unknown) {}
}

// Lift a synchronous better-sqlite3 thunk into an Effect. All database I/O in
// this layer is synchronous, so callers run the result with Effect.runSync.
export const dbSync = <A>(fn: () => A, message: string): Effect.Effect<A, DbFailure> =>
  Effect.try({
    try: fn,
    catch: (cause) => new DbFailure(message, cause),
  })

// Module boundaries: Effect.runSync/runPromise wrap every failure in
// FiberFailure, which would break `instanceof HttpError` checks in routes and
// tests. These helpers rethrow the original failure/defect instead, so public
// signatures keep their exact error identity while pipelines stay composed.
const unwrapCause = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.failureOption(cause)
  if (failure._tag === 'Some') return failure.value
  const defect = Cause.dieOption(cause)
  if (defect._tag === 'Some') return defect.value
  return cause
}

export const runSyncThrow = <A, E>(effect: Effect.Effect<A, E>): A => {
  const exit = Effect.runSyncExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  throw unwrapCause(exit.cause)
}

export const runPromiseThrow = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(effect).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value
    throw unwrapCause(exit.cause)
  })

export const auditEffect = (
  actorId: string | null,
  workspaceId: string | null,
  action: string,
  resourceId: string | null,
  details: Record<string, unknown> = {},
): Effect.Effect<void, DbFailure> =>
  dbSync(() => {
    db.prepare('INSERT INTO audit_logs (id,actorId,workspaceId,action,resourceId,details,createdAt) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), actorId, workspaceId, action, resourceId, JSON.stringify(details), new Date().toISOString())
  }, 'Audit write failed')

export function audit(actorId: string | null, workspaceId: string | null, action: string, resourceId: string | null, details: Record<string, unknown> = {}): void {
  try {
    runSyncThrow(auditEffect(actorId, workspaceId, action, resourceId, details))
  } catch (error) {
    // Preserve the original driver error so enclosing db.transaction() blocks
    // roll back exactly as before the Effect refactor (see the suspension
    // rollback regression test).
    if (error instanceof DbFailure && error.cause !== undefined) throw error.cause
    throw error
  }
}
