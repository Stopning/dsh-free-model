/**
 * 目录完整性、广播与预热的回归钉子（上游 issue IKJVTF）。
 *
 *     node --experimental-strip-types scripts/channel-catalog-test.mjs
 *
 * 直接读 `vendor/channel-pack/src/*.ts`（Node 的类型剥离 + 一个把 `./x.js`
 * 映射到 `x.ts` 的解析钩子）。**不读 `pack.js`**：这些模块的语义在打包产物里
 * 被内联、名字被压缩，断言文本会假红假绿。
 *
 * 三条锁的都是**静默**缺陷 —— 没有任何报错，用户只看到「模型少了」或
 * 「重启后才正常」：
 *
 * 1. **广播**：远端目录落地后必须通知宿主（`llm/adapters-updated`）。
 *    客户端把 catalog 缓存在 `status === 'ready'` 的短路 store 里，不广播就
 *    永远停在**兜底表**上（设置页实时、对话框陈旧 —— 两边分叉）。
 * 2. **完整性**：只有**所有来源都拿全**才算「已完整」，据此决定要不要永久缓存。
 *    残缺目录若被永久缓存（短路命中），此后连预热重试都进不去 ⇒ 只能重启。
 * 3. **预热**：间隔必须大于闸门冷却，且必须**链式**排程（上一轮结束再排下一轮）。
 *    固定排程会被冷却原样挡回（等于没预热），而症状同样是「静默无效」。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// 把 `./x.js` 解析到同目录的 `x.ts`（esbuild 平时替我们做的事）。
const srcDir = new URL('../vendor/channel-pack/src/', import.meta.url)
const srcPath = srcDir.pathname
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('./') && context.parentURL?.includes('/vendor/channel-pack/src/')) {
      const candidate = `${srcPath}${specifier.slice(2).replace(/\.js$/, '.ts')}`
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true, format: 'module-typescript' }
      }
    }
    return nextResolve(specifier, context)
  },
})

const {
  CATALOG_PREWARM_DELAYS_MS,
  isPrewarmSpacingValid,
  startCatalogPrewarm,
} = await import(new URL('../vendor/channel-pack/src/catalog-prewarm.ts', import.meta.url).href)
const {
  RemoteCatalogGate,
  REMOTE_CATALOG_COOLDOWN_MS,
} = await import(new URL('../vendor/channel-pack/src/remote-catalog-gate.ts', import.meta.url).href)

// ── 1. 闸门：广播时机、got/complete 分离 ──────────────────────────────────────
{
  let loaded = 0
  const gate = new RemoteCatalogGate({ onLoaded: () => { loaded += 1 } })
  // 残缺：got=true（要展示 + 要广播），complete=false（不得永久缓存）。
  await gate.run(async () => ({ got: true, complete: false }))
  assert.equal(loaded, 1, '拿到非空目录（哪怕残缺）就必须广播')
  assert.equal(gate.cooling(), true, '残缺目录必须进冷却，否则永远补不齐')

  // 裸布尔向后兼容：complete = got。
  const plain = new RemoteCatalogGate()
  await plain.run(async () => true)
  assert.equal(plain.cooling(), false, '裸布尔 true 应视为完整并清冷却')
  await plain.run(async () => false)
  assert.equal(plain.cooling(), true, '裸布尔 false 应进冷却')

  // 完全没拿到：不广播（没有新数据，通知只会让客户端空刷）。
  let loaded2 = 0
  const gate2 = new RemoteCatalogGate({ onLoaded: () => { loaded2 += 1 } })
  await gate2.run(async () => ({ got: false, complete: false }))
  assert.equal(loaded2, 0, '没拿到目录时不得广播')

  // 通知抛错不得反噬目录加载。
  const gate3 = new RemoteCatalogGate({ onLoaded: () => { throw new Error('notify boom') } })
  await gate3.run(async () => true) // 不抛 = 目录加载成功

  // 冷却期内不重复发起。
  let calls = 0
  const gate4 = new RemoteCatalogGate()
  await gate4.run(async () => { calls += 1; return false })
  await gate4.run(async () => { calls += 1; return false })
  assert.equal(calls, 1, '冷却期内不得重复拉取')
  console.log('ok  闸门：广播只在 got 时发出、冷却按 complete、通知抛错不反噬、冷却期内不重拉')
}

// ── 2. 预热：间隔约束 + 链式排程 ─────────────────────────────────────────────
{
  assert.equal(isPrewarmSpacingValid(), true,
    `默认预热间隔必须全部大于闸门冷却 ${REMOTE_CATALOG_COOLDOWN_MS}ms`)
  assert.equal(isPrewarmSpacingValid([0, 1_000]), false, '间隔小于冷却时必须判为无效')
  assert.equal(isPrewarmSpacingValid([0]), true, '只有立即那一轮时无间隔约束')

  // 链式：上一轮**结束**后才排下一轮（固定排程会被冷却挡回）。
  const scheduled = []
  let resolveRound
  const stop = startCatalogPrewarm({
    providers: ['p'],
    warm: () => new Promise((resolve) => { resolveRound = resolve }),
    delaysMs: [0, 35_000, 75_000],
    schedule: (fn, ms) => { scheduled.push(ms); return () => {} },
  })
  // 第一轮立即（microtask），且必须**卡在 warm 上**（还没结束）。
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(scheduled.length, 0, '第一轮还没结束，不得提前排下一轮（链式的要点）')
  resolveRound()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(scheduled, [35_000], '第一轮结束后才排 35s 那一轮')
  stop()
  console.log('ok  预热：间隔全部大于闸门冷却，且为链式排程（上一轮结束才排下一轮）')
}

// ── 3. 三个多来源 provider 的完整性判据 ──────────────────────────────────────
{
  const { isRemoteCatalogComplete } = await import(new URL('../vendor/channel-pack/src/models.ts', import.meta.url).href)
  const { isBuddyCatalogComplete } = await import(new URL('../vendor/channel-pack/src/buddy-oauth.ts', import.meta.url).href)
  const { isClineRecommendedShape, isClineModelsShape } = await import(new URL('../vendor/channel-pack/src/cline-models.ts', import.meta.url).href)

  // codearts：两个端点都成功才算完整。
  assert.equal(isRemoteCatalogComplete({ gatewayOk: true, builtinOk: true }), true)
  assert.equal(isRemoteCatalogComplete({ gatewayOk: true, builtinOk: false }), false,
    'codearts 单端点成功不算完整（残缺目录不得永久缓存）')

  // buddy：scoped 与 /v3/config 都成功才算完整。
  assert.equal(isBuddyCatalogComplete({ scopedOk: true, configOk: true }), true)
  assert.equal(isBuddyCatalogComplete({ scopedOk: true, configOk: false }), false,
    'buddy 单端点成功不算完整（促销倍率只在失败那个端点里）')

  // cline：形状判据必须接受**合法空数组**（上游下架全部模型是合法状态），
  // 但拒绝空壳（网关降级返回 {}）。
  assert.equal(isClineRecommendedShape({ free: [] }), true, '合法空数组算「取到了」')
  assert.equal(isClineRecommendedShape({}), false, '空壳不算取到')
  assert.equal(isClineRecommendedShape(null), false)
  assert.equal(isClineModelsShape({ data: [] }), true, 'data: [] 算「取到了」')
  assert.equal(isClineModelsShape({}), false, '缺 data 不算取到')
  console.log('ok  完整性判据：codearts/buddy 双来源、cline 形状守卫（空数组合法、空壳不算）')
}

console.log('\nchannel-catalog: 全部通过')
