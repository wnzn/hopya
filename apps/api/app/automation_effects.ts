import { Effect, Semaphore } from 'effect'
import { db } from './database.js'
import { HttpError } from './types.js'

export class AutomationLeaseLost extends Error {
  readonly _tag = 'AutomationLeaseLost'
  constructor() { super('Automation lease was lost') }
}

export interface AutomationLease { id: string; workspaceId: string; leaseId?: string | null }
export type AutomationFailure = HttpError | AutomationLeaseLost

// Lucid/service Promises cannot be aborted. Wait for their actual outcome before
// interruption can release a worker permit or record a terminal run state.
// Network deadlines belong to abortable transports. Never retry writes here.
const sqliteState = Semaphore.makeUnsafe(1)
export const automationIO = <A>(work: () => Promise<A>): Effect.Effect<A, AutomationFailure> => {
  const operation = Effect.uninterruptible(Effect.tryPromise({
    try: work,
    catch: (error) => error instanceof HttpError || error instanceof AutomationLeaseLost ? error : new HttpError(503, 'Automation state operation failed'),
  }))
  // better-sqlite3's busy wait blocks the same JS loop needed to commit another
  // worker's transaction. Serialize local state work, not network deliveries.
  return db.dialect === 'sqlite' ? sqliteState.withPermits(1)(operation) : operation
}

export const automationData = <A>(read: () => A): Effect.Effect<A, HttpError> => Effect.try({
  try: read,
  catch: () => new HttpError(400, 'Stored automation data is invalid'),
})

export async function heartbeat(run: AutomationLease): Promise<void> {
  if (!run.leaseId) throw new AutomationLeaseLost()
  const changed = await db.run("UPDATE automation_runs SET heartbeatAt=? WHERE workspaceId=? AND id=? AND status='running' AND leaseId=?", new Date().toISOString(), run.workspaceId, run.id, run.leaseId)
  if (!changed.changes) throw new AutomationLeaseLost()
}
