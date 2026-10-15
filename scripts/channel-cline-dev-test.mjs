/**
 * Cline 的 models.dev 目录：条件请求、304 回退、超时与三态图片能力。
 *
 *     node --experimental-strip-types scripts/channel-cline-dev-test.mjs
 *
 * 四条各自锁一个**静默**缺陷（上游 issue IKKZUG）：
 *
 * 1. **不带 `Accept-Encoding`** ⇒ Node 原生 fetch 每次下 5.39 MB 明文，
 *    极易撞超时上限（实测成功那次只用 1.9 秒，失败的都是整段卡死）；
 * 2. **无 ETag/304** ⇒ 每次 TTL 到期都重下整份目录；
 * 3. **304 当成空目录** ⇒ 所有模型的图片能力一次性被打回纯文本（本模块最怕的形态）；
 * 4. **`supportsImage: false` 被写成字段缺席** ⇒ 从「确认不支持」变成「未知」。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const srcPath = new URL('../vendor/channel-pack/src/', import.meta.url).pathname
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href, shortCircuit: true }
    }
    if (specifier.startsWith('./') && context.parentURL?.includes('/vendor/channel-pack/src/')) {
      const candidate = `${srcPath}${specifier.slice(2).replace(/\.js$/, '.ts')}`
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const {
  CLINE_MODELS_DEV_TIMEOUT_MS,
  applyModelsDevCatalog,
  makeClineModelsDevLoader,
} = await import(new URL('../vendor/channel-pack/src/cline-models-dev.ts', import.meta.url).href)

// ── 1. 超时放宽 ──────────────────────────────────────────────────────────────
assert.equal(CLINE_MODELS_DEV_TIMEOUT_MS, 60_000,
  'models.dev 是 5.39 MB 的目标，超时必须放宽到 60s（20s 实测三次两次整段卡死）')
console.log('ok  超时 = 60s（20s 实测三次两次整段卡死）')

// ── 2. 条件请求：Accept-Encoding + If-None-Match ─────────────────────────────
{
  const seen = []
  const body = { providers: { 'cline-pass': { models: {
    'glm-5.3': { name: 'GLM 5.3', limit: { context: 200_000 }, modalities: { input: ['text'] } },
    'gpt-5': { name: 'GPT 5', limit: { context: 400_000 }, modalities: { input: ['text', 'image'] } },
  } } } }
  const fetcher = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers })
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json', etag: '"v1"' },
    })
  }
  const load = makeClineModelsDevLoader({ fetcher })
  const first = await load()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].headers['Accept-Encoding'], 'br, gzip',
    '必须显式声明 Accept-Encoding，否则 Node 原生 fetch 下解压后 5.39 MB 明文')
  assert.equal(seen[0].headers['If-None-Match'], undefined, '首次请求不该带 If-None-Match')
  assert.equal(first.size, 2, '两个模型都应解析出来')
  assert.equal(first.get('cline-pass/glm-5.3').supportsImage, false,
    'dev 明确说 false 时必须原样落 false（不能变成字段缺席=未知）')
  assert.equal(first.get('cline-pass/gpt-5').supportsImage, true)
  console.log('ok  请求头：Accept-Encoding: br, gzip；首次不带 If-None-Match；false 原样保留')
}

// ── 3. 304 回退成上次结果（TTL 到期后的第二轮） ───────────────────────────────
{
  const body = { providers: { 'cline-pass': { models: {
    'glm-5.3': { name: 'GLM 5.3', modalities: { input: ['text'] } },
  } } } }
  let calls = 0
  const seen = []
  const fetcher = async (url, init) => {
    calls += 1
    seen.push(init?.headers ?? {})
    if (calls === 1) {
      return new Response(JSON.stringify(body), { status: 200, headers: { etag: '"abc"' } })
    }
    return new Response(null, { status: 304 })
  }
  const load = makeClineModelsDevLoader({ fetcher, ttlMs: 1 })
  const first = await load()
  assert.equal(first.size, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await load()
  assert.equal(seen[1]['If-None-Match'], '"abc"', '第二轮必须带上第一轮拿到的 ETag')
  assert.equal(second.size, 1, '304 必须回退成上次的结果，绝不能当成空目录')
  assert.equal(second.get('cline-pass/glm-5.3').supportsImage, false,
    '304 回退的结果同样要保真 —— 打成空表就是「把没读到说成不支持」')
  console.log('ok  304：带上 ETag 且回退成上次结果（不是空目录）')
}

// ── 4. 304 但本地无回落 ⇒ 抛错（不许静默变空表） ─────────────────────────────
{
  const fetcher = async () => new Response(null, { status: 304 })
  const load = makeClineModelsDevLoader({ fetcher, ttlMs: 1 })
  await assert.rejects(() => load(), /304/,
    '没有上次结果却收到 304 时必须抛错，返回空表正是「把没读到说成不支持」')
  console.log('ok  304 无回落 ⇒ 抛错（不静默变空表）')
}

// ── 5. 三态：false 与 undefined 必须可区分（两个入口） ────────────────────────
{
  const dev = new Map([
    ['cline-pass/plain', { id: 'cline-pass/plain', supportsImage: false, contextWindow: 100 }],
    ['cline-pass/vision', { id: 'cline-pass/vision', supportsImage: true, contextWindow: 100 }],
  ])
  // 入口 ①「补缺」：目录里没有这两个 id，从 dev 追加。
  const added = applyModelsDevCatalog(
    [{ id: 'cline-free/x', name: 'x', isFree: true }],
    dev,
  )
  const plain = added.find((m) => m.id === 'cline-pass/plain')
  const vision = added.find((m) => m.id === 'cline-pass/vision')
  assert.equal('supportsImage' in plain, true,
    '入口①：dev 说 false 时字段必须**在**且为 false（缺席会被读成「未知」）')
  assert.equal(plain.supportsImage, false)
  assert.equal(vision.supportsImage, true)

  // 入口 ②「合并已有条目」：本地缺失时才采用 dev 的值，且必须原样（含 false）。
  const merged = applyModelsDevCatalog(
    [
      { id: 'cline-pass/plain', name: 'plain', isFree: false },
      { id: 'cline-pass/vision', name: 'vision', isFree: false },
      // 本地显式 false 必须赢（策展数据优先于社区目录）。
      { id: 'cline-pass/local-false', name: 'local', isFree: false, supportsImage: false },
    ],
    new Map([...dev, ['cline-pass/local-false', { id: 'cline-pass/local-false', supportsImage: true }]]),
  )
  const mPlain = merged.find((m) => m.id === 'cline-pass/plain')
  assert.equal(mPlain.supportsImage, false,
    '入口②：dev 说 false 时字段同样必须为 false（只修入口①会从此处漏回去）')
  const local = merged.find((m) => m.id === 'cline-pass/local-false')
  assert.equal(local.supportsImage, false, '本地显式 false 优先于 dev 的 true')
  console.log('ok  三态：两个入口的 false 都保真；本地显式 false 仍优先')
}

console.log('\nchannel-cline-dev: 全部通过')
