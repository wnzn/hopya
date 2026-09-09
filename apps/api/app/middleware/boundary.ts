import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { Effect } from 'effect'
import { checkOrigin } from '../security.js'
import { allowAnyOrigin } from '../settings.js'
import { runPromiseThrow } from '../database.js'

const applySecurityHeaders = (ctx: HttpContext): Effect.Effect<void> =>
  Effect.sync(() => {
    ctx.response.header('X-Content-Type-Options', 'nosniff')
    ctx.response.header('Cache-Control', 'no-store')
    ctx.response.header('Referrer-Policy', 'same-origin')
  })

const applyOpenCors = (ctx: HttpContext): Effect.Effect<boolean> =>
  Effect.sync(() => {
    if (!allowAnyOrigin) return false
    // Dev-only open CORS: echo the requesting origin so cookie and bearer
    // clients on any host can call the API. Preflights end here.
    const origin = ctx.request.header('origin')
    ctx.response.header('Access-Control-Allow-Origin', origin ?? '*')
    ctx.response.header('Vary', 'Origin')
    ctx.response.header('Access-Control-Allow-Credentials', 'true')
    ctx.response.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
    ctx.response.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
    if (ctx.request.method() === 'OPTIONS') {
      ctx.response.status(204)
      return true
    }
    return false
  })

// Origin admission reuses the public security boundary (typed Effect pipeline
// mapped to HttpError there), so browser/bearer semantics stay identical.
const enforceOrigin = (ctx: HttpContext): Effect.Effect<void> =>
  Effect.promise(() => checkOrigin(ctx))

export default class BoundaryMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const handled = await runPromiseThrow(Effect.gen(function* () {
      yield* applySecurityHeaders(ctx)
      // A handled preflight ends here. Otherwise open CORS replaces only the
      // origin check; the route still runs.
      if (yield* applyOpenCors(ctx)) return true
      if (!allowAnyOrigin) yield* enforceOrigin(ctx)
      return false
    }))
    if (handled) return
    await next()
  }
}
