#!/usr/bin/env node
/**
 * 自动签到明细补丁 —— 插件更新（pnpm update / 重装）后重跑即可。
 *
 * 为什么需要它：dsh-free-model 是整包安装的，任何更新都会用官方文件覆盖
 * client.js / pack.js，手工改的 UI 与后端逻辑会一起消失。把改动收敛成
 * 「锚点 + 替换」的幂等脚本，更新后执行一次就能恢复。
 *
 * 适配版本：0.5.2（dsh-free-model，基于上游 2.3.0 那代）。
 *
 * 两类补丁都在这里：
 *   (a) 设置页签到明细（1 处 client.js + 4 处 pack.js）
 *   (b) 腾讯 11128 指纹规则 web-gui-segment（pack.js CONTENT_FINGERPRINTS 首条）
 *       —— 官方包一直没有这条，重装/升级必丢，丢了 buddy/workbuddy 立刻 400。
 * 换插件版本后锚点可能失配，届时按 --check 的报错重新对锚点。
 *
 * 用法：
 *   node dsh-patch-checkin.cjs           打补丁（已打过则跳过）
 *   node dsh-patch-checkin.cjs --check   只检查，缺任一处 exit 1
 *
 * 打完补丁必须重启 DSH 才生效（插件模块不热重载）。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// DSH_PATCH_TARGET 可指向别处（测试用）；默认就是装好的插件目录。
const PLUGIN = process.env.DSH_PATCH_TARGET ?? path.join(
  os.homedir(),
  '.dsh/profiles/desktop/node_modules/dsh-free-model',
)

/** 每处补丁：文件、锚点、替换、说明。锚点必须与官方原文逐字符一致。 */
const PATCHES = [
  {
    file: 'client.js',
    why: '渲染 auto.channels 逐条明细，去掉 lastResult 的 60 字截断',
    find:
      "          auto == null ? null : h('div', { className: 'ofm_row' },\n" +
      "            h(Switch, { checked: auto.enabled === true, label: t('chan.auto.title'), onChange: () => void toggleAuto() }),\n" +
      "            h(Pill, { tone: auto.running === true ? 'warn' : auto.ranToday === true ? 'ok' : '' },\n" +
      "              auto.running === true ? t('chan.auto.running') : auto.ranToday === true ? t('chan.auto.ran') : t('chan.auto.off')),\n" +
      "            typeof auto.lastResult === 'string' && auto.lastResult !== '' ? h('span', { className: 'ofm_note', title: auto.lastResult }, t('chan.auto.last').replace('{result}', auto.lastResult.length > 60 ? `${auto.lastResult.slice(0, 60)}…` : auto.lastResult)) : null)),",
    replace:
      "          auto == null ? null : h('div', null,\n" +
      "            h('div', { className: 'ofm_row' },\n" +
      "              h(Switch, { checked: auto.enabled === true, label: t('chan.auto.title'), onChange: () => void toggleAuto() }),\n" +
      "              h(Pill, { tone: auto.running === true ? 'warn' : auto.ranToday === true ? 'ok' : '' },\n" +
      "                auto.running === true ? t('chan.auto.running') : auto.ranToday === true ? t('chan.auto.ran') : t('chan.auto.off')),\n" +
      "              typeof auto.lastResult === 'string' && auto.lastResult !== '' ? h('span', { className: 'ofm_note' }, t('chan.auto.last').replace('{result}', auto.lastResult)) : null),\n" +
      "            Array.isArray(auto.channels) && auto.channels.length > 0 ? h('ul', { className: 'ofm_note', style: { listStyle: 'none', margin: '.35rem 0 0', padding: 0, display: 'grid', gap: '.15rem' } },\n" +
      "              auto.channels.map(entry => h('li', { key: entry.provider },\n" +
      "                h('span', { 'aria-hidden': 'true', style: { marginRight: '.4rem' } },\n" +
      "                  entry.text.includes('失败') ? '❌'\n" +
      "                    : entry.text.includes('已领') ? '✅'\n" +
      "                      : entry.text.includes('暂不可领') ? '⚪'\n" +
      "                        : entry.text.includes('手动') || entry.text.includes('试用') ? '✋' : '➖'),\n" +
      "                `${CHANNEL_PROVIDERS.find(row => row.id === entry.provider)?.name ?? entry.provider}：${entry.text}`,\n" +
      "                typeof entry.reason === 'string' && entry.reason !== ''\n" +
      "                  ? h('span', { style: { opacity: .7 } }, ` — ${entry.reason.length > 120 ? `${entry.reason.slice(0, 120)}…` : entry.reason}`)\n" +
      "                  : null))) : null)),",
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: '失败/未开启时把 results[].outcome.message 作为 reason 写进渠道明细（否则只有「1 个未开启」，看不出是 10 点未刷新还是账号没开通）',
    find:
      '      channels.push({ provider, text: describeChannel(summary) });',
    replace:
      '      // 具体原因只存在于 results[].outcome.message，describeChannel 只拿得到计数，\n' +
      '      // 所以在渠道文案后面补一句原因，用户才知道是「为什么」。\n' +
      '      // inactive 也要带原因：Qoder 10 点前是「每日活动尚未刷新」、账号没开通是「尚未开通」，\n' +
      '      // 两者都归为「未开启」，不写原因就分不清。\n' +
      '      const reasonRow = summary.failed > 0 || summary.inactive > 0\n' +
      '        ? (result.value?.results ?? []).find((row) => row.outcome?.kind === "failed" || row.outcome?.kind === "inactive")\n' +
      '        : void 0;\n' +
      '      const claimReason = typeof reasonRow?.outcome?.message === "string" && reasonRow.outcome.message !== ""\n' +
      '        ? reasonRow.outcome.message\n' +
      '        : void 0;\n' +
      '      let channelText = describeChannel(summary);\n' +
      '      // Qoder 的每日活动按 10:00(UTC+8) 刷新，和其它渠道的 0 点自然日不是一套规则。\n' +
      '      // 10:00 前跑的那一轮拿到的是昨天那轮（claimQoderDailyCheckin 在 !refreshed 时返回 inactive），\n' +
      '      // 而 runIfDue() 当天去重 → 当天不会再自动重试，所以必须当场告诉用户 10:00 后再手动领一次。\n' +
      '      if (provider === "qodercn" && !hasQoderCampaignRefreshedToday(now())) {\n' +
      '        channelText = \`\${channelText}\\uFF08\\u6BCF\\u65E5 10:00 \\u5237\\u65B0\\uFF0C10:00 \\u540E\\u9700\\u624B\\u52A8\\u518D\\u9886\\u4E00\\u6B21\\uFF09\`;\n' +
      '      }\n' +
      '      channels.push({\n' +
      '        provider,\n' +
      '        text: channelText,\n' +
      '        ...claimReason === void 0 ? {} : { reason: claimReason }\n' +
      '      });',
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: '「调用异常」分支补 reason',
    find:
      '        channels.push({ provider, text: "\\u51FA\\u9519" });\n' +
      '        deps.warn?.(`[channel-pack] \\u81EA\\u52A8\\u7B7E\\u5230\\uFF1A${provider} \\u8C03\\u7528\\u5F02\\u5E38: ${String(error)}`);',
    replace:
      '        channels.push({ provider, text: "\\u51FA\\u9519", reason: String(error) });\n' +
      '        deps.warn?.(`[channel-pack] \\u81EA\\u52A8\\u7B7E\\u5230\\uFF1A${provider} \\u8C03\\u7528\\u5F02\\u5E38: ${String(error)}`);',
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: '「返回失败」分支补 reason',
    find:
      '        channels.push({ provider, text: "\\u51FA\\u9519" });\n' +
      '        deps.warn?.(`[channel-pack] \\u81EA\\u52A8\\u7B7E\\u5230\\uFF1A${provider} \\u5931\\u8D25: ${message2 || "\\u672A\\u77E5\\u9519\\u8BEF"}`);',
    replace:
      '        channels.push({ provider, text: "\\u51FA\\u9519", reason: message2 || "\\u672A\\u77E5\\u9519\\u8BEF" });\n' +
      '        deps.warn?.(`[channel-pack] \\u81EA\\u52A8\\u7B7E\\u5230\\uFF1A${provider} \\u5931\\u8D25: ${message2 || "\\u672A\\u77E5\\u9519\\u8BEF"}`);',
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: 'sanitizeChannels 保留 reason（否则读盘时被丢掉）',
    find:
      '    out.push({ provider: record.provider, text: record.text.slice(0, 120) });',
    replace:
      '    out.push({\n' +
      '      provider: record.provider,\n' +
      '      text: record.text.slice(0, 120),\n' +
      '      // 失败原因（可选）：旧文档没有该字段，读回来时不能丢。\n' +
      '      ...typeof record.reason === "string" && record.reason !== ""\n' +
      '        ? { reason: record.reason.slice(0, 200) }\n' +
      '        : {}\n' +
      '    });',
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: '补回腾讯 11128 指纹规则 web-gui-segment（官方 0.5.2 没有这条）',
    find:
      'var CONTENT_FINGERPRINTS = [\n' +
      '  {\n' +
      '    // \u2605 **DSH \u81EA\u5DF1\u7684 system \u63D0\u793A\u8BCD\u9996\u53E5**',
    replace:
      'var CONTENT_FINGERPRINTS = [\n' +
      '  {\n' +
      '    // \u2605 2026-10-30 \u672C\u673A\u5B9E\u6D4B\uFF1ADSH \u6BCF\u8F6E system \u6052\u5E26\u6B64\u6BB5\uFF0C\u539F\u6587 220 \u5B57\u7B26\u8FDE\u8BFB\u89E6\u53D1 11128\uFF08Illegal API invocation from an unapproved channel\uFF09\uFF0C\u7F3A\u4E00\u5B57\u7B26\u5373\u653E\u884C\uFF1B\u53EA\u7B2C1\u53E5/\u53EA\u7B2C2\u53E5/\u4E24\u53E5\u6362\u5E8F\u5747\u653E\u884C \u21D2 \u7EC4\u5408\u5F0F\u5224\u636E\u4E14\u6709\u987A\u5E8F\u3002\u4E0A\u6E38 dsh-free-model 0.5.2 \u7F3A\u6B64\u6761\u3002\u6539\u5199\u53EA\u52A8\u672B\u5C3E this GUI \u2192 the Web GUI\uFF0C\u5176\u4F59 215 \u5B57\u7B26\u9010\u5B57\u4E0D\u52A8\u3002\n' +
      '    find: "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to \\"this page\\", \\"this GUI\\", or \\"this app\\" without naming another target, they mean this GUI",\n' +
      '    replace: "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to \\"this page\\", \\"this GUI\\", or \\"this app\\" without naming another target, they mean the Web GUI",\n' +
      '    note: "web-gui-segment"\n' +
      '  },\n' +
      '  {\n' +
      '    // \u2605 **DSH \u81EA\u5DF1\u7684 system \u63D0\u793A\u8BCD\u9996\u53E5**',
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: 'ZCode 分支文案：原「需手动签到」会让人以为能长期手动签到，实际只有 5 天试用额度',
    find:
      '        channels.push({ provider, text: "\\u9700\\u624B\\u52A8\\u7B7E\\u5230" });',
    replace:
      '        channels.push({ provider, text: "无签到（仅 5 天试用额度）" });',
  },
  {
    file: 'client.js',
    why: '图标判据跟上新文案：含「试用」也显示 ✋（否则 ZCode 会掉成 ➖）',
    find:
      "                        : entry.text.includes('手动') ? '✋' : '➖'),",
    replace:
      "                        : entry.text.includes('手动') || entry.text.includes('试用') ? '✋' : '➖'),",
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: 'describeRun 的渠道总数漏算 skipped/errors，会出现「3 个渠道…2 个渠道不支持签到」的 3+2=5',
    find:
      'function describeRun(totals) {\n' +
      '  const parts = [];\n' +
      '  if (totals.claimed > 0) {',
    replace:
      'function describeRun(totals) {\n' +
      '  const parts = [];\n' +
      '  // 渠道总数 = 成功返回 + 不支持签到 + 出错，三者互斥且覆盖全部入口。\n' +
      '  // 只报 providers 会漏掉 skipped/errors 的渠道，出现「3 个渠道…2 个渠道不支持签到」这种自相矛盾的 3+2=5。\n' +
      '  const channelTotal = totals.providers + totals.skipped + totals.errors;\n' +
      '  if (totals.claimed > 0) {',
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: 'describeRun 两处输出改用 channelTotal（否则上面算了却没用）',
    find:
      '  if (parts.length === 0) return `${totals.providers} \\u4E2A\\u6E20\\u9053\\uFF1A\\u6CA1\\u6709\\u9700\\u8981\\u9886\\u53D6\\u7684\\u8D26\\u53F7`;\n' +
      '  return `${totals.providers} \\u4E2A\\u6E20\\u9053\\uFF1A${parts.join("\\uFF0C")}`;',
    replace:
      '  if (parts.length === 0) return `${channelTotal} \\u4E2A\\u6E20\\u9053\\uFF1A\\u6CA1\\u6709\\u9700\\u8981\\u9886\\u53D6\\u7684\\u8D26\\u53F7`;\n' +
      '  return `${channelTotal} \\u4E2A\\u6E20\\u9053\\uFF1A${parts.join("\\uFF0C")}`;',
  },
  {
    file: 'client.js',
    why: '渠道卡片排序：加载累计请求数（usage.tokenLedgerHistory），provider.status 不含用量',
    find:
      '      useEffect(() => { void loadStatus() }, [loadStatus])\n' +
      '      // A second poll loop, slow: the pack pushes nothing for accounts changed',
    replace:
      '      useEffect(() => { void loadStatus() }, [loadStatus])\n' +
      '      // 渠道卡片排序用：累计请求数（全部历史）。只能靠这个 RPC 拿，\n' +
      '      // provider.status 只告诉接入状态、不含用量。\n' +
      '      const [usage, setUsage] = useState(undefined)\n' +
      '      useEffect(() => {\n' +
      '        if (!available) return\n' +
      '        let cancelled = false\n' +
      '        void (async () => {\n' +
      '          try {\n' +
      '            const value = await rpc(\'usage.tokenLedgerHistory\', { sinceDays: 3650 }, 60_000)\n' +
      '            if (cancelled) return\n' +
      '            const byChannel = new Map()\n' +
      '            for (const day of value?.history ?? []) {\n' +
      '              for (const ch of day.channels ?? []) {\n' +
      '                const prev = byChannel.get(ch.channel) ?? 0\n' +
      '                let requests = 0\n' +
      '                for (const provider of ch.providers ?? []) {\n' +
      '                  for (const account of provider.accounts ?? []) {\n' +
      '                    for (const model of account.models ?? []) requests += model.requests ?? 0\n' +
      '                  }\n' +
      '                }\n' +
      '                byChannel.set(ch.channel, prev + requests)\n' +
      '              }\n' +
      '            }\n' +
      '            setUsage(byChannel)\n' +
      '          } catch { setUsage(new Map()) }\n' +
      '        })()\n' +
      '        return () => { cancelled = true }\n' +
      '      }, [available, rpc])\n' +
      '      // A second poll loop, slow: the pack pushes nothing for accounts changed',
  },
  {
    file: 'client.js',
    why: '渠道卡片四档排序：已接入且用过（按累计请求数降序）→ 已接入未用 → 有账号未启用 → 未接入',
    find:
      '      const connected = statuses === undefined ? 0 : CHANNEL_PROVIDERS.filter(row => (statuses[row.id]?.accounts?.enabled ?? 0) > 0).length',
    replace:
      '      const connected = statuses === undefined ? 0 : CHANNEL_PROVIDERS.filter(row => (statuses[row.id]?.accounts?.enabled ?? 0) > 0).length\n' +
      '      // 四档排序：已接入且用过（按累计请求数降序）→ 已接入未用 → 有账号但未启用 → 未接入。\n' +
      '      // 同档保持 CHANNEL_PROVIDERS 原顺序（sort 是稳定的），免得每次刷新卡片乱跳。\n' +
      '      const rankOf = (id) => {\n' +
      '        const enabled = (statuses?.[id]?.accounts?.enabled ?? 0) > 0\n' +
      '        const total = (statuses?.[id]?.accounts?.total ?? 0) > 0\n' +
      '        const requests = usage?.get(id) ?? 0\n' +
      '        if (enabled) return requests > 0 ? 0 : 1\n' +
      '        return total ? 2 : 3\n' +
      '      }\n' +
      '      const ordered = statuses === undefined || usage === undefined\n' +
      '        ? CHANNEL_PROVIDERS\n' +
      '        : [...CHANNEL_PROVIDERS].sort((a, b) => {\n' +
      '          const d = rankOf(a.id) - rankOf(b.id)\n' +
      '          return d !== 0 ? d : (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0)\n' +
      '        })',
  },
  {
    file: 'client.js',
    why: '渲染改用 ordered（否则上面排了却没生效）',
    find: "        ready ? h('div', { className: 'ofm_chanwrap' }, CHANNEL_PROVIDERS.map(channel => h(ChannelCard, {",
    replace: "        ready ? h('div', { className: 'ofm_chanwrap' }, ordered.map(channel => h(ChannelCard, {",
  },
  {
    file: 'vendor/channel-pack/pack.js',
    why: 'inactive 文案「N 个未开启」→「N 个暂不可领」：Qoder 10 点前只是活动没刷新，不是账号没开通，原话会误导',
    find:
      '  if (summary.inactive > 0) parts.push(`${summary.inactive} \\u4E2A\\u672A\\u5F00\\u542F`);',
    replace:
      '  if (summary.inactive > 0) parts.push(`${summary.inactive} \\u4E2A\\u6682\\u4E0D\\u53EF\\u9886`);',
  }
]

const mode = process.argv.includes('--check') ? 'check' : 'apply'

function stamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

function run() {
  // 按文件分组，避免同一文件被读改写多次。
  const byFile = new Map()
  for (const p of PATCHES) {
    if (!byFile.has(p.file)) byFile.set(p.file, [])
    byFile.get(p.file).push(p)
  }

  let applied = 0
  let already = 0
  let missing = 0

  for (const [rel, list] of byFile) {
    const file = path.join(PLUGIN, rel)
    if (!fs.existsSync(file)) {
      console.error(`✗ 文件不存在: ${file}`)
      process.exitCode = 1
      continue
    }
    let text = fs.readFileSync(file, 'utf8')
    let dirty = false

    for (const p of list) {
      if (text.includes(p.replace)) {
        already += 1
        continue
      }
      if (!text.includes(p.find)) {
        // 官方改了这段代码 —— 锚点对不上，需要人工看。
        console.error(`✗ 锚点未找到（${rel}）：${p.why}`)
        missing += 1
        process.exitCode = 1
        continue
      }
      if (mode === 'check') {
        // 还是官方原文：补丁没打（或更新后被覆盖）。
        console.error(`✗ 补丁缺失（${rel}）：${p.why}`)
        missing += 1
        process.exitCode = 1
        continue
      }
      text = text.replace(p.find, p.replace)
      dirty = true
      applied += 1
      console.log(`✓ 打补丁（${rel}）：${p.why}`)
    }

    if (dirty && mode === 'apply') {
      fs.copyFileSync(file, `${file}.bak-${stamp()}`)
      fs.writeFileSync(file, text, 'utf8')
    }
  }

  if (mode === 'check') {
    if (missing > 0) console.error(`\n✗ ${missing} 处补丁缺失，需要重新打补丁。`)
    else console.log(`\n✓ 全部 ${already} 处补丁就位。`)
    return
  }
  console.log(`\n新打 ${applied} 处，已有 ${already} 处，失败 ${missing} 处。`)
  if (applied > 0) console.log('⚠️ 必须重启 DSH 才生效（插件模块不热重载）。')
}

run()
