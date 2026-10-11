/**
 * Render the four surviving pages against host-shaped payloads.
 *
 * `scripts/client-lint.mjs` runs the bundle's factory but never calls a page, so
 * a page that still referenced a deleted component would pass it and only fail in
 * the browser. This renders the real element tree with a small React stand-in:
 * same hook order, re-rendered until the async loads settle, with `fetch`
 * answering exactly what `scripts/host-smoke-test.mjs` proves the host sends.
 *
 * It is deliberately a *shape* test, not a pixel one: it asserts each page
 * renders without throwing and that its own copy/keys reach the tree.
 *
 * Run: node scripts/client-render-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── what the host answers (kept in step with host-smoke-test.mjs) ────────────
const SUMMARY = {
  settings: {
    egress: {
      enabled: false, mode: 'subscription', mihomoPath: '', hasUrl: false, urlLabel: '',
      outlet: '', running: false, active: false, node: '', nodeDelayMs: 0, error: '',
    },
  },
  outlet: { node: '', nodeDelayMs: 0, nodeAt: 0 },
  version: '2.1.0',
  channels: { state: 'ready', error: '' },
}
const GATEWAY = {
  relay: { enabled: false, running: false, host: '127.0.0.1', port: 18326, hasKey: false, error: '' },
  gateway: { port: 9999, enabledByEnv: false, keyFound: true, keyFromEnv: false, keyPath: '' },
}

const json = body => Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
globalThis.fetch = url => {
  const path = String(url)
  if (path.includes('/chan-gateway/key')) return json({ key: 'ofm-test-key' })
  if (path.includes('/chan-gateway')) return json(GATEWAY)
  if (path.includes('/egress/url')) return json({ url: '' })
  if (path.includes('/outlet')) return json(SUMMARY.outlet)
  if (path.includes('/summary')) return json(SUMMARY)
  throw new Error(`the render test refuses an unexpected request: ${path}`)
}

// ── a React stand-in: same hook order, re-render on state change ─────────────
let hookIndex = 0
const state = []
const refs = []
const callbacks = []
const effects = []
const runEffect = slot => { const cleanup = slot.fn(); slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined }
let dirty = false
let pending = []

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) },
  }),
  Fragment: Symbol('fragment'),
  useState(initial) {
    const index = hookIndex++
    if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
    return [state[index], next => {
      const value = typeof next === 'function' ? next(state[index]) : next
      if (!Object.is(value, state[index])) { state[index] = value; dirty = true }
    }]
  },
  useEffect(fn, deps) {
    const index = hookIndex++
    const previous = effects[index]
    const first = previous === undefined
    const changed = first || deps === undefined || previous.deps === undefined
      || deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps[at]))
    if (changed) pending.push({ index, fn, deps })
  },
  useMemo(fn) { hookIndex += 1; return fn() },
  useRef(initial) {
    const index = hookIndex++
    if (!(index in refs)) refs[index] = { current: initial }
    return refs[index]
  },
  useCallback(fn, deps) {
    const index = hookIndex++
    const previous = callbacks[index]
    if (previous !== undefined && (deps === undefined || previous.deps === undefined
      || (deps.length === previous.deps.length && deps.every((value, at) => Object.is(value, previous.deps[at]))))) return previous.fn
    callbacks[index] = { fn, deps }
    return fn
  },
}

const renderNode = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return node
  if (Array.isArray(node)) return node.map(renderNode)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return renderNode(node.type(node.props))
  if (node.type === React.Fragment) return renderNode(node.props.children)
  return { ...node, props: { ...node.props, children: renderNode(node.props.children) } }
}

const textOf = node => {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(textOf)
  if (typeof node !== 'object') return []
  return textOf(node.props?.children)
}

// ── load the real bundle ────────────────────────────────────────────────────
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
globalThis.window = {
  __ModuleLoader__: { load: record => { globalThis.__registered = record } },
  localStorage: { store: new Map(), getItem(key) { return this.store.get(key) ?? null }, setItem(key, value) { this.store.set(key, String(value)) } },
  dispatchEvent() {},
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:3080/',
  documentElement: { lang: 'zh' },
  createElement: () => ({ setAttribute() {}, style: {}, remove() {} }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
}
new Function('window', 'document', 'navigator', source)(globalThis.window, globalThis.document, { language: 'zh-CN' })

const record = globalThis.__registered
assert.equal(record?.id, 'dsh-our-free-model', 'the bundle did not register itself')
const plugin = record.factory(name => (name === 'react' ? React : undefined))

let slot = null
const t = key => key
const ctx = {
  locale: { bind: () => t, register() {}, getLocale: () => ({ active: 'zh' }) },
  effect(fn) { const cleanup = fn(); return cleanup },
  slots: {
    inject(name, fn) { if (name === 'settings.section') fn() },
    register(spec, render) { if (spec.name === 'settings.section') slot = render },
  },
}
plugin.apply(ctx)
await check('the plugin registers the one settings section this fork keeps', () => {
  assert.equal(typeof slot, 'function', 'settings.section was not registered')
})

// ── render each tab and let the async loads settle ──────────────────────────
const renderTab = async tab => {
  globalThis.window.localStorage.setItem('ofm.tab', tab)
  hookIndex = 0
  state.length = 0
  refs.length = 0
  callbacks.length = 0
  effects.length = 0
  let tree
  for (let pass = 0; pass < 12; pass += 1) {
    dirty = false
    pending = []
    hookIndex = 0
    tree = renderNode(slot({ t, locale: 'zh' }))
    for (const slotEffect of pending) {
      const previous = effects[slotEffect.index]
      if (previous?.cleanup !== undefined) { try { previous.cleanup() } catch { /* the harness owns the tree */ } }
      effects[slotEffect.index] = slotEffect
      runEffect(slotEffect)
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!dirty) break
  }
  return textOf(tree).join(' ')
}

const expected = {
  channels: ['chan.title', 'CodeArts', 'Gemini'],
  ledger: ['dash.title'],
  logs: ['logs.title'],
  gateway: ['gw.title', 'gw.relayTitle'],
}
const rendered = {}
for (const [tab, needles] of Object.entries(expected)) {
  await check(`the ${tab} page renders with the host's own payload`, async () => {
    const text = await renderTab(tab)
    rendered[tab] = text
    for (const needle of needles) {
      assert.ok(text.includes(needle), `"${needle}" never reached the tree; rendered: ${JSON.stringify(text.slice(0, 180))}`)
    }
  })
}

await check('the pages that were removed render nowhere', () => {
  const all = Object.values(rendered).join(' ')
  for (const key of ['free.title', 'eac.title', 'agg.title', 'saver.title', 'routing.title', 'ann.preamble']) {
    assert.ok(!all.includes(key), `a deleted page is still mounted: ${key}`)
  }
})

await check('the tab bar offers exactly the four surviving pages', () => {
  const text = rendered.channels
  for (const key of ['nav.tab.channels', 'nav.tab.ledger', 'nav.tab.logs', 'nav.tab.gateway']) {
    assert.ok(text.includes(key), `tab ${key} is missing`)
  }
  for (const key of ['nav.tab.free', 'nav.tab.eac', 'nav.tab.aggregate', 'nav.tab.saver', 'nav.tab.routing']) {
    assert.ok(!text.includes(key), `deleted tab ${key} is still offered`)
  }
})

if (failures === 0) console.log('client-render-test: OK')
else console.error(`client-render-test: ${failures} failure(s)`)
// Effects leave intervals behind by design (the channel cards poll); the suite is
// done with them, so it ends here rather than waiting for Node to drain.
process.exit(failures === 0 ? 0 : 1)
