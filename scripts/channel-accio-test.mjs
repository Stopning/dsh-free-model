/**
 * Accio 渠道（2026-10-15 从 gitee 上游移植）的登录闭环与凭据生命周期。
 *
 *     node scripts/channel-accio-test.mjs
 *
 * ## 为什么走端到端而不是单测
 *
 * 移植 OfficeAce 那轮，端到端跑真实 RPC 抓出了**两个静态检查看不见的缺陷**
 * （`persistLogin` 签名不匹配、辅助函数落在别的 case 里导致 TDZ 死代码）。
 * Accio 是同一种活（多文件移植 + 手写接线），所以照同一标准验。
 *
 * 断言的是**行为**，不是源码文本：
 * 1. `account.create` 返回 Accio 授权页 URL，且带 PKCE（公开客户端、无 secret）；
 * 2. 回调打到本地服务器 → `login.poll` 换 token → 凭据按**账号 ref** 落库
 *    （不是默认单凭据 ref —— 那是本仓库反复复发的「登录成功、一发消息就报未配置」）；
 * 3. 账号条目被回填（`refreshable` / `expiresAt`），不留幽灵账号；
 * 4. **自动续期覆盖到 accio**：`refreshTargets` 漏一家 = 定时器不武装它，
 *    凭据到期后不自动续期且**日志零输出**（gemini 那行注释专门记过这课）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-accio-'))
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

const creds = new Map()
const dispose = []
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
  // ⚠️ 清理函数必须**收集**、不能立即调用（与 `channel-pack-test.mjs` 同款）。
  // 立即调用等于「挂载后马上卸载」：出网服务已 close ⇒ 换 token 全抛
  //「渠道出网服务已停止」，症状与「Accio 换不成 token」完全同形（本轮真实踩过）。
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') dispose.push(cleanup) },
  inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
  emit() {},
}
fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify({ accounts: [], disabledModels: {} }))

/** 记录换 token 打了哪个 URL（断言凭据交换确实发生、且打到 gateway）。 */
const tokenCalls = []
const savedFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('/api/oauth/token')) {
    tokenCalls.push(url)
    return new Response(JSON.stringify({
      success: true,
      data: {
        access_token: 'ACC-AT', refresh_token: 'ACC-RT', expires_in: 7200,
        token_type: 'Bearer', scope: 'user', user_id: 'ACC-USER-1',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.includes('/api/auth/refresh_token')) {
    return new Response(JSON.stringify({
      success: true,
      data: { access_token: 'ACC-AT2', refresh_token: 'ACC-RT2', expires_in: 7200 },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  // 其余（模型目录 / userinfo / 额度）空成功：不是本用例的考点。
  return new Response(JSON.stringify({ success: true, data: {} }),
    { status: 200, headers: { 'content-type': 'application/json' } })
}

const {
  ACCIO_SUBSCRIPTION_PATH, ACCIO_QUOTA_PATH, ACCIO_USERINFO_PATH,
} = await import('../vendor/channel-pack/src/accio-product.ts')
const json = (data) => new Response(JSON.stringify({ success: true, data }),
  { status: 200, headers: { 'content-type': 'application/json' } })

const { apply } = await import('../vendor/channel-pack/pack.js')
apply(ctx, { disableOpencode: true })
await new Promise(resolve => setImmediate(resolve))
globalThis.fetch = savedFetch

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

// ── 1. account.create：Accio 授权页 + PKCE ───────────────────────────────────
const created = await call('account.create', { provider: 'accio' })
assert.equal(created.ok, true, `account.create 应成功，实得 ${JSON.stringify(created)}`)
const accountId = created.value.accountId
const authorize = new URL(created.value.loginUrl)
assert.ok(/accio/.test(authorize.host), `应是 Accio 授权页，实得 ${authorize.host}`)
assert.equal(authorize.searchParams.get('client_id'), 'accio-work', '公开客户端 id')
assert.ok(authorize.searchParams.get('code_challenge') !== null, '必须带 PKCE code_challenge')
// ⚠️ 各家参数名**不同**，不能照搬别家：华为用 `redirect_uri` + `SHA-256`，
// Accio 用 **`return_url`** + 标准 **`S256`**（见 `accio-oauth.ts` 的 buildAccioAuthUrl）。
assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256',
  'Accio 的 PKCE 方法是标准 S256（与华为的 SHA-256 不同，别照搬）')
// ⚠️ 公开客户端 ⇒ **绝不该**出现 client_secret。
assert.equal(authorize.searchParams.get('client_secret'), null, '公开客户端不得带 secret')
const callbackUrl = authorize.searchParams.get('return_url')
assert.ok(callbackUrl?.startsWith('http://127.0.0.1'),
  `回调必须落本机 loopback（Accio 的参数名是 return_url），实得 ${String(callbackUrl)}`)
console.log('ok  account.create：Accio 授权页 + PKCE（公开客户端、无 secret、loopback 回调）')

// ── 2. 回调 → 换 token → 凭据按账号 ref 落库 ────────────────────────────────
{
  const redirectUri = new URL(callbackUrl)
  redirectUri.searchParams.set('state', authorize.searchParams.get('state'))
  redirectUri.searchParams.set('code', 'ACC-CODE-1')
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes('/api/oauth/token')) {
      tokenCalls.push(url)
      return new Response(JSON.stringify({
        success: true,
        // ⚠️ Accio 的兑换响应是 **camelCase**，且 `expiresAt` 是**绝对时刻**
        //（秒或毫秒，由 `accioExpiresAtMs` 按 1e12 归一）—— 不是别家常见的
        // `access_token` + `expires_in` 时长。写错形状会让登录被判失败。
        data: {
          accessToken: 'ACC-AT', refreshToken: 'ACC-RT',
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
          tokenType: 'Bearer', scope: 'user', userId: 'ACC-USER-1',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.includes('/api/auth/refresh_token')) {
      return new Response(JSON.stringify({
        success: true, data: { access_token: 'ACC-AT2', refresh_token: 'ACC-RT2', expires_in: 7200 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ success: true, data: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const callback = await savedFetch(redirectUri)
  assert.equal(callback.status, 200, '回调页应正常应答')
  // 等后台把 code 换完（回调服务器落定是异步的）。
  for (let i = 0; i < 40 && tokenCalls.length === 0; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(tokenCalls.length > 0, '必须真的去打 gateway 换 token')
  assert.ok(tokenCalls[0].includes('/api/oauth/token'), `换 token 端点不对：${tokenCalls[0]}`)

  const polled = await call('login.poll', { accountId })
  assert.equal(polled.ok, true, `login.poll 应成功，实得 ${JSON.stringify(polled)}`)
  // 凭据已落库 ⇒ 轮询应判成 done/success（或至少不再报失败）。
  assert.notEqual(polled.value?.success, false,
    `登录不该被判成失败，实得 ${JSON.stringify(polled.value)}`)
  const accioKeys = [...creds.keys()].filter(k => k.startsWith('ACCIO_ACCOUNT_'))
  assert.ok(accioKeys.length > 0,
    `凭据必须按**账号 ref**（ACCIO_ACCOUNT_XXX）落库，实得 keys=${JSON.stringify([...creds.keys()])}`)
  const stored = JSON.parse(creds.get(accioKeys[0]).value)
  assert.equal(stored.access_token, 'ACC-AT', '落库的应是换到的凭据')
  console.log('ok  回调 → 换 token → 凭据按账号 ref 落库（不是默认单凭据 ref）')
}

// ── 3. 账号条目在池里、被回填、无幽灵 ────────────────────────────────────────
{
  const listed = await call('account.list', { provider: 'accio' })
  const accounts = listed.value.accounts
  assert.equal(accounts.length, 1, `应恰好一个账号，实得 ${accounts.length}`)
  assert.equal(accounts[0].id, accountId)
  assert.equal(accounts[0].provider, 'accio')
  // 上游换 token 的响应**不含身份字段**，故昵称回落为账号 id（如实，不臆造）。
  assert.ok(typeof accounts[0].nickname === 'string' && accounts[0].nickname.length > 0)
  console.log('ok  account.list：账号在池里、无幽灵残留')
}

// ── 4. 余额查询把 `extra.accountTier` 与 `error` 如实传播 ───────────────────
//
// ⚠️ 这条是**比对上游才发现的缺陷**：第一版分支只回 `balance` + `error`，
// 把 `fetchAccioBalanceDetailed` 已经带回来的账号档位（Free / Pro / Ultra）
// **静默丢掉** ⇒ 面板少一栏本可显示的信息。上游的 gemini / officeace 都传播
// `extra`，本 fork 的既有约定也是 `...extra === undefined ? {} : { extra }`。
{
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes(ACCIO_SUBSCRIPTION_PATH)) {
      // 桶形状：`entitlement.<key>.{remaining,total,used}`（见 accio-credits 的
      // `accioCreditBuckets`）。给两个桶，顺带盯住「只取 buckets[0]」那类旧缺陷。
      return json({ entitlement: {
        monthly: { remaining: 900, total: 1000, used: 100 },
        daily: { remaining: 40, total: 50, used: 10 },
      }, remaining: 940 })
    }
    if (url.includes(ACCIO_QUOTA_PATH)) {
      return json({ dailyResetSeconds: 3600 })
    }
    if (url.includes(ACCIO_USERINFO_PATH)) {
      return json({ userLevel: 'freemember', userId: 'ACC-USER-1' })
    }
    return json({})
  }
  const balances = await call('credits.balances', { provider: 'accio' })
  assert.equal(balances.ok, true, `credits.balances 应成功，实得 ${JSON.stringify(balances).slice(0, 200)}`)
  const row = balances.value.accounts[0]
  assert.ok(row !== undefined, '应有一个账号的余额行')
  // 档位取不到时整行不渲染（不是错误）；取到了就必须出现 —— 两种都要能表达。
  if (row.balance !== null) {
    assert.ok(row.extra?.accountTier !== undefined,
      `余额带档位时必须传播 extra.accountTier（第一版把它丢了），实得 ${JSON.stringify(row)}`)
    assert.equal(row.extra.accountTier.label, 'Free', 'freemember 的短标签是 Free')
    console.log('ok  credits.balances：extra.accountTier 如实传播（档位不被静默丢掉）')
  } else {
    // 查不到余额时也必须带可读 error，而不是显示成 0 / 空白。
    assert.ok(typeof row.error === 'string' && row.error.length > 0,
      `余额为 null 时必须带可读 error，实得 ${JSON.stringify(row)}`)
    console.log('ok  credits.balances：查不到时带可读 error（不显示成 0）')
  }
}

// ── 5. 自动续期覆盖到 accio（漏了是静默失效）────────────────────────────────
{
  const index = fs.readFileSync(
    new URL('../vendor/channel-pack/src/index.ts', import.meta.url), 'utf8')
  const start = index.indexOf('const refreshTargets')
  assert.ok(start >= 0, 'refreshTargets 必须存在')
  // ⚠️ 切片要取到**表结束的 `\n  ]`**，不能取第一个 `]` —— 类型标注
  // `ReadonlyArray<readonly [string, …]>` 里就有个 `]`，取第一个会截断到声明行，
  // 于是所有表项都在切片之外（本用例第一版就是这么假失败的）。
  const end = index.indexOf('\n  ]', start)
  assert.ok(end > start, 'refreshTargets 表结尾未找到')
  const list = index.slice(start, end)
  for (const provider of ['accio', 'officeace']) {
    // 只认**表项**（`['accio', (p) =>`），不认注释里出现的词 —— 注释提到不等于接上了。
    assert.match(list, new RegExp(`\\['${provider}',\\s*\\(p\\)\\s*=>`),
      `${provider} 必须在 refreshTargets 里（漏了 = 定时器不武装它，凭据到期不自动续期且零日志）`)
  }
  console.log('ok  自动续期表覆盖 accio 与 officeace（漏一项 = 静默不续期）')
}

for (const cleanup of dispose) { try { cleanup() } catch { /* dispose is best effort */ } }
globalThis.fetch = savedFetch
fs.rmSync(scratch, { recursive: true, force: true })
console.log('\nchannel-accio: 全部通过')
