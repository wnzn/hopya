import type { Router } from '@adonisjs/core/http'
import { Effect } from 'effect'
import { registerStorage, collectStorageGarbage } from './storage.js'
import { registerSso } from './sso.js'
import { registerAgent } from './agent.js'

export default function registerIntegrations(router: Router): void {
  registerStorage(router)
  registerSso(router)
  registerAgent(router)
  // Bounded hourly cleanup on the single supported API replica. No raw storage
  // errors are logged; the admin status page exposes the current pending count.
  let collecting = false
  // The tick is an Effect that can only resolve: collection failures are
  // swallowed as values so the hourly schedule survives backend outages.
  const gcTick = Effect.catchAll(
    Effect.tryPromise({
      try: () => collectStorageGarbage(),
      catch: (error) => error as unknown,
    }),
    () => Effect.void,
  )
  const timer = setInterval(() => {
    if (collecting) return
    collecting = true
    void Effect.runPromise(gcTick).then(
      () => { collecting = false },
      () => { collecting = false },
    )
  }, 60 * 60 * 1000)
  timer.unref()
}
