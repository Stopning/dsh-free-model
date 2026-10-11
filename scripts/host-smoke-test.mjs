/**
 * Mount the slim host half and drive its whole HTTP surface offline.
 *
 * After the model lane was removed, the host is exactly this: a settings file,
 * the egress outlet, the pack's gateway relay, and the JSON API the four
 * surviving pages read. No network, no credentials, no real DSH profile — a
 * plain object stands in for cordis' `ctx`.
 *
 * It also pins the *absent* surface. Every route the removed features owned
 * (`/stats`, `/bench`, `/eac/*`, `/forward/*`, `/clients`, `/providers`,
 * `/token-saver`, `/combos`, `/announcements*`, `/update/*`, `/reload`, `/meta`)
 * must answer 404, because a page that still calls one of them would render a
 * dead panel instead of failing loudly.
 *
 * Run: node scripts/host-smoke-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-host-'))
process.env.DSH_HOME = scratch
process.env.DSH_CHANNEL_PACK_STATE_DIR = path.join(scratch, 'pack')
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
fs.mkdirSync(process.env.DSH_CHANNEL_PACK_STATE_DIR, { recursive: true })

// The mount must not be able to reach anything: a host that tried would hang the
// suite on a machine with no route out, which is exactly what a CI box is.
globalThis.fetch = async url => { throw new Error(`external network is disabled in the host smoke test (${String(url)})`) }

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── a composition just real enough for `apply` ───────────────────────────────
const routes = []
const disposers = []
const quiet = { info() {}, warn() {}, debug() {}, log() {} }
const scope = extra => ({
  ...extra,
  logger: quiet,
  get: () => undefined,
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
})
const ctx = {
  logger: quiet,
  get: () => undefined,
  on() {},
  effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
  inject(deps, callback) {
    if (deps.includes('webServer')) return callback(scope({ webServer: { register: route => routes.push(route) } }))
    // The pack's own fiber. This stub cannot carry it, and the host is required
    // to survive that with a reported reason rather than a thrown mount.
    return callback(scope({ llm: {}, credentials: {}, commands: {}, provide() {}, set() {} }))
  },
}

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const { apply, version, inject, name } = await import('../index.js')

check('the plugin declares its identity and its one hard dependency', () => {
  assert.equal(name, 'our-free-model')
  assert.deepEqual(inject, ['llm'])
  assert.equal(version, pkg.version)
})

apply(ctx)
check('the settings API mounted one prefix route and no other', () => {
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/our-free-model')
  assert.equal(typeof routes[0].handler, 'function')
})
const handler = routes[0].handler
const API = '/api/our-free-model'

const call = async (method, url, body, headers = {}) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    method,
    url,
    headers: { host: '127.0.0.1:3080', ...headers },
    [Symbol.asyncIterator]() {
      return { next: async () => (chunks.length === 0 ? { done: true, value: undefined } : { done: false, value: chunks.shift() }) }
    },
  }
  const res = {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders },
    end(payload) { this.body = payload ?? '' },
  }
  await handler(req, res)
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { status: res.status, json, raw: res.body }
}

// ── the trust fence still guards the surface ─────────────────────────────────
await check('a cross-site or non-loopback caller is refused before any route runs', async () => {
  assert.equal((await call('GET', `${API}/summary`, undefined, { host: 'evil.example' })).status, 403)
  assert.equal((await call('GET', `${API}/summary`, undefined, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await call('GET', `${API}/summary`, undefined, { origin: 'http://evil.example' })).status, 403)
})

// ── what the four surviving pages read ──────────────────────────────────────
let summary
await check('GET /summary answers the four pages\' document', async () => {
  const response = await call('GET', `${API}/summary`)
  assert.equal(response.status, 200)
  summary = response.json
  assert.equal(summary.version, pkg.version)
  assert.equal(typeof summary.channels?.state, 'string')
  assert.ok(['pending', 'ready', 'failed'].includes(summary.channels.state))
  const egress = summary.settings?.egress
  assert.equal(typeof egress, 'object')
  assert.equal(egress.enabled, false)
  assert.equal(egress.hasUrl, false)
  assert.equal(egress.urlLabel, '')
  assert.equal(egress.running, false)
  assert.equal(egress.active, false)
  assert.equal(egress.error, '')
  assert.deepEqual(summary.outlet, { running: false, active: false, mode: '', outlet: '', node: '', nodeDelayMs: 0, nodeAt: 0, error: '' })
})
await check('/summary never carries the stored subscription address', async () => {
  assert.equal(Object.hasOwn(summary.settings.egress, 'url'), false)
})

await check('the pack mount reports a reason instead of throwing when the composition cannot carry it', async () => {
  for (let attempt = 0; attempt < 60 && summary.channels.state === 'pending'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    summary = (await call('GET', `${API}/summary`)).json
  }
  assert.notEqual(summary.channels.state, 'pending', 'the pack mount never settled')
  assert.equal(typeof summary.channels.error, 'string')
  if (summary.channels.state === 'failed') assert.ok(summary.channels.error.length > 0, 'a failed mount must say why')
})

await check('GET /outlet answers a reading, not an error, while the outlet is off', async () => {
  const response = await call('GET', `${API}/outlet`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { node: '', nodeDelayMs: 0, nodeAt: 0 })
})

await check('GET /egress/url serves the credential on demand only', async () => {
  const response = await call('GET', `${API}/egress/url`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { url: '' })
})

// ── POST /settings: the egress section and nothing else ─────────────────────
await check('POST /settings accepts an outlet patch and answers the public section', async () => {
  const response = await call('POST', `${API}/settings`, { egress: { enabled: false, mode: 'client', url: 'http://127.0.0.1:7897' } })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.settings.egress.mode, 'client')
  assert.equal(response.json.settings.egress.hasUrl, true)
  // A bare proxy URL carries no credential, so the whole origin is the label.
  assert.equal(response.json.settings.egress.urlLabel, 'http://127.0.0.1:7897')
})
await check('the subscription path — where the token lives — never leaves the process', async () => {
  const secret = 'https://sub.example.com/link/PRIVATE-TOKEN'
  const response = await call('POST', `${API}/settings`, { egress: { enabled: false, mode: 'subscription', url: secret } })
  assert.equal(response.status, 200)
  assert.equal(response.json.settings.egress.urlLabel, 'https://sub.example.com')
  const summary = (await call('GET', `${API}/summary`)).json
  assert.equal(JSON.stringify(summary).includes('PRIVATE-TOKEN'), false)
  assert.equal((await call('GET', `${API}/egress/url`)).json.url, secret, 'the value itself is served only by GET /egress/url')
})
await check('POST /settings refuses an outlet with no address', async () => {
  const response = await call('POST', `${API}/settings`, { egress: { enabled: true, mode: 'client', url: '' } })
  assert.equal(response.status, 400)
  assert.match(response.json.error, /needs a subscription or proxy URL/)
})
await check('POST /settings refuses an unknown outlet mode', async () => {
  const response = await call('POST', `${API}/settings`, { egress: { mode: 'portal' } })
  assert.equal(response.status, 400)
  assert.match(response.json.error, /"subscription" or "client"/)
})
await check('POST /settings ignores every field the removed lanes used', async () => {
  const response = await call('POST', `${API}/settings`, { enabled: false, forward: { enabled: true }, probeIntervalMinutes: 1, aggregate: { providers: { x: {} } } })
  assert.equal(response.status, 200)
  const stored = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  assert.equal(stored.forward, undefined)
  assert.equal(stored.aggregate, undefined)
  assert.equal(stored.probeIntervalMinutes, undefined)
})
await check('POST /settings refuses a malformed body instead of silently doing nothing', async () => {
  const chunks = [Buffer.from('{not json')]
  const req = { method: 'POST', url: `${API}/settings`, headers: { host: '127.0.0.1:3080' }, [Symbol.asyncIterator]: () => ({ next: async () => (chunks.length === 0 ? { done: true } : { done: false, value: chunks.shift() }) }) }
  const res = { status: 0, writeHead(status) { this.status = status }, end(payload) { this.body = payload } }
  await handler(req, res)
  assert.equal(res.status, 400)
  assert.match(String(res.body), /invalid JSON body/)
})

// ── the pack's gateway relay ────────────────────────────────────────────────
await check('GET /chan-gateway reports the relay and the gateway without a secret', async () => {
  const response = await call('GET', `${API}/chan-gateway`)
  assert.equal(response.status, 200)
  assert.equal(response.json.relay.enabled, false)
  assert.equal(response.json.relay.running, false)
  assert.equal(response.json.relay.port, 18326)
  assert.equal(response.json.relay.hasKey, false)
  assert.equal(typeof response.json.gateway.port, 'number')
  assert.equal(Object.hasOwn(response.json.relay, 'key'), false)
})
await check('POST /chan-gateway/apply moves the relay and refuses a foreign bind address', async () => {
  const moved = await call('POST', `${API}/chan-gateway/apply`, { host: '0.0.0.0', port: 18327 })
  assert.equal(moved.status, 200)
  assert.equal(moved.json.relay.host, '0.0.0.0')
  assert.equal(moved.json.relay.port, 18327)
  const refused = await call('POST', `${API}/chan-gateway/apply`, { host: 'example.com' })
  assert.equal(refused.status, 400)
  const outOfRange = await call('POST', `${API}/chan-gateway/apply`, { port: 70000 })
  assert.equal(outOfRange.status, 400)
})
await check('the relay key is minted once, rotated on demand, and persisted', async () => {
  const first = await call('GET', `${API}/chan-gateway/key`)
  assert.equal(first.status, 200)
  assert.match(first.json.key, /^ofm-[A-Za-z0-9_-]{32}$/)
  assert.equal((await call('GET', `${API}/chan-gateway/key`)).json.key, first.json.key, 'a second read must not mint a new key')
  const rotated = await call('POST', `${API}/chan-gateway/rotate`)
  assert.match(rotated.json.key, /^ofm-/)
  assert.notEqual(rotated.json.key, first.json.key)
  const stored = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  assert.equal(stored.chanGateway.relay.key, rotated.json.key)
  assert.equal(stored.chanGateway.relay.port, 18327)
})

// ── the surface that must no longer exist ──────────────────────────────────
await check('every route the removed features owned now answers 404', async () => {
  const removed = [
    '/stats', '/refresh', '/reprobe', '/bench', '/pool', '/meta', '/clients',
    '/eac/status', '/eac/logout', '/forward/key', '/forward/rotate', '/forward/lan/key',
    '/forward/lan/addresses', '/announcement', '/announcements', '/announcements/refresh',
    '/update/status', '/update/check', '/reload', '/providers', '/providers/test',
    '/token-saver', '/local-optimize', '/combos',
  ]
  for (const route of removed) {
    const response = await call('GET', `${API}${route}`)
    assert.equal(response.status, 404, `${route} answered ${response.status}, expected 404`)
    assert.equal(response.json.error, 'not found')
  }
})

// ── teardown: nothing left holding a listener, state on disk ────────────────
await check('disposing the plugin closes its listeners and flushes the store', async () => {
  for (const dispose of disposers.reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
  const stored = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'settings.json'), 'utf8'))
  assert.equal(stored.egress.mode, 'subscription')
  assert.equal(stored.egress.url, 'https://sub.example.com/link/PRIVATE-TOKEN')
})

fs.rmSync(scratch, { recursive: true, force: true })
if (failures === 0) console.log('host-smoke-test: OK')
else { console.error(`host-smoke-test: ${failures} failure(s)`); process.exit(1) }
