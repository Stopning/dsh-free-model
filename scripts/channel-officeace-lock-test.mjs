/**
 * OfficeAce 的**锁定执行路径**（上游 IKLTHB 第 ① 条「哑锁」）与渠道接入的行为验证。
 *
 *     node --experimental-strip-types scripts/channel-officeace-lock-test.mjs
 *
 * ## 为什么单独立一条
 *
 * 上游那个 issue 的要害是：面板上渲染了「锁定永久积分」开关、并逐字承诺
 * 「这类积分用尽后将没有可用账号」，而**全仓没有任何执行代码读它** ⇒
 * 开关写进 `permanent-locks.json` 后行为与关闭**完全一致**（用户照旧烧永久包）。
 * 我们移植时若漏了 `credentialProvider` 的装配，就会**原样复现这个哑锁** ——
 * 而症状是「开关点了没反应」，不会报错。
 *
 * 所以这里直接对**判定函数**做行为断言：
 * - 未锁定 ⇒ 逐字走 `resolveUnlocked`（旧路径一个字节不变）；
 * - 锁定 + 只剩永久桶 ⇒ **抛错**，绝不回落池；
 * - 锁定 + 有窗口内到期的桶 ⇒ 放行。
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
    if (specifier.startsWith('./')) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { createOfficeAceCredentialProvider } = await import(
  new URL('../vendor/channel-pack/src/officeace-lock.ts', import.meta.url).href
)
const { OFFICEACE_MODELS, OFFICEACE } = await import(
  new URL('../vendor/channel-pack/src/officeace-product.ts', import.meta.url).href
)

const CRED = { appKey: 'k', appSecret: 's', refreshToken: 'r' }
const DAY = 24 * 60 * 60 * 1000

/** 造一个 provider + 可观测的 deps。 */
function makeProvider({ locked, summary }) {
  const calls = { unlocked: 0, readCredential: [], summaryOf: [] }
  const provider = createOfficeAceCredentialProvider({
    permanentLocked: () => locked,
    accounts: () => [{ id: 'oa-1', credentialRef: 'OFFICEACE_ACCOUNT_1' }],
    resolveUnlocked: async () => { calls.unlocked += 1; return CRED },
    readCredential: async (ref) => { calls.readCredential.push(ref); return CRED },
    readStoredCredential: () => CRED,
    summaryOf: async (credential, ref) => { calls.summaryOf.push(ref); return summary() },
    now: () => 1_700_000_000_000,
    windowMs: () => 15 * DAY,
  })
  return { provider, calls }
}

/** 一个「只剩不会近期作废的桶」的订阅摘要。 */
const onlyPermanent = () => ({
  ok: true,
  summary: {
    // ⚠️ officeace 读 `creditGroups[].expiresAt`（ISO 字符串），不是 buddy 的
    //    `packages[].deductionEndTime`（数值）—— 两个渠道的分桶口径不同。
    creditGroups: [
      // 无到期时间 = 永久桶
      { remaining: 5000 },
    ],
  },
})
/** 一个「有窗口内到期积分」的订阅摘要。 */
const withExpiring = () => ({
  ok: true,
  summary: {
    creditGroups: [
      { remaining: 100, expiresAt: new Date(1_700_000_000_000 + 3 * DAY).toISOString() },
      { remaining: 5000 },
    ],
  },
})

// ── 1. 未锁定 ⇒ 逐字走旧路径 ─────────────────────────────────────────────────
{
  const { provider, calls } = makeProvider({ locked: false, summary: onlyPermanent })
  const credential = await provider()
  assert.deepEqual(credential, CRED, '未锁定必须返回凭据')
  assert.equal(calls.unlocked, 1, '未锁定必须走注入的 resolveUnlocked（旧路径）')
  assert.equal(calls.summaryOf.length, 0, '未锁定不该去读余额（零额外网络请求）')
  console.log('ok  未锁定：逐字走旧路径（不读余额、不改变行为）')
}

// ── 2. 锁定 + 只剩永久桶 ⇒ 抛错，绝不回落池 ──────────────────────────────────
{
  const { provider, calls } = makeProvider({ locked: true, summary: onlyPermanent })
  await assert.rejects(() => provider(), (error) => {
    assert.ok(error instanceof Error, '应抛 Error')
    // 文案必须可读，而不是泛化错误（否则用户不知道是锁定导致）
    assert.match(error.message, /永久积分|锁定|可用账号/, `错误文案应说明锁定原因，实得：${error.message}`)
    return true
  }, '锁定 + 只剩永久桶时必须抛错（否则就是哑锁）')
  assert.equal(calls.unlocked, 0, '锁定态**绝不**回落池取号')
  console.log('ok  锁定 + 只剩永久桶：抛错且不回落池（哑锁已修）')
}

// ── 3. 锁定 + 有窗口内到期积分 ⇒ 放行 ───────────────────────────────────────
{
  const { provider } = makeProvider({ locked: true, summary: withExpiring })
  const credential = await provider()
  assert.deepEqual(credential, CRED, '锁定 + 有临期积分时应放行（只烧会作废的那部分）')
  console.log('ok  锁定 + 有临期积分：放行')
}

// ── 4. 读余额必须带 ref（多账号判成同一份余额是上游实测缺陷）──────────────────
{
  const { provider, calls } = makeProvider({ locked: true, summary: onlyPermanent })
  await provider().catch(() => undefined)
  assert.deepEqual(calls.summaryOf, ['OFFICEACE_ACCOUNT_1'],
    '读订阅摘要必须带上账号 ref（缺了会回落云侧全局单 cookie ⇒ 多账号看作同一份余额）')
  console.log('ok  读余额带 ref（多账号不被判成同一份余额）')
}

// ── 5. 移植进来的静态模型表 ─────────────────────────────────────────────────
{
  assert.equal(OFFICEACE.id, 'officeace')
  assert.equal(OFFICEACE_MODELS.length, 8, `OFFICEACE_MODELS 应为 8 条，实得 ${OFFICEACE_MODELS.length}`)
  const ids = OFFICEACE_MODELS.map((m) => m.id)
  for (const expected of ['glm-5.3', 'glm-5.2', 'glm-5.1', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'kimi-k2.6']) {
    assert.ok(ids.includes(expected), `模型表应含 ${expected}`)
  }
  // 上游实测只有两条收图：deepseek-v4.1-flash 与 kimi-k2.6（图片准入严格照此）。
  // ⚠️ 字段名是 `multimodal`（不是 `supportsImage`）—— 本产品表自己的口径。
  const vision = OFFICEACE_MODELS.filter((m) => m.multimodal === true).map((m) => m.id).sort()
  assert.deepEqual(vision, ['deepseek-v4.1-flash', 'kimi-k2.6'],
    `只有两条模型收图，实得 ${JSON.stringify(vision)}`)
  console.log('ok  静态模型表：8 条，且图片准入严格为 deepseek-v4.1-flash / kimi-k2.6')
}

console.log('\nchannel-officeace-lock: 全部通过')
