// 校验 dsh-patch-checkin.cjs 中「渠道明细补 reason」那段选行逻辑。
// 跑法：node dsh-patch-checkin.test.cjs
const assert = require('node:assert')

// 与 pack.js:60556-60561 逐字等价的实现
function pickReason(summary, results) {
  const reasonRow = summary.failed > 0 || summary.inactive > 0
    ? (results ?? []).find((row) => row.outcome?.kind === 'failed' || row.outcome?.kind === 'inactive')
    : void 0
  const claimReason = typeof reasonRow?.outcome?.message === 'string' && reasonRow.outcome.message !== ''
    ? reasonRow.outcome.message
    : void 0
  return claimReason
}

const sum = o => ({ failed: 0, inactive: 0, ...o })

// 1. Qoder 10 点前：inactive 且带「尚未刷新」提示 → 必须出原因
assert.strictEqual(
  pickReason(sum({ inactive: 1 }), [{ outcome: { kind: 'inactive', message: '今天的每日活动尚未刷新（每日 10:00（UTC+8）刷新）' } }]),
  '今天的每日活动尚未刷新（每日 10:00（UTC+8）刷新）'
)

// 2. Qoder 账号没开通：inactive 带「尚未开通」 → 也要出原因（区别于上一条）
assert.match(
  pickReason(sum({ inactive: 1 }), [{ outcome: { kind: 'inactive', message: '该账号尚未在 Qoder 侧开通每日领取' } }]),
  /尚未在 Qoder 侧开通/
)

// 3. 纯失败：仍按老行为出原因
assert.strictEqual(
  pickReason(sum({ failed: 1 }), [{ outcome: { kind: 'failed', message: '网络超时' } }]),
  '网络超时'
)

// 4. 全部成功 / 已领：不给原因，避免噪音
assert.strictEqual(pickReason(sum({ claimed: 1 }), [{ outcome: { kind: 'claimed' } }]), void 0)
assert.strictEqual(pickReason(sum({}), []), void 0)

// 5. inactive 但 message 为空：不给空字符串原因
assert.strictEqual(pickReason(sum({ inactive: 1 }), [{ outcome: { kind: 'inactive', message: '' } }]), void 0)

// 6. 混合（一个 failed + 一个 inactive）：取列表中第一个，failed 优先只要它在前面
assert.strictEqual(
  pickReason(sum({ failed: 1, inactive: 1 }), [
    { outcome: { kind: 'failed', message: 'A' } },
    { outcome: { kind: 'inactive', message: 'B' } },
  ]),
  'A'
)


// ---- describeRun 渠道总数（2026-10-31 修：「3 个渠道…2 个渠道不支持签到」= 3+2=5 自相矛盾）----
function describeRun(totals) {
  const parts = []
  const channelTotal = totals.providers + totals.skipped + totals.errors
  if (totals.claimed > 0) parts.push(`${totals.claimed} 个账号领取成功`)
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} 个今天已领`)
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`)
  if (totals.errors > 0) parts.push(`${totals.errors} 个渠道出错`)
  if (totals.skipped > 0) parts.push(`${totals.skipped} 个渠道不支持签到`)
  if (parts.length === 0) return `${channelTotal} 个渠道：没有需要领取的账号`
  return `${channelTotal} 个渠道：${parts.join('，')}`
}
const T = o => ({ providers: 0, claimed: 0, alreadyClaimed: 0, failed: 0, errors: 0, skipped: 0, ...o })

// 7. 2026-10-31 真实场景：3 个已领 + 2 个不支持 = 必须是 5，不能是 3
assert.ok(describeRun(T({ providers: 3, alreadyClaimed: 3, skipped: 2 })).startsWith('5 个渠道'), '渠道总数必须是 5')
// 8. 全部不支持签到
assert.ok(describeRun(T({ skipped: 5 })).startsWith('5 个渠道'))
// 9. 含出错分支
assert.ok(describeRun(T({ providers: 2, claimed: 1, errors: 1, skipped: 1 })).startsWith('4 个渠道'))
// 10. 空
assert.strictEqual(describeRun(T({})), '0 个渠道：没有需要领取的账号')


// ---- Qoder 10:00 刷新提醒（2026-10-31：Qoder 与其它渠道不是同一套日界规则）----
// 判据来自 pack.js 的 hasQoderCampaignRefreshedToday：UTC+8 小时数 >= 10
const QODER_REFRESH_HOUR = 10
const hasRefreshed = (h) => h >= QODER_REFRESH_HOUR
// 模拟 performRun 里那段：只有 qodercn 且未刷新才追加提醒
const buildText = (provider, base, hour) =>
  provider === 'qodercn' && !hasRefreshed(hour)
    ? `${base}（每日 10:00 刷新，10:00 后需手动再领一次）`
    : base

// 11. 09:37 跑 → 必须带提醒
assert.ok(buildText('qodercn', '1 个暂不可领', 9).includes('10:00 后需手动再领一次'))
// 12. 10:00 后跑 → 不带提醒（已经领到今天的，再提醒是误导）
assert.strictEqual(buildText('qodercn', '1 个今天已领', 17), '1 个今天已领')
// 13. 其它渠道永远不带（不要污染 buddy/minimax）
assert.strictEqual(buildText('buddy', '1 个今天已领', 9), '1 个今天已领')
assert.strictEqual(buildText('minimax', '1 个今天已领', 3), '1 个今天已领')
// 14. 边界：09:59 仍带，10:00 起不带
assert.ok(buildText('qodercn', 'x', 9).includes('10:00 后需手动再领一次'), '09:59 仍要提醒')
assert.strictEqual(buildText('qodercn', 'x', 10), 'x', '10:00 起不再提醒')


// ---- 渠道卡片四档排序（2026-10-31）----
// 判据与 client.js 的 rankOf 一致：已接入且用过 > 已接入未用 > 有账号未启用 > 未接入
const rankOf = (id, statuses, usage) => {
  const enabled = (statuses?.[id]?.accounts?.enabled ?? 0) > 0
  const total = (statuses?.[id]?.accounts?.total ?? 0) > 0
  const requests = usage?.get(id) ?? 0
  if (enabled) return requests > 0 ? 0 : 1
  return total ? 2 : 3
}
const order = (CP, statuses, usage) => [...CP].sort((a, b) => {
  const d = rankOf(a.id, statuses, usage) - rankOf(b.id, statuses, usage)
  return d !== 0 ? d : (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0)
})

const CP = [{ id: 'codearts' }, { id: 'buddy' }, { id: 'workbuddy' }, { id: 'qodercn' }, { id: 'minimax' }, { id: 'zcode' }]
const ST = {
  buddy: { accounts: { total: 1, enabled: 1 } },
  qodercn: { accounts: { total: 1, enabled: 1 } },
  minimax: { accounts: { total: 1, enabled: 1 } },
  workbuddy: { accounts: { total: 1, enabled: 1 } },
  zcode: { accounts: { total: 1, enabled: 1 } },
  codearts: { accounts: { total: 0, enabled: 0 } },
}
const US = new Map([['buddy', 99999], ['minimax', 1000], ['qodercn', 500], ['workbuddy', 50], ['zcode', 5]])

// 15. 用得最多的排第一
assert.strictEqual(order(CP, ST, US)[0].id, 'buddy')
// 16. 未接入的排最后
assert.strictEqual(order(CP, ST, US).at(-1).id, 'codearts')
// 17. 已接入按请求数降序
assert.deepStrictEqual(order(CP, ST, US).map(r => r.id), ['buddy', 'minimax', 'qodercn', 'workbuddy', 'zcode', 'codearts'])
// 18. 已接入但零请求 → 排在所有用过的之后、未接入之前
const ST2 = { ...ST, lobsterai: { accounts: { total: 1, enabled: 1 } } }
const US2 = new Map(US)
const CP2 = [...CP, { id: 'lobsterai' }]
const out2 = order(CP2, ST2, US2).map(r => r.id)
assert.strictEqual(out2[out2.length - 2], 'lobsterai', '零请求的已接入排倒数第二')
// 19. 有账号但未启用 → 第 3 档，排在零请求的已接入之后
const ST3 = { ...ST, trae: { accounts: { total: 1, enabled: 0 } } }
const out3 = order([...CP, { id: 'trae' }], ST3, US).map(r => r.id)
assert.strictEqual(out3[out3.length - 2], 'trae')
assert.strictEqual(out3.at(-1), 'codearts')
// 20. 数据未就绪（statuses 或 usage 为 undefined）时不排序，保持原顺序
const safeOrder = (CP, statuses, usage) => statuses === undefined || usage === undefined ? CP : order(CP, statuses, usage)
assert.deepStrictEqual(safeOrder(CP, undefined, US).map(r => r.id), CP.map(r => r.id))
assert.deepStrictEqual(safeOrder(CP, ST, undefined).map(r => r.id), CP.map(r => r.id))

console.log('✓ 全部 20 项通过')
