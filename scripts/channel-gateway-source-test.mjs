/**
 * 网关自造消息的 **source kind** 必须符合装着的 `dsh-llm` 契约。
 *
 *     node scripts/channel-gateway-source-test.mjs
 *
 * ## 为什么要这个用例
 *
 * `dsh-llm` 0.2 删掉了共享的 `plugin` 包装（原文：「no shared catch-all
 * `plugin` kind」），改为**每个生产者在自己模块里声明 kind**（`declare module`
 * 增强 `MessageSourceMap`）。旧写法 `{ kind: 'plugin', plugin: 'dsh-openai-gateway' }`
 * 落在那个已删的联合之外 —— 类型层面已经错了，而**运行时不会报错**，
 * 所以只有专门测它才看得见。
 *
 * ⚠️ 本 fork 的两条上游给了**两种**写法：fork 父仓库用带前缀的
 * `'plugin:dsh-openai-gateway'`，gitee 上游用**裸 kebab-case + 模块增强**。
 * 本用例断言后者，依据是装着的 `dsh-llm`（0.2.1-alpha.2；alpha.3 与回溯到
 * 0.1.7-rc.2 同形）：全仓约 20 处 `MessageSourceMap` 增强一律裸 kebab-case
 * （`plan-mode` / `goal` / `compact-checkpoint` …），**没有任何 `plugin:` 前缀先例**。
 *
 * ## 真链路
 *
 * mount 真实 `pack.js` → 网关真起在回环端口 → 用真实 HTTP POST 发一条带
 * `system` 的 chat 请求 → 从 **llm 替身的 `stream()` 入参**里读出网关合成的
 * 消息，逐条检查 `source.kind` 是否落在已注册的 kind 集合内。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-gw-source-'))
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '1'
// 固定密钥 + 端口（避免生成文件、避免撞已占用端口）。
// 夹具值：env 路径只要求非空（不校验形态），故刻意用**明显是假数据**的短值 ——
// 上一版凑成 43 字符正撞上网关密钥形态，被 `git-secret-scan` 当成真凭据拦下。
const API_KEY = 'not-a-real-key'
process.env.DSH_OPENAI_GATEWAY_API_KEY = API_KEY
const PORT = 18937
process.env.DSH_OPENAI_GATEWAY_PORT = String(PORT)
process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'machine-token.json')
process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime-info.exe')

/** `stream()` 收到的 GenerateOptions —— 网关合成的消息就在这里。 */
const captured = []
const dispose = []
const adapters = new Map()
const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async () => undefined, describe: async () => undefined,
    set: async () => {}, unset: async () => {},
  },
  llm: {
    registerAdapter(providers, adapter) { for (const p of providers) adapters.set(p, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })),
    listModels: async (provider) => adapters.get(provider)?.listModels(provider) ?? [],
    resolveModelInfo: async (provider, model) => adapters.get(provider)?.resolveModel(provider, model) ?? {},
    stream: (options) => {
      captured.push(options)
      return (async function* () {
        yield { type: 'text-delta', text: 'ok' }
      })()
    },
  },
  connection: { fetch: { register() {} } },
}
const ctx = {
  ...services,
  logger: { info() {}, warn() {}, error() {} },
  get: name => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  // ⚠️ 清理函数必须**收集起来**、而不是立刻调用（与 `channel-pack-test.mjs` 同款）。
  // 立即调用等于「挂载后马上卸载」—— 网关会打印「已关闭」并且不监听端口。
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') dispose.push(cleanup) },
  inject(names, callback) { if (names.every(n => services[n] !== undefined)) callback(this) },
  emit() {},
}
fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify({ accounts: [], disabledModels: {} }))

// ⚠️ 保存真 fetch 再替换：本地那次 POST 必须走**真** HTTP（网关就在回环上），
// 而渠道包的出网必须被挡住。用同一个全局变量会把自己也挡住。
const realFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('external network is disabled in this suite') }

const { apply } = await import('../vendor/channel-pack/pack.js')
apply(ctx, { disableOpencode: true })
// 网关是异步收敛启动的（`void applyGatewayDesiredState()`）—— 等它听完端口。
await new Promise(resolve => setTimeout(resolve, 600))

// 一个已登录的 codearts 账号，让路由通过「有可用 provider」这一关。
// （网关自己不做账号校验，但 `stream` 前的 resolveModelInfo 会读到我们的替身。）

/** 已注册的 kind 集合：`dsh-llm` 内建 + 项目里各生产者的增强，全部裸 kebab-case。 */
const KNOWN_BARE_KINDS = new Set([
  'user', 'model', 'tool', 'system-prompt',
  'openai-gateway',
])

let posted = false
try {
  const response = await realFetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: 'codearts/deepseek-v4.1-flash',
      stream: false,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hello' },
      ],
    }),
    signal: AbortSignal.timeout(5_000),
  })
  posted = true
  // ⚠️ 不要求 200：上游被本用例的 fetch 替身挡住，网关会如实回 502/4xx。
  // 本用例要的是「消息已经过网关合成」这件事，它发生在调用上游**之前**。
  assert.ok([200, 400, 401, 502].includes(response.status),
    `网关应给出明确状态码，实得 ${response.status}`)
} catch (error) {
  // 端口没起来就说明挂载路径没走到网关 —— 明确失败，不要静默通过。
  assert.fail(`网关未能在 127.0.0.1:${PORT} 响应：${error?.message ?? error}`)
}

assert.equal(posted, true)
assert.ok(captured.length > 0,
  '网关应把请求交给 llm.stream()；没拿到 GenerateOptions 说明链路没通，本用例失去意义')

// 逐条检查网关合成消息的 source.kind。
const sources = captured.flatMap((options) => (options.messages ?? []).map((m) => m.source))
assert.ok(sources.length > 0, 'stream() 入参里应有消息')
for (const source of sources) {
  const kind = source?.kind
  assert.ok(typeof kind === 'string' && kind.length > 0, `每条消息都必须有 source.kind，实得 ${JSON.stringify(source)}`)
  assert.equal(kind.startsWith('plugin:'), false,
    `kind 不得带 plugin: 前缀（dsh-llm 0.2 已删除共享 plugin 包装，全仓增强一律裸 kebab-case），实得 ${kind}`)
  assert.ok(KNOWN_BARE_KINDS.has(kind),
    `kind "${kind}" 不在已注册的集合内（${[...KNOWN_BARE_KINDS].join(', ')}）`)
}
// 网关自造的 system 消息必须署名 openai-gateway（而非 user/model）。
const gatewaySystem = sources.filter((s) => s.kind === 'openai-gateway')
assert.ok(gatewaySystem.length > 0,
  '网关合成的 system 消息应署名 openai-gateway（旧写法 kind:"plugin" 会落在这里之外）')
console.log(`ok  网关 ${sources.length} 条合成消息的 source.kind 全部为裸 kebab-case，且含 openai-gateway`)

// 关掉网关（它是个真 HTTP server，会一直占着事件循环）并清理。
for (const cleanup of dispose) { try { cleanup() } catch { /* dispose is best effort */ } }
fs.rmSync(scratch, { recursive: true, force: true })
console.log('\nchannel-gateway-source: 全部通过')
// ⚠️ 网关的 server 未 unref，显式退出以免用例挂住（挂住会让 runner 误判为超时）。
process.exit(0)
