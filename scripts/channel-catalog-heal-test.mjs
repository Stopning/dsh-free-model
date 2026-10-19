/**
 * Tier 2 **行为**验证：残缺目录能否自愈（上游 issue IKJVTF 的核心缺陷）。
 *
 *     node scripts/channel-catalog-heal-test.mjs
 *
 * ## 为什么必须行为级
 *
 * 本 issue 最隐蔽的一层是「只把 `complete` 传对是**没用的**」—— 残缺目录**也**
 * 赋值了 `remoteModels`，若短路判据仍是「已定义」，闸门的 `cooling()` 永远读不到，
 * 预热重试全被短路挡回 ⇒ 只能重启 DSH。故这里**真装配**适配器，让远端先残缺、
 * 后完整，断言第二次真的补上了。
 *
 * ## 为什么走真实 `pack.js`
 *
 * 与 `channel-pack-test.mjs` 同一口径：mount 实际发布的产物。这样本用例
 * **不依赖 esbuild**（不必为了跑测试装构建依赖），且验的是真正会被加载的代码。
 * 远端由 `globalThis.fetch` 的替身提供，两个端点各自可控。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-catalog-heal-'))
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
process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'machine-token.json')
process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime-info.exe')

// 一个已登录的 buddy 账号，让目录路径可达（否则适配器走静态兜底）。
const buddyCredential = JSON.stringify({ access_token: 'fixture-token', refresh_token: 'fixture-refresh' })
const adapters = new Map()
const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async (ref) => (ref === 'BUDDY_ACCOUNT_ONE' ? { value: buddyCredential } : undefined),
    describe: async () => undefined,
    set: async () => {},
    unset: async () => {},
  },
  llm: {
    registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })),
  },
  connection: { fetch: { register() {} } },
}
const ctx = {
  ...services,
  logger: { info() {}, warn() {}, error() {} },
  get: name => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') cleanup() },
  inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
  emit() {},
}
fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify({
  accounts: [{
    id: 'buddy-one', provider: 'buddy', nickname: 'Buddy fixture',
    credentialRef: 'BUDDY_ACCOUNT_ONE', enabled: true, refreshable: true, createdAt: 1,
  }],
  disabledModels: {},
}))

/**
 * 远端替身：`configOk` 控制 `/v3/config` 的成败，`/console/enterprises/...`（scoped）
 * 恒成功。两个 id 都必须在 CODEBUDDY 兜底表内 —— `reconcileWithFallback` 会丢弃
 * 表外未知 id（那是「服务端按认证上下文下发残缺集合」的保护）。
 */
const configOk = { value: true }
const model = (id) => ({ id, name: id, maxInputTokens: 200_000, supportsImages: true, creditsRate: 'x0' })
let fetchCalls = 0
const savedFetch = globalThis.fetch
globalThis.fetch = async (input) => {
  const url = String(input)
  fetchCalls += 1
    // ⚠️ 形状要真实：模型 id 由 `agents[].models` 承载，`data.models` 只是元数据表。
  // scoped 端点用 agent 名 `cli`，`/v3/config` 用 `craft`（见 parseModelsFromConfig）。
  if (url.includes('/console/enterprises/')) {
    return new Response(JSON.stringify({
      data: {
        models: [model('hy4-preview')],
        agents: [{ name: 'cli', models: ['hy4-preview'] }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (url.includes('/v3/config')) {
    if (!configOk.value) return new Response('boom', { status: 500 })
    // 只由 config 下发的模型：用一个**不在** scoped 响应里的 id，且它必须在
    // CODEBUDDY 兜底表内（`reconcileWithFallback` 是白名单式重建）。
    return new Response(JSON.stringify({
      data: {
        models: [model('hy4-preview'), model('glm-5.3-flash')],
        agents: [{ name: 'craft', models: ['hy4-preview', 'glm-5.3-flash'] }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  // 其余端点（促销、用量等）一律空成功 —— 它们不是本用例的考点。
  return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
}

// ⚠️ 可控时钟必须**在 mount 之前**装好：`RemoteCatalogGate` 在构造时就把
// `Date.now` 存成字段（`options.now ?? Date.now`），之后再改 `Date.now` 不影响
// 它已捕获的引用。生产里这段等待由 `catalog-prewarm` 的补拉轮次完成。
let clock = Date.now()
const realDateNow = Date.now
Date.now = () => clock

const { apply } = await import('../vendor/channel-pack/pack.js')
apply(ctx, { disableOpencode: true })
await new Promise(resolve => setImmediate(resolve))
// ⚠️ **不要**还原 `globalThis.fetch`：适配器在每次请求时读全局 `fetch`
//（`BuddyAuth` 的 `fetchImpl` getter），还原就等于把后续请求放回真实网络。
// 另外 `apply()` 会经 `catalog-prewarm` 排一轮 microtask 预热，本替身同时兜住它。

const buddy = adapters.get('buddy')
assert.ok(buddy, 'buddy adapter must be registered')

// 阶段 1：scoped 成功、config 失败 ⇒ 残缺（目录已落地，但不得永久缓存）。
configOk.value = false
const first = await buddy.listModels('buddy')
assert.ok(first.some((m) => m.id === 'hy4-preview'),
  '残缺目录也要展示（不能因为不完整就什么都不给）')

// 阶段 2：两个端点都成功，且**冷却已到期** ⇒ 必须再拉一次并补齐。
// ⚠️ 这是本用例的核心：修复前短路判据是 `remoteModels !== undefined`，残缺目录
// 已经赋值 ⇒ 直接返回，`hy3` 永远出不来（用户只能重启 DSH）。
// ⚠️ 冷却期内不重拉是**刻意的防抖**（不是缺陷），故这里把时钟推过 30s 冷却窗口。
configOk.value = true
clock += 31_000
const callsBefore = fetchCalls
const healed = await buddy.listModels('buddy')
assert.ok(fetchCalls > callsBefore, '冷却到期后，残缺目录不得短路：必须真的重拉远端')
assert.ok(healed.some((m) => m.id === 'glm-5.3-flash'),
  '补齐后必须出现第二个来源才有的模型（修复前这里是永久缺失）')

// 阶段 3：已完整 ⇒ 永久缓存生效，不得再打远端。
const settled = fetchCalls
clock += 31_000
await buddy.listModels('buddy')
assert.equal(fetchCalls, settled, '已完整后不得再拉远端（永久缓存生效）')
Date.now = realDateNow
console.log('ok  buddy：残缺目录可自愈（重拉补齐），完整后才永久缓存')

fs.rmSync(scratch, { recursive: true, force: true })
console.log('\nchannel-catalog-heal: 全部通过')
