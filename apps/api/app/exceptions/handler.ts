import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http'
import { ZodError } from 'zod'
import { HttpError } from '../types.js'

export default class Handler extends ExceptionHandler {
  protected debug = false
  protected reportErrors = false

  async handle(error: unknown, ctx: HttpContext) {
    if (error instanceof HttpError) return ctx.response.status(error.status).send({ error: error.message })
    if (error instanceof ZodError) return ctx.response.badRequest({ error: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ') })
    if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('SQLITE_CONSTRAINT')) {
      return ctx.response.conflict({ error: 'Operation conflicts with existing data' })
    }
    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500
    if (status >= 400 && status < 500) return ctx.response.status(status).send({ error: status === 404 ? 'Not found' : status === 413 ? 'Request too large' : 'Invalid request' })
    // Do not log request bodies, SQL parameters, credentials, or provider errors.
    ctx.logger.error({ requestId: ctx.request.id() }, 'Unhandled API error')
    return ctx.response.internalServerError({ error: 'Internal server error' })
  }
}
