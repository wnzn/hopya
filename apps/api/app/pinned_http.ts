import http from 'node:http'
import https from 'node:https'
import { Resolver } from 'node:dns/promises'
import { isIP, type LookupFunction } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { Effect } from 'effect'
import { HttpError } from './types.js'

export interface PinnedDestination { url: URL; address: string; family: 4 | 6 }
export interface PinnedResponse { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

class OutboundFailure { readonly _tag = 'OutboundFailure'; constructor(readonly message: string, readonly status = 502) {} }

function mappedIpv4(address: string): string | undefined {
  const lower = address.toLowerCase()
  if (!lower.startsWith('::ffff:')) return undefined
  const suffix = lower.slice(7)
  if (isIP(suffix) === 4) return suffix
  const parts = suffix.split(':')
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined
  const value = ((Number.parseInt(parts[0]!, 16) << 16) | Number.parseInt(parts[1]!, 16)) >>> 0
  return [value >>> 24, value >>> 16 & 255, value >>> 8 & 255, value & 255].join('.')
}
function forbidden(address: string): boolean {
  const mapped = mappedIpv4(address)
  if (mapped) return forbidden(mapped)
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 127 || a! >= 224 || (a === 169 && b === 254) || address === '100.100.100.200' || address === '168.63.129.16'
  }
  const value = address.toLowerCase()
  return value === '::' || value === '::1' || /^fe[89ab]/.test(value) || value.startsWith('ff')
}
function privateAddress(address: string): boolean {
  const mapped = mappedIpv4(address); if (mapped) return privateAddress(mapped)
  if (isIP(address) === 4) return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)
  return /^(fc|fd)/i.test(address)
}
function exception(url: URL): boolean {
  return (process.env.AUTOMATION_NETWORK_EXCEPTIONS ?? '').split(',').map((value) => value.trim()).filter(Boolean).includes(url.origin)
}

export const resolvePinnedDestinationEffect = Effect.fnUntraced(function* (input: string, credential = false): Effect.fn.Return<PinnedDestination, HttpError> {
  const url = yield* Effect.try({ try: () => new URL(input), catch: () => new HttpError(400, 'Destination URL is invalid') })
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return yield* Effect.fail(new HttpError(400, 'Destination must be an HTTP(S) URL without embedded credentials or fragments'))
  const hostname = url.hostname.replace(/^\[|\]$/g, ''), literalFamily = isIP(hostname)
  // A resolver belongs to this lookup only: cancellation must not cancel other
  // deliveries, and both address families must be checked before pinning one.
  const resolved = literalFamily ? [{ address: hostname, family: literalFamily as 4 | 6 }] : yield* Effect.acquireUseRelease(
    Effect.sync(() => new Resolver({ timeout: 5000, tries: 1 })),
    (resolver) => Effect.forEach([4, 6] as const, (family) => Effect.tryPromise({
      try: () => family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname),
      catch: () => new HttpError(400, 'Destination host cannot be resolved'),
    }).pipe(Effect.orElseSucceed(() => [] as string[]), Effect.map((addresses) => addresses.map((address) => ({ address, family })))), { concurrency: 2 }).pipe(
      Effect.map((families) => families.flat()),
      Effect.timeoutOrElse({ duration: '5 seconds', orElse: () => Effect.fail(new HttpError(502, 'Destination lookup timed out')) }),
    ),
    (resolver) => Effect.sync(() => resolver.cancel()),
  )
  if (!resolved.length) return yield* Effect.fail(new HttpError(400, 'Destination host cannot be resolved'))
  const excepted = exception(url)
  if (!excepted && resolved.some(({ address }) => forbidden(address))) return yield* Effect.fail(new HttpError(400, 'Destination address is blocked'))
  if (credential && !excepted && !resolved.every(({ address }) => privateAddress(address)) && url.protocol !== 'https:') return yield* Effect.fail(new HttpError(400, 'Public credential destinations require HTTPS'))
  return { url, ...resolved[0]! }
})

export async function resolvePinnedDestination(input: string, credential = false): Promise<PinnedDestination> {
  const result = await Effect.runPromise(Effect.result(resolvePinnedDestinationEffect(input, credential)))
  if (result._tag === 'Failure') throw result.failure
  return result.success
}

export function pinnedRequestEffect(destination: PinnedDestination, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number; totalTimeoutMs?: number; maxResponseBytes?: number; truncateResponse?: boolean }): Effect.Effect<PinnedResponse, OutboundFailure> {
  return Effect.callback<PinnedResponse, OutboundFailure>((resume) => {
    const body = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)
    if (body && body.length > 64 * 1024) { resume(Effect.fail(new OutboundFailure('Outbound request body is too large', 400))); return }
    const maxBytes = options.maxResponseBytes ?? 8192, url = new URL(destination.url), address = destination.address, family = destination.family
    const lookup = ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, address, family)) as LookupFunction
    const client = url.protocol === 'https:' ? https : http
    let settled = false, response: http.IncomingMessage | undefined
    let request: http.ClientRequest | undefined, deadline: NodeJS.Timeout | undefined
    let onData = (_chunk: Buffer) => {}, onEnd = () => {}
    const onResponseError = () => finish(Effect.fail(new OutboundFailure('Outbound response failed')), true)
    const onResponse = (incoming: http.IncomingMessage) => {
      response = incoming
      response.on('error', onResponseError)
      response.once('close', () => incoming.removeListener('error', onResponseError))
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400) { finish(Effect.fail(new OutboundFailure('Outbound redirects are not allowed')), true); return }
      const chunks: Buffer[] = []; let size = 0
      onData = (chunk: Buffer) => {
        const remaining = maxBytes - size
        if (remaining > 0) { const accepted = chunk.subarray(0, remaining); chunks.push(accepted); size += accepted.length }
        if (chunk.length > remaining) finish(options.truncateResponse
          ? Effect.succeed({ status, headers: response!.headers, body: Buffer.concat(chunks, size) })
          : Effect.fail(new OutboundFailure('Outbound response is too large')), true)
      }
      onEnd = () => finish(Effect.succeed({ status, headers: response!.headers, body: Buffer.concat(chunks, size) }))
      response.on('data', onData); response.once('end', onEnd)
    }
    const onRequestError = () => finish(Effect.fail(new OutboundFailure('Outbound request failed')), true)
    const onSocketTimeout = () => finish(Effect.fail(new OutboundFailure('Outbound request timed out')), true)
    const cleanup = () => {
      // Destruction can emit an asynchronous error; retain error handlers until close.
      clearTimeout(deadline); request?.setTimeout(0); request?.removeListener('response', onResponse); request?.removeListener('timeout', onSocketTimeout)
      response?.removeListener('data', onData); response?.removeListener('end', onEnd)
    }
    function finish<A>(effect: Effect.Effect<A, OutboundFailure>, destroy = false) {
      if (settled) return
      settled = true; cleanup()
      if (destroy) { response?.destroy(); request?.destroy() }
      resume(effect as Effect.Effect<PinnedResponse, OutboundFailure>)
    }
    // One socket per pin; a pooled socket could belong to an earlier DNS resolution.
    try {
      request = client.request(url, { method: options.method ?? 'GET', headers: options.headers, lookup, family, agent: false, ...(url.protocol === 'https:' ? { servername: url.hostname, checkServerIdentity } : {}) })
      request.once('response', onResponse); request.on('error', onRequestError)
      request.once('close', () => request?.removeListener('error', onRequestError))
      request.setTimeout(options.timeoutMs ?? 15_000); request.once('timeout', onSocketTimeout)
      deadline = setTimeout(() => finish(Effect.fail(new OutboundFailure('Outbound request timed out')), true), options.totalTimeoutMs ?? options.timeoutMs ?? 15_000)
      if (body) request.write(body)
      request.end()
    } catch {
      // Invalid header names/values throw synchronously and can include secrets
      // in native errors. Keep them in the sanitized, typed failure channel.
      finish(Effect.fail(new OutboundFailure('Outbound request configuration is invalid', 400)), true)
    }
    return Effect.sync(() => { if (!settled) { settled = true; cleanup(); response?.destroy(); request?.destroy() } })
  })
}

export const outboundHttpError = (failure: OutboundFailure): HttpError => new HttpError(failure.status, failure.message)
