import { defineConfig } from '@adonisjs/core/http'
import { appUrl } from '../app/settings.js'

const proxyHops = process.env.TRUST_PROXY_HOPS || '0'
if (!['0', '1'].includes(proxyHops)) throw new Error('TRUST_PROXY_HOPS must be 0 or 1')
export const http = defineConfig({
  generateRequestId: true,
  allowMethodSpoofing: false,
  // Enable only when the API is private behind the supplied proxy, which
  // overwrites forwarding headers. Never trust a user-supplied longer chain.
  trustProxy: proxyHops === '1' ? (_address, distance) => distance === 0 : false,
  useAsyncLocalStorage: false,
  cookie: { domain: '', path: '/', httpOnly: true, secure: appUrl.protocol === 'https:', sameSite: 'lax' },
})
