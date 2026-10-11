#!/usr/bin/env node
/**
 * egress-audit —— 出网面审计（可复跑，只读）
 *
 * 输入
 *   --root <dir>   被审的插件目录。默认＝本脚本所在仓库根目录；审装机副本时传
 *                  `--root ~/.dsh/profiles/web/node_modules/dsh-our-free-model`
 *   --tls          额外做一次联网验证：对源码里出现的每个非回环主机做 TLS 握手，
 *                  打印证书主体 / 签发者 / 是否通过校验。**默认关闭**（离线）。
 *   --json         以 JSON 输出（便于喂给别的工具）。默认输出人读文本。
 *
 * 输出（stdout，不写任何文件）
 *   1. 产物里出现的全部 http(s) 主机，按出现次数排序，附所在文件
 *   2. 明文 http（非回环）端点 —— 逐个列出，便于判断是否承载凭据
 *   3. `listen(...)` 的绑定地址 —— 找「只听回环」与「听了 0.0.0.0」的差别
 *   4. `pack.js` 与可读源码 `vendor/channel-pack/src/` 的**域名差集**
 *      （打包产物比源码多出来的主机，必须逐个能解释）
 *   5. `--tls`：证书主体表，用来证明流量终点是厂商而不是第三方
 *
 * 不做什么：不判断请求是否带凭据、不做 MITM、不修改任何文件。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lookup } from 'node:dns/promises'
import { connect as tlsConnect } from 'node:tls'

/* ── 解析参数 ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const flag = name => argv.includes(`--${name}`)
const opt = name => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(opt('root') ?? join(SCRIPT_DIR, '..'))
const WITH_TLS = flag('tls')
const AS_JSON = flag('json')

/* ── 主机名规则 ───────────────────────────────────────────────────────── */

/** 回环 / 未指定地址：不是「出网」。 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '[::1]', '[::]', '*'])

/** 语义噪声：规范链接、示例域名、不可路由 TLD。审计里单独说明，不计入出网面。 */
const NON_ROUTABLE = /(^|\.)(invalid|test|example|local|internal|localhost)$/i
const SPEC_SITES = new Set([
  'fetch.spec.whatwg.org', 'w3c.github.io', 'www.w3.org', 'www.ietf.org',
  'datatracker.ietf.org', 'www.rfc-editor.org', 'html.spec.whatwg.org',
  'websockets.spec.whatwg.org', 'mimesniff.spec.whatwg.org', 'webidl.spec.whatwg.org',
  'whatpr.org', 'json-schema.org',
])

/**
 * 权威来源：带协议的 URL。属性访问（`block.name`）与文件名（`login.sh`）都不会命中。
 */
const URL_RE = /https?:\/\/([A-Za-z0-9._~%:@-]{3,160})/g

/**
 * 次要来源：**引号里的**裸域名。只认 TLD 白名单，且必须被引号包住 ——
 * 这样 `'api.z.ai'` 这种常量跑不掉，`ctx.logger.info` / `login.sh` 这类噪声进不来。
 */
const BARE_RE = /['"`]([a-z0-9][a-z0-9-]{0,40}(?:\.[a-z0-9][a-z0-9-]{0,40}){1,4}\.(?:com|cn|net|org|io|dev|ai|bot|guru|app|cloud|sh))['"`]/gi

function hostOf(raw) {
  return raw.split('/')[0].split('@').pop().split(':')[0].toLowerCase()
}
function isNoise(h) {
  // 没有点的主机名只可能是模板占位（`http://host:port`）或回环别名。
  return !h.includes('.') || LOOPBACK.has(h) || NON_ROUTABLE.test(h) || SPEC_SITES.has(h) || h === ''
}

/* ── 采集 ─────────────────────────────────────────────────────────────── */

const RUNTIME_FILES = new Set([
  'index.js', 'client.js', 'package.json', 'cordis.patch.yml',
])
const TEXT_EXT = new Set(['.js', '.mjs', '.ts', '.json', '.yml', '.yaml', '.md'])

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (TEXT_EXT.has(extname(name))) out.push(p)
  }
  return out
}

/** 被审的运行时文件面：宿主 `index.js`、浏览器 `client.js`、`src/`、渠道包。 */
function artifactFiles(root) {
  const files = []
  for (const name of RUNTIME_FILES) {
    const p = join(root, name)
    if (existsSync(p) && statSync(p).isFile()) files.push(p)
  }
  files.push(...walk(join(root, 'src')))
  for (const name of ['vendor/channel-pack/pack.js', 'vendor/channel-pack/NOTICE.md']) {
    const p = join(root, name)
    if (existsSync(p)) files.push(p)
  }
  files.push(...walk(join(root, 'vendor/channel-pack/src')))
  return [...new Set(files)]
}

const perHost = new Map() // host -> { count, files: Set, bare: bool }
const plainHttp = new Map() // host -> { count, samples: [] }
const listeners = []
const packHosts = new Set()
const srcHosts = new Set()

function record(host, rel, raw, bare = false) {
  if (isNoise(host)) return
  if (!perHost.has(host)) perHost.set(host, { count: 0, files: new Set(), bare })
  const e = perHost.get(host)
  if (!bare) e.bare = false // 只要有一次带协议的用法，就算权威
  e.count++
  e.files.add(rel)
  if (raw.startsWith('http://')) {
    if (!plainHttp.has(host)) plainHttp.set(host, { count: 0, samples: [] })
    const p = plainHttp.get(host)
    p.count++
    if (p.samples.length < 2) p.samples.push(raw.slice(0, 90))
  }
}

for (const file of artifactFiles(ROOT)) {
  const rel = relative(ROOT, file)
  const txt = readFileSync(file, 'utf8')
  for (const m of txt.matchAll(URL_RE)) record(hostOf(m[1]), rel, m[0])
  for (const m of txt.matchAll(BARE_RE)) record(m[1].toLowerCase(), rel, m[0], true)
  for (const m of txt.matchAll(/listen\(\s*[^)]*?(?:'([^']+)'|"([^"]+)")/g)) {
    listeners.push({ file: rel, host: m[1] ?? m[2] })
  }
  const hosts = new Set()
  for (const m of txt.matchAll(URL_RE)) hosts.add(hostOf(m[1]))
  if (rel.endsWith('pack.js')) for (const h of hosts) packHosts.add(h)
  if (rel.includes('vendor/channel-pack/src/')) for (const h of hosts) srcHosts.add(h)
}

const bundleOnly = [...packHosts].filter(h => !srcHosts.has(h) && !isNoise(h)).sort()
const srcOnly = [...srcHosts].filter(h => !packHosts.has(h) && !isNoise(h)).sort()

/* ── 联网：证书主体 ───────────────────────────────────────────────────── */

function probe(host, timeoutMs = 12_000) {
  return new Promise(resolveOut => {
    let done = false
    const finish = v => { if (!done) { done = true; try { socket?.destroy() } catch {} ; resolveOut(v) } }
    let socket
    try {
      socket = tlsConnect({ host, port: 443, servername: host, timeout: timeoutMs }, () => {
        const c = socket.getPeerCertificate() ?? {}
        const o = c.subject?.O ?? ''
        const cn = c.subject?.CN ?? ''
        const issuer = c.issuer?.O ?? c.issuer?.CN ?? ''
        finish({ ok: true, authorized: socket.authorized === true, subject: [o, cn].filter(Boolean).join(' | '), issuer })
      })
    } catch (error) {
      return finish({ ok: false, error: String(error?.message ?? error) })
    }
    socket.on('error', error => finish({ ok: false, error: String(error?.message ?? error) }))
    socket.on('timeout', () => finish({ ok: false, error: 'timeout' }))
  })
}

/* ── 输出 ─────────────────────────────────────────────────────────────── */

const table = [...perHost.entries()].sort((a, b) => b[1].count - a[1].count)
const authoritative = table.filter(([, e]) => !e.bare)

const report = {
  root: ROOT,
  hosts: table.map(([host, e]) => ({ host, count: e.count, bareOnly: e.bare, files: [...e.files] })),
  plainHttp: [...plainHttp.entries()].map(([host, e]) => ({ host, ...e })),
  listeners,
  bundleOnly,
  srcOnly,
}

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`# egress-audit  root=${ROOT}\n`)
  console.log(`## 1) 出网主机（${table.length} 个；带协议 ${authoritative.length} 个，其余为引号里的裸域名候选）\n`)
  console.log('     count  host                                       files')
  for (const [host, e] of table) {
    const files = [...e.files].slice(0, 3).join(', ')
    console.log(`  ${e.bare ? '~' : ' '} ${String(e.count).padStart(4)}  ${host.padEnd(42)} ${files}${e.files.size > 3 ? ' …' : ''}`)
  }
  console.log(`\n    （~ = 只以引号裸域名出现过，未在任何 URL 里确认；白名单 TLD：com/cn/net/org/io/dev/ai/bot/guru/app/cloud/sh）`)
  console.log(`\n## 2) 明文 http（非回环）\n`)
  if (plainHttp.size === 0) console.log('  （无）')
  for (const [host, e] of plainHttp) console.log(`  ${e.count}× ${host}  ${e.samples.join(' | ')}`)
  console.log(`\n## 3) listen(...) 的绑定地址\n`)
  for (const l of listeners) console.log(`  ${l.host.padEnd(12)} ${l.file}`)
  console.log(`\n## 4) 打包产物比可读源码多出来的主机（必须能解释）\n`)
  if (bundleOnly.length === 0) console.log('  （无）')
  for (const h of bundleOnly) console.log(`  ${h}`)
  console.log(`\n   源码有、产物无：${srcOnly.length ? srcOnly.join(', ') : '（无）'}`)
}

if (WITH_TLS) {
  const targets = table.map(([host]) => host)
  console.log(`\n## 5) TLS 握手：证书主体（${targets.length} 个主机，串行；证书主体＝流量终点）\n`)
  for (const host of targets) {
    let ip = '-'
    try { ip = (await lookup(host)).address } catch {}
    const r = await probe(host)
    const verdict = r.ok ? `${r.authorized ? 'valid' : 'NOT-VALIDATED'} ${r.subject} [issuer ${r.issuer}]` : `FAIL ${r.error}`
    console.log(`  ${host.padEnd(42)} ${ip.padEnd(18)} ${verdict}`)
  }
}
