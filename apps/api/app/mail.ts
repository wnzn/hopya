import { Effect } from 'effect'
import { appUrl } from './settings.js'

const mailPermits = Effect.runSync(Effect.makeSemaphore(2))

export const passwordResetEnabled = () => Boolean(process.env.SMTP_URL && process.env.SMTP_FROM)

export async function sendPasswordReset(email: string, token: string): Promise<void> {
  const relay = process.env.SMTP_URL
  const from = process.env.SMTP_FROM
  if (!relay || !from) return
  const link = new URL('/reset-password', appUrl)
  link.hash = `token=${encodeURIComponent(token)}`
  await Effect.runPromise(mailPermits.withPermits(1)(Effect.tryPromise({
    try: async () => {
      const nodemailer = (await import('nodemailer')).default
      const transportUrl = new URL(relay)
      if (!['smtp:', 'smtps:'].includes(transportUrl.protocol)) throw new Error('Unsupported SMTP transport')
      transportUrl.searchParams.set('connectionTimeout', '10000')
      transportUrl.searchParams.set('greetingTimeout', '10000')
      transportUrl.searchParams.set('socketTimeout', '15000')
      const transport = nodemailer.createTransport(transportUrl.href)
      try {
        await transport.sendMail({
          from,
          to: email,
          subject: 'Reset your Hopya password',
          text: `A password reset was requested for your Hopya account.\n\nOpen this link within 30 minutes:\n${link.href}\n\nIf you did not request this, you can ignore this message.`,
        })
      } finally { transport.close() }
    },
    catch: () => new Error('Password reset email delivery failed'),
  })))
}
