import { createConnection, type Socket } from 'node:net'
import { Effect, Semaphore } from 'effect'
import { appUrl } from './settings.js'
import { runPromiseThrow } from './database.js'

const mailPermits = Semaphore.makeUnsafe(2)

export class MailFailure extends Error {
  readonly _tag = 'MailFailure'
  constructor(message = 'Email delivery failed') { super(message) }
}

export const sendMailEffect = Effect.fnUntraced(function* (mail: { to: string; subject: string; text: string }): Effect.fn.Return<{ messageId: string }, MailFailure> {
  const relay = process.env.SMTP_URL
  if (!relay) return yield* Effect.fail(new MailFailure('SMTP is not configured'))
  const nodemailer = yield* Effect.tryPromise({ try: () => import('nodemailer').then((module) => module.default), catch: () => new MailFailure() })
  return yield* mailPermits.withPermits(1)(Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const url = new URL(relay)
        if (!['smtp:', 'smtps:'].includes(url.protocol)) throw new Error('Unsupported SMTP transport')
        for (const [name, value] of Object.entries({ connectionTimeout: '10000', greetingTimeout: '10000', socketTimeout: '15000', pool: 'false', logger: 'false', debug: 'false' })) url.searchParams.set(name, value)
        const controller = new AbortController(), sockets = new Set<Socket>()
        // SMTPTransport.close() alone does not stop an in-flight send. Own the
        // underlying socket so timeout/interruption also stops DNS/connect/TLS.
        const transport = nodemailer.createTransport({ url: url.href, getSocket(options, callback) {
          if (controller.signal.aborted) { callback(new MailFailure(), false); return }
          const socket = createConnection({ host: options.host || url.hostname, port: Number(options.port) || (options.secure ? 465 : 587), signal: controller.signal })
          sockets.add(socket)
          const failed = () => callback(new MailFailure(), false)
          socket.once('error', failed)
          socket.once('close', () => sockets.delete(socket))
          socket.once('connect', () => { socket.removeListener('error', failed); callback(null, { connection: socket }) })
        } })
        return { transport, controller, sockets }
      },
      catch: () => new MailFailure('SMTP configuration is invalid'),
    }),
    ({ transport }) => Effect.tryPromise({
      try: () => transport.sendMail({ ...(process.env.SMTP_FROM ? { from: process.env.SMTP_FROM } : {}), ...mail }),
      catch: () => new MailFailure(),
    }).pipe(Effect.map((sent) => ({ messageId: String(sent.messageId) }))),
    ({ transport, controller, sockets }) => Effect.sync(() => { controller.abort(); for (const socket of sockets) socket.destroy(); transport.close() }),
  ))
}, Effect.timeoutOrElse({ duration: '15 seconds', orElse: () => Effect.fail(new MailFailure('Email delivery timed out')) }))

export const passwordResetEnabled = () => Boolean(process.env.SMTP_URL && process.env.SMTP_FROM)

export async function sendPasswordReset(email: string, token: string): Promise<void> {
  const relay = process.env.SMTP_URL
  const from = process.env.SMTP_FROM
  if (!relay || !from) return
  const link = new URL('/reset-password', appUrl)
  link.hash = `token=${encodeURIComponent(token)}`
  await runPromiseThrow(sendMailEffect({
    to: email,
    subject: 'Reset your Hopya password',
    text: `A password reset was requested for your Hopya account.\n\nOpen this link within 30 minutes:\n${link.href}\n\nIf you did not request this, you can ignore this message.`,
  }).pipe(Effect.mapError(() => new Error('Password reset email delivery failed'))))
}
