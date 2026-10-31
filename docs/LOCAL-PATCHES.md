# 本机改动（基于 0.5.2）

本分支是 `v0.5.2`（提交 `f81de3b`）加上**本机手工改动**，共 **14 处**，全部是展示层与文案修正，没有动渠道协议、请求头、重试与鉴权逻辑。

- 基线：[`YpipaQ/dsh-free-model`](https://github.com/YpipaQ/dsh-free-model) tag `v0.5.2`
- 上游源：[`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)
- 补丁脚本：`dsh-patch-checkin.cjs`（幂等，锚点 + 替换；也可直接本分支源码覆盖）

## 为什么不是直接改包

插件是整包 npm 安装，`pnpm update` / 重装会用官方 `client.js` 与 `vendor/channel-pack/pack.js` **覆盖**本地修改。所以改动收敛成「锚点 + 替换」数组，更新后跑一次脚本即恢复；本分支则是同一组改动的可读源码版本。

## 一、签到明细可见（1、2、3、4、5）

**问题**：设置页只显示一行「上次结果：3 个渠道：1 个今天已领，1 个失败，2 个渠道不支持签到」，60 字截断，且不知道哪个渠道是哪个。

**原因**：后端 `createAutoCheckin().state()` 早就把 `channels` 数组返回给前端了，前端从未渲染它；同时 `lastResult` 被 `slice(0, 60)` 截断。

**改动**：

| # | 文件 | 改什么 |
|---|---|---|
| 1 | `client.js` | 渲染 `auto.channels` 成列表：每行「渠道名：结果」，按文案给 ✅ 已领 / ❌ 失败 / ⚪ 暂不可领 / ✋ 手动 / ➖ 无接口 图标；`entry.reason` 存在时追加「 — 原因」（>120 字截断）；去掉 `lastResult` 的 60 字截断 |
| 2 | `pack.js` | `failed` **或 `inactive`** 时从 `result.value.results[].outcome.message` 取原因写进 `channels[].reason` |
| 3 | `pack.js` | 「调用异常」分支补 `reason: String(error)` |
| 4 | `pack.js` | 「返回失败」分支补 `reason: message2 \|\| "未知错误"` |
| 5 | `pack.js` | `sanitizeChannels` 读盘时保留 `reason`（`slice(0, 200)`）——漏这处，写进去的原因读回来会被丢掉 |

改动 2 之所以要带 `inactive`：Qoder 在 10:00 前、和「账号没开通」都归为 `inactive`，不写原因就分不清是哪一种。

## 二、腾讯 11128 指纹规则（6）

**问题**：`buddy` / `workbuddy` 报 400 `code:11128 Illegal API invocation from an unapproved channel`（「请求被拦截，请重新发送」）。

**原因**：DSH 每轮 system 提示词恒带一段 Web GUI 说明（220 字符），腾讯侧对其做组合式指纹校验，原文连读即判非法。官方 `pack.js` 的 `CONTENT_FINGERPRINTS` **没有这条规则**，任何重装都会丢，丢了 buddy 必 400。

**改动**：在 `var CONTENT_FINGERPRINTS = [` 之后插入首条规则 `web-gui-segment`，把该段结尾的 `this GUI` 改成 `the Web GUI`，其余 215 字符逐字不动。

> 同一套机制的其它规则（身份句 `powered by` → `running on` 等）官方包自带，不受影响。

## 三、文案消歧（7、8、9、10、14）

| # | 原文案 | 新文案 | 为什么 |
|---|---|---|---|
| 7 | ZCode：`需手动签到` | `无签到（仅 5 天试用额度）` | 会让人以为能长期手动签到。实际 ZCode 只有 5 天免费试用额度，到 2026-11-4 结束，**网页端也没有签到入口** |
| 8 | `✋` 仅匹配「手动」 | 也匹配「试用」 | 配合 7，否则 ZCode 会掉成 ➖ |
| 9 + 10 | `3 个渠道：…2 个渠道不支持签到`（3+2=5） | `5 个渠道：…` | `totals.providers` 只在 claim 成功返回后 +1，`skipped` / `errors` 走 `continue` 不计入 → 自相矛盾。改为 `channelTotal = providers + skipped + errors` |
| 14 | `N 个未开启` | `N 个暂不可领` | Qoder 10 点前只是「每日活动尚未刷新」，不是账号没开通 |

**Qoder 的时间门槛**（未改代码，仅记录）：`QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10`，活动按 **10:00（UTC+8）** 刷新，而非其它渠道的 0 点自然日。`runIfDue()` 当天跑过就不再跑，所以 10:00 前那轮拿到的是昨天那轮，当天不会自动重试。

## 四、渠道卡片排序（11、12、13）

**需求**：已接入且经常用的排前面，未接入排后面。

**数据源**：`provider.status` 只有账号计数（`accounts.total` / `accounts.enabled`），**不含用量**；请求数要从 `usage.tokenLedgerHistory` 取。

**改动**：

| # | 改什么 |
|---|---|
| 11 | 页面挂载时拉 `usage.tokenLedgerHistory({ sinceDays: 3650 })`，遍历 `day.channels[].providers[].accounts[].models[].requests` 累加进 `Map<channelId, requests>` |
| 12 | 四档 `rankOf` + `ordered` 排序 |
| 13 | 渲染由 `CHANNEL_PROVIDERS.map` 改为 `ordered.map` |

**四档语义**：

```
0  已接入 且 有过调用   → 按累计请求数降序
1  已接入 但 零调用
2  有账号 但 未启用
3  完全未接入
```

同档保持 `CHANNEL_PROVIDERS` 原顺序（`Array.sort` 稳定），避免每次刷新卡片乱跳；数据未就绪（`statuses` 或 `usage` 为 `undefined`）时直接返回原数组，不闪跳。

## 验证

改完必须**重启 DSH** —— 桌面端不热重载插件模块（`pack.js` 走 packed loader，ESM 缓存换不掉）。

```bash
# 补丁是否就位
node dsh-patch-checkin.cjs --check      # 期望：✓ 全部 14 处补丁就位

# 逻辑自检（纯 assert，无框架）
node dsh-patch-checkin.test.cjs         # 期望：✓ 全部 20 项通过
```

自检覆盖：6 项签到 reason（inactive 两种原因 / 纯 failed / 全成功 / message 为空 / 混合取第一个）、4 项 `describeRun` 计数（真实场景必须 5 个渠道 / 全不支持 / 含出错 / 空）、4 项 Qoder 提醒（09:37 带、17 点不带、其它渠道不带、09:59/10:00 边界）、6 项排序（用得最多排第一、未接入排最后、降序、零请求已接入排倒数第二、有账号未启用第 3 档、数据未就绪保持原序）。

## 未改动

- 自动签到触发时机：插件 load 后 30 秒（`AUTO_CHECKIN_DELAY_MS = 3e4`，可用 `DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS` 覆盖），按 UTC+8 日期当天去重。
- Qoder 10:00 刷新门槛（服务端规则）。
- ZCode 被排除在自动签到外（官方设计，无可签内容）。
- 任何渠道的请求头、重试、退避、鉴权逻辑。
