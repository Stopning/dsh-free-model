/**
 * Bearer keys for the plugin's own local listener.
 *
 * Split out of `src/forward.js` when the upstream forward listener was stripped
 * from this fork: the channels' LAN relay (`src/chan-relay.js`) needs a key
 * generator and a constant-time comparison, and nothing else of that module.
 *
 * @module src/key.js
 */

import crypto from 'node:crypto'

/** Mint a key that names its issuer, so a leak is attributable in a log line. */
export function generateKey() {
  return `ofm-${crypto.randomBytes(24).toString('base64url')}`
}

/** Constant-time comparison of a bearer token against the issued key. */
export function keyMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}
