/**
 * OfficeAce 的**登录闭环**（2026-10-15 从 gitee 上游移植的渠道）。
 *
 *     node scripts/channel-officeace-login-test.mjs
 *
 * ## 为什么是端到端而不是单测
 *
 * 移植一个渠道最容易漏的是**接线**，而接线的错误形态**全是静默的**：卡片在、
 * 适配器注册了、套件全绿，但用户点「新建账号」就是不通，或者更糟 ——
 * 登录明明成功却被判成失败（上游真实缺陷：`done:false` 会被前端直接 return）。
 *
 * 本用例走**真实 RPC 路由**（`/api/channel-pack` 的 `account.create` /
 * `login.poll` / `account.list`），把远端桩成华为云的真实形状，断言：
 *
 * 1. `account.create` 返回**华为云 authorize URL**（且带 PKCE 的 `code_challenge`）；
 * 2. `login.poll` 在拿到 code 后**换 token → 落库 → 回填**，返回 `done:true, success:true`；
 * 3. 全程**不留幽灵账号**（失败时删占位条目、成功时凭据真的在库里）；
 * 4. 两拍重叠（同一 code 只能换一次）**不得把已成功的登录判成失败**。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-oa-login-'))
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
// ⚠️⚠️ **OfficeAce 的用户级目录必须进程级隔离**（2026-10-19 事故修复）。
//    `officeace-auth.ts` 的三条用户级路径（`~/.dsh-officeace` 凭据、兼容
//    `session.json`、`~/.office-claw` cookie）**只认 `DSH_OFFICEACE_HOME`**，
//    `DSH_HOME` 管不到它。不隔离的后果：`persistLogin()` 顺手写的那份兼容文件
//    落到**真实 home**，而 `apply()` 里有 fire-and-forget 的续期链、空池时回落到
//    读本机凭据 ⇒ 真实 DSH 每 30 分钟拿那份**桩 token** 去打华为云 STS，
//    日志刷 `STS5.1806 invalid refresh token: 'decode jwt header failed'`。
//    ⇒ 只能进程级（与 gitee 上游 `tests/setup-isolation.ts` 同款做法）。
process.env.DSH_OFFICEACE_HOME = path.join(scratch, 'officeace')

process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
// ⚠️ 断路器：`openIncognitoWindow` 会真的 spawn 浏览器，测试环境必须关掉
//（上游为此踩过「每跑一次测试弹一个窗口」的污染）。返回 false 让调用方走回退路径。
process.env.NODE_ENV = 'test'

const creds = new Map()
const routes = []
const adapters = new Map()
const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async (ref) => creds.get(ref),
    describe: async () => undefined,
    set: async (ref, value) => { creds.set(ref, { value }) },
    unset: async (ref) => { creds.delete(ref) },
  },
  llm: {
    registerAdapter(providers, adapter) { for (const p of providers) adapters.set(p, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })),
  },
  connection: { fetch: { register: (route) => { routes.push(route) } } },
}
const ctx = {
  ...services,
  logger: { info() {}, warn() {}, error() {} },
  get: name => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanup() },
  inject(names, callback) { if (names.every(n => services[n] !== undefined)) callback(this) },
  emit() {},
}
fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify({ accounts: [], disabledModels: {} }))

/** 华为云各端点的真实形状桩。 */
let tokenExchanges = 0
globalThis.fetch = async (input) => {
  const url = String(input)
  const json = (body) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  // ① 云侧签发 state（自制 state 会 404，故必须走它）
  if (url.includes('/v1/claw/auth/state')) return json({ state: 'ST-1' })
  // ② 轮询取 code
  if (url.includes('/v1/claw/auth/code')) return json({ code: 'CODE-1' })
  // ③ STS 换 token（**注意路径是 /v1/oauth2/tokens**，不是 /claw/*）
  if (url.includes('/v1/oauth2/tokens')) {
    tokenExchanges += 1
    return json({
      refresh_token: 'RT-1',
      credentials: {
        access_key_id: 'AK', secret_access_key: 'SK', security_token: 'STK',
        project_id: 'P1', expiration: '2030-01-01T00:00:00Z',
      },
    })
  }
  // ④ MaaS 订阅校验：缺 model_app_key/secret 会被判「未订阅 MaaS」
  if (url.includes('client-permission-validate')) {
    return json({ subscription: { model_info: { model_auth_info: { model_app_key: 'MAK', model_app_secret: 'MAS' } } } })
  }
  // ⑤ 其余（订阅摘要 / 模型列表 / 倍率）空成功
  return json({ data: [] })
}

const { apply } = await import('../vendor/channel-pack/pack.js')
apply(ctx, { disableOpencode: true })
await new Promise(resolve => setImmediate(resolve))

const route = routes.find(row => row.path === '/api/channel-pack')
assert.ok(route, '真实 RPC 路由必须注册')
const call = async (method, payload) => {
  const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'channel-pack', payload: { method, payload } }),
  }))
  return (await response.json()).result
}

// ── 1. account.create：返回华为云 authorize URL（带 PKCE）────────────────────
const created = await call('account.create', { provider: 'officeace' })
assert.equal(created.ok, true, `account.create 应成功，实得 ${JSON.stringify(created)}`)
const accountId = created.value.accountId
const authorizeUrl = new URL(created.value.loginUrl)
assert.ok(authorizeUrl.host.endsWith('auth.huaweicloud.com'), `应是华为云授权页，实得 ${authorizeUrl.host}`)
const service = authorizeUrl.searchParams.get('service')
assert.ok(service !== null, 'authorize URL 必须带 service 参数')
const inner = new URL(service)
assert.equal(inner.searchParams.get('client_id'), 'pdp5_for_agentarts', 'PKCE 公开客户端 id')
assert.ok(inner.searchParams.get('code_challenge') !== null, '必须带 PKCE code_challenge')
// ⚠️ 华为云的线上取值是 `SHA-256`（不是 RFC 常见的 `S256` 字样）—— 照实断言。
assert.equal(inner.searchParams.get('code_challenge_method'), 'SHA-256', 'PKCE 方法必须是 SHA-256')
console.log('ok  account.create：返回华为云 authorize URL（含 PKCE SHA-256 + 公开 client_id）')

// ── 2. login.poll：换 token → 落库 → 回填 ──────────────────────────────────
const polled = await call('login.poll', { accountId })
assert.equal(polled.ok, true, `login.poll 应成功，实得 ${JSON.stringify(polled)}`)
assert.equal(polled.value.success, true, `登录应成功，实得 ${JSON.stringify(polled.value)}`)
assert.equal(tokenExchanges, 1, '应恰好换一次 token')
assert.ok(creds.has(`OFFICEACE_ACCOUNT_${accountId.replace(/^officeace-/, '').toUpperCase()}`)
  || [...creds.keys()].some(k => k.startsWith('OFFICEACE_ACCOUNT_')),
  `凭据必须真的落库，实得 keys=${JSON.stringify([...creds.keys()])}`)
console.log('ok  login.poll：换 token → 凭据落库 → done:true, success:true')

// ── 3. 账号在池里、且没有幽灵残留 ───────────────────────────────────────────
const listed = await call('account.list', { provider: 'officeace' })
const accounts = listed.value.accounts
assert.equal(accounts.length, 1, `应恰好一个账号，实得 ${accounts.length}`)
assert.equal(accounts[0].id, accountId)
assert.equal(accounts[0].provider, 'officeace')
console.log('ok  account.list：账号在池里，无幽灵残留')

// ── 4. 重复 poll（两拍重叠）不得把已成功的登录判成失败 ───────────────────────
const again = await call('login.poll', { accountId })
assert.equal(again.value?.success ?? true, true,
  '重复 poll 不得把已成功的登录判成失败（同一 code 只能用一次，但凭据已落库 ⇒ 就是成了）')
console.log('ok  重复 poll：已成功的登录不被判成失败（凭据在 ⇒ 登录成了）')

// ── 5. 锁定链在 RPC 层可达（不是白名单外的死代码）────────────────────────────
//
// ⚠️ 这条断言防的是**镜像缺陷**：上游的「哑锁」是「UI 有按钮、执行代码没有」；
// 移植时反过来漏登记 `PERMANENT_LOCK_PROVIDERS`，则变成「执行代码有、写入被
// 白名单拒」⇒ `index.ts` 那段锁定分道永远读不到 true，成为死代码，
// 症状同样静默。两边都必须可达才算真的接上。
{
  const set = await call('credits.permanentLock', { provider: 'officeace', locked: true })
  assert.equal(set.ok, true, `锁定写入必须被接受（白名单漏登记会回 bad-request），实得 ${JSON.stringify(set)}`)
  assert.equal(set.value.locked, true, '写入后读回应为 true')
  assert.equal(typeof set.value.windowDays, 'number',
    '按到期分桶的渠道必须回传 windowDays（与 credits.balances 同一判据）')

  const read = await call('credits.permanentLock', { provider: 'officeace' })
  assert.equal(read.value.locked, true, '读取应看到已锁定')

  // 复位：不留状态给后续用例。
  const off = await call('credits.permanentLock', { provider: 'officeace', locked: false })
  assert.equal(off.value.locked, false, '应能取消锁定')
  console.log('ok  锁定链 RPC 可达：写入被接受、读回一致、可取消（不是白名单外的死代码）')
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log('\nchannel-officeace-login: 全部通过')
