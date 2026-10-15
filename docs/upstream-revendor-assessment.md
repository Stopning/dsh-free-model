# 上游再吸收评估：3a 追加渠道 / 3b 整包换源 / 3c 外科手术

> 对象：本 fork（`dsh-free-model`，分支 `slim-channels-only`）与两个上游的渠道包差异。
> 写作日期：2026-10-15。**本文全部结论来自只读检查（读文件 / grep / `git log`），未跑任何构建或测试。**

## 结论 / 怎么做 / 坑

- **结论**：默认继续 **3c（外科手术）**；**3a（追加 Accio / OfficeAce）** 是可选增量且**在范围内**（两者都是账号登录渠道，不是被删掉的免费车道）；**3b（整包换源到 `0.2.0-rc.11`）现在不值得**。
- **怎么做**：3c 照旧按 Tier 1 / Tier 2 逐项移植；要新渠道时按 3a 单独立项，**先做一个渠道的小样**（登录跑通 + 一条推理 + 一次续期）再铺第二个。
- **坑 1**：`Ebony-Vinyl/dsh-our-free-model` **不是渠道包的数据源** —— 自我们的基点以来它只动了渠道包 3 个文件，且 `NOTICE.md` 仍钉在 `345f0a0`（未从 gitee 刷新）。渠道与模型数据只能从 gitee 上游读。
- **坑 2**：3b 的拦路石是**三个已核实的事实**：RPC 命名空间改名（`src/` 内 511 处 / 55 文件）、`disableOpencode` 挂载选项消失、`outlet` 配置消失。前两个决定「改不改得动」，第三个决定「改完还守不守得住出网审计」。
- **坑 3**：`canonical-models.ts` 与 `model-catalog.ts` 在上游**主要为聚合 / 自动车道服务**；本 fork 两条车道都没有，整文件照搬会变成死代码。
- **未核实**：上游 `apply(ctx)` 是否另有替代 `outlet` 的扩展点（只按字面量 grep 过）；Accio / OfficeAce 的线上可用性与额度规则；3a 的客户端（设置页）工作量。

## 一、两个上游各管什么

| | ① Fork 父仓库 | ② 渠道包真上游 |
| --- | --- | --- |
| 位置 | `upstream` = `github.com/Ebony-Vinyl/dsh-our-free-model`（本地 ref `upstream/main`） | `gitee.com/iJetLi/deepseek-harness-codearts`，上游已改名 `dsh-providers-hub`；本地完整克隆 `/tmp/gitee-cp` |
| 我们的基点 | `7e3a1da` = **v2.1.0** | `345f0a0`（2026-10-06，见 `vendor/channel-pack/NOTICE.md`） |
| 当前 | `ac4c55e` = **v2.3.0** | `2d8deab`（2026-10-15）= **0.2.0-rc.11** |
| 差距 | 全仓 112 文件 / +10003 −1112 | `src/` 123 文件 / **+40441 −4859**，238 个提交 |
| **渠道包内的改动** | **仅 3 个文件**：`vendor/channel-pack/pack.js`、`src/openai-gateway/messages.ts`、`src/openai-gateway/responses.ts`（+15 −21） | 全部渠道与模型逻辑 |
| 那些改动是什么 | 网关自造消息的来源身份（新增 `gatewaySource()`，PR #229）；另有一条 `src/catalog.js` 的 URL 改动 | Accio / OfficeAce 两个新渠道、聚合 / 自动车道、provider 元数据层等 |
| **能不能当渠道数据源** | **不能** —— 父仓库自基点以来**没有**从 gitee 刷新过它的 vendored 副本（`NOTICE.md` 仍写 `345f0a0`，且 `vendor/channel-pack/src` 下没有 `accio-*` / `officeace-*` / `canonical-models.ts` / `model-catalog.ts`） | **能** —— 唯一真源 |

补充一条易踩的：父仓库那条 `src/catalog.js`（`/zen/v1/models` → `/inference/v1/models`）**对本 fork 无意义** —— `src/catalog.js` 属于父仓库的宿主半身，已被本 fork 的瘦身删除（本 fork 的 `src/` 只剩 `chan-relay.js` / `egress.js` / `key.js` / `store.js` / `trust.js`）。

## 二、3a — 追加两个登录渠道

### 执行结果（2026-10-15）：**两个渠道都做了**（先 OfficeAce 小样，再 Accio）

| 项 | 结果 |
| --- | --- |
| OfficeAce | **已移植并接线**：6 个文件（`officeace-*` × 5 + `dsml.ts`）+ 适配器注册 + 锁定分道 + 登录 RPC（`account.create` / `login.poll`）+ 单账号续期 + 余额查询 + 客户端卡片。登录闭环走**真实 RPC 路由**验证（`channel-officeace-login` 套件），锁定执行路径单独锁（`channel-officeace-lock`）。|
| Accio | **已移植并接线**：10 个文件（`accio-*` × 7 + `model-catalog.ts` + `canonical-models.ts` + `session-title.ts`） + 适配器注册 + 登录 RPC + 单账号续期 + 自动续期表 + 余额查询（含 `extra.accountTier`）+ 客户端卡片。**原估的「独立一档工作量」偏悲观**：`createModelCatalog` 的 deps 只有一个可选 `accountPool`，整搬即可、**不需要重构既有 13 家**（它们继续用自己的 `listModels`/`resolveModel`），`canonical-models.ts` 也只有 `normalizeNameKey` 被消费。|
| 一处流程教训 | 接线**必须逐条读上游对应分支**再改写。本轮我跳过这步自己写，结果插错 `case`（`productById(req.provider)` 这个锚点在 `credits.status` 与 `credits.balances` **两处都有**，`replace(…,1)` 命中了前者），且把 `fetchAccioBalanceDetailed` 已带回的 `extra` 丢了 —— 两个都是**端到端测试**抓出来的（esbuild 不做类型检查，插错 case 照样构建成功）。|
| 一处上游陷阱（移植时踩到） | 上游 `persistLogin(credential, { refName, credentials })` 是**模块级函数**且第 2 参带 `CredentialStore`，与其余渠道 Service 的 `persistLogin(credential, { refName })` **签名不同** —— 照抄 gemini 的调用形态会静默失败。已在 RPC 注释里标注。|

### 加什么

| 渠道 | 新增文件（上游 `src/`） | 行数 | 模型 | 登录形态 |
| --- | --- | --- | --- | --- |
| **Accio**（阿里 Accio Work） | `accio.ts`、`accio-adapter.ts`、`accio-auth.ts`、`accio-credits.ts`、`accio-messages.ts`、`accio-oauth.ts`、`accio-product.ts` | 4363 | 兜底表 **15** 个，全部是内部代号（`1Chronos-*` / `1Drift-*` / `1Nexus-*` / `1Nova-*` / `1Orbit-*` / `1Synapse-*` / `1Zenith-*`），真名只在 `modelDisplayName` | 标准 OAuth 2.0 + PKCE，公开客户端 `accio-work`（无 secret），回调落本机 loopback |
| **OfficeAce**（华为 ModelArts MaaS） | `officeace-adapter.ts`、`officeace-auth.ts`、`officeace-credential-health.ts`、`officeace-lock.ts`、`officeace-product.ts` | 3119 | `OFFICEACE_MODELS` **8** 条：`glm-5.1/5.2/5.3`、`deepseek-v4-flash`、`deepseek-v4.1-flash`、`kimi-k2.6`、`qwen3-30b-a3b`、`qwen3-32b` | 华为云 OAuth（PKCE + DPoP），凭据自持 `~/.dsh-officeace/session.json`，**不需要**装 OfficeAce 客户端 |

两者都是**账号登录**渠道，与本 fork「只保留账号渠道」的车道定义一致；共 12 个文件 / 7482 行（仅服务端）。

### 代价（比文件数更麻烦的部分）

- **`model-catalog.ts`（343 行）是 Accio 的硬依赖**：`accio-adapter.ts:57` 用 `createModelCatalog`，并依赖 `CatalogEntry` 类型。上游有 **12 个**适配器调 `createModelCatalog`，本 fork **一个都没有** —— 各适配器自己实现 `listModels` / `resolveModel`。⇒ 要么整文件移植并顺带重构既有的 13 家（大改），要么给 Accio 写一份本地变体（从此与上游分叉）。**OfficeAce 不走这条路**（它的适配器只在一个注释里提过 `model-catalog`，没有 import）。
- **`canonical-models.ts`（360 行）大部分是死的**：上游只有两个消费者 —— `aggregate-catalog.ts` 用 `canonicalKeyFor` / `canonicalDisplayName`，`accio-adapter.ts` 只用 **`normalizeNameKey` 一个函数**。本 fork 没有聚合车道 ⇒ 真正要搬的只有 `normalizeNameKey` 及其依赖 `normalizeModelKey`（约 50 行）；`channelOf` / `PRIMARY_CHANNEL`（含 `accio: 'name'`）/ `CANONICAL_OVERRIDES` / `EXCLUDED_ALIASES` / `canonicalKeyFor` 全是聚合专用。
  - ⚠️ 但 `normalizeNameKey` **在 3a 里仍然必需**，理由与聚合无关：Accio 的对外 `id` 必须是展示名归一后的 slug（`qwen-3-8-flash`），否则 DSH 会把 `1Drift-F8hS3mK7pL2n` 这种乱码注入给模型当身份（`accioModelIdOf` 的注释即为此）。上行请求仍须发 `modelCode`，故需要一张 slug → `modelCode` 的反查。
- **缺哪些上游模块，要分清「硬依赖」与「顺带」**（本 fork 这些文件全无）：
  - **硬依赖（运行时 import，绕不开）**：`dsml.ts` —— `officeace-adapter.ts:24` 直接 `import { buildDsmlSystemPrompt, needsDsmlToolMode }`，本 fork 没有这个文件。
  - **类型依赖（可本地声明最小形状）**：`accio-credits.ts:77` 从 `provider-runtime.js` 取 `ProviderBalanceDetail` 类型。
  - **顺带（被 `src/index.ts` / `src/jet-hub-rpc.ts` 这些**上游入口** import，若按 3a 只追加两个渠道、不搬上游入口，则未必需要）**：`provider-registry.ts`（472 行）、`provider-runtime.ts`（794）、`provider-credits.ts`（540）、`provider-expiry.ts`（123）、`credential-resolver.ts`（505）。⚠️ 但上游的 Accio 注册块**用**了 `createCredentialResolver`（`src/index.ts:51`）—— 移植时要么搬它，要么按本 fork 既有的 `resolveCredential` 形态改写。**这一点未逐行核实**。
- **客户端也要动**：上游 `plugin-src/client/` 里 Accio 触及 `credits-capabilities.js` / `credit-expiry.js` / `new-account.js` / `provider-icons.js` / `jet-hub-styles.js`，OfficeAce 触及 `credits-capabilities.js` / `provider-icons.js` / `jet-hub-styles.js`。本 fork 的 `client.js` 是**手写单文件、无构建**，这部分工作量**未核实**。

### 验收标准（建议）

逐条状态（2026-10-15，只做了 OfficeAce）：

1. ✅ **OfficeAce 卡片出现，登录闭环经真实 RPC 验证**（`channel-officeace-login`：
   authorize URL 含 PKCE `SHA-256` + 公开 `client_id` → poll 换 token → 凭据落库 →
   `done:true, success:true`；重复 poll 不把已成功的登录判成失败）。
   ✅ Accio 同样经真实 RPC 验证（`channel-accio`：授权页 → 本地回调 → 换 token → 按账号 ref 落库）。
2. ✅ 账号池 / 单账号续期（走池、不回落全局凭据）/ 逐模型开关与既有渠道同形。
   ⬜ Accio 的 `refresh_token` 轮换 + per-`credentialRef` 串行未涉及。
3. ✅ Accio 的对外 id 走 `normalizeNameKey` 归一（其 `modelCode` 是 `1Drift-*` 这类内部代号），
   上游请求仍发 `modelCode` —— 由 `accio-adapter.ts` 自身实现，本 fork 原样搬入未改。
4. ✅ 只暴露 `OFFICEACE_MODELS` 的 8 条；图片准入的**实测表**已断言
   （只有 `deepseek-v4.1-flash` 与 `kimi-k2.6` 的 `multimodal` 为真）。
   ⚠️ 说明：适配器的闸门 `isMultimodalModel()` 是**私有**函数且**只读这张表**、
   没有第二份判据 ⇒ 断言表即锁住闸门（这正是「单一真相源」想要的形状）。
5. ✅ 审计已同步：`SECURITY-AUDIT.md` 新增 OfficeAce 一行（三家主机 + 实测 TLS 主体，
   均为 GlobalSign RSA OV），渠道数 13→14，三个产物指纹回填并经脚本核对；
   `egress-audit.mjs` 复跑显示主机面 53 → **56**（新增
   `officeace.cn-southwest-2.huaweicloud-agentarts.com`、
   `agentarts.cn-southwest-2.myhuaweicloud.com`、`api.modelarts-maas.com`）。
   ✅ Accio 的三家主机已入表（`phoenix-gw.alibaba.com` / `www.accio-ai.com` / `zh.accio.com`，
   实测 TLS 主体 `*.alibaba.com` / `*.accio-ai.com` / `*.accio.com`，均 GlobalSign OV）。
   主机面 53 → 56 → **60**（`node scripts/egress-audit.mjs` 实测输出）。
6. ✅（新增一条）**锁定链两侧可达**：执行分道（`channel-officeace-lock`）+
   白名单登记（`PERMANENT_LOCK_PROVIDERS`，由 `channel-officeace-login` 经真实 RPC 断言）。
   见 `vendor/channel-pack/NOTICE.md` 的「镜像陷阱」。

## 三、3b — 整包换源到 `dsh-providers-hub` 0.2.0-rc.11

### 已核实的拦路石

| # | 拦路石 | 证据 | 怎么核实的 |
| --- | --- | --- | --- |
| 1 | **RPC 命名空间 / 端点改名** | 本 fork `channel-pack-rpc.ts:231` `CHANNEL_PACK_API_PATH = '/api/channel-pack'`、`:242` `CHANNEL_PACK_ENDPOINT = 'channel-pack'`；上游 `src/jet-hub-rpc.ts:285` `JET_HUB_API_PATH = '/api/jet-hub'`、`:296` `JET_HUB_ENDPOINT = 'jet-hub'`。浏览器半身 `client.js:1465` 调 `connection.rpc.call('/api', 'channel-pack', …)` —— 这个字符串必须改 | 读两个文件 + 常量名比对 |
| 2 | **改名的规模** | 上游 `src/`（仅 `*.ts`）里 `jet-hub\|JET_HUB\|JetHub` = **511 处 / 55 个文件**（`grep -rIo` 计数）；全仓（排除 `.git`）= 1883 处。本 fork 的 `channel-pack` 命名来自提交 `7bc8068`（183 文件，含 `pack.js` 重构建） | grep 计数 + `git show --stat 7bc8068` |
| 3 | **`disableOpencode` 挂载选项已不存在** | 本 fork：`vendor/channel-pack/src/index.ts` 的 `apply(ctx, config: { disableOpencode?: boolean; outlet?: ChannelOutlet } = {})`，宿主 `index.js:159` 传 `true`，包内同一文件里 `if (config.disableOpencode !== true)` 据此跳过 OpenCode（`channel-pack-rpc.ts:884` / `:984` 也收这个开关）。上游：`export function apply(ctx: Context): void`（`src/index.ts:611`）**没有 config 形参**，全树 grep `disableOpencode` = **0 命中**，OpenCode 在 `src/index.ts:2572` **无条件注册** | 读文件 + 全树 grep（0 命中） |
| 4 | **`outlet` 配置已不存在** | 本 fork：`ChannelOutlet` 接口在 `channel-fetch.ts:9`，`index.js:160` 传 `outlet: { active: egressActive, fetch: egressFetch }` —— 这是本插件把渠道包流量导进自己出口的唯一钩子。上游：全树 grep `outlet` = **0 命中**、`ChannelOutlet` = **0 命中**，且 `src/channel-fetch.ts` **根本不存在** | 全树 grep（0 命中）+ 文件存在性检查 |
| 5 | **RPC 入口签名重写** | 本 fork `registerChannelPackRpc(ctx, pool, codearts, buddy, workbuddy, lobsterai, qoder, qoderCn, trae, cline, loomy, raccoon, minimax, zcode, gemini, modelAdapters?, config?)` —— **15 个位置形参**；上游 `registerJetHubRpc(ctx, pool, auths: JetHubAuths, modelAdapters?)` —— **命名对象** | 读两处签名 |
| 6 | **设置页契约变化** | 本 fork `client.js:2510` 注册 `settings.section`，id `our-free-model`；上游 `plugin-src/client/index.js:99` id `jet-hub`、label `Jet Hub` | grep |
| 7 | **浏览器半身形态不同** | 本 fork `client.js` **220283 B / 2523 行，手写、无构建**（仓库里只有 `scripts/build-channel-pack.mjs` 打渠道包，没有前端构建）；上游 `plugin-src/client/*.js` 26 个模块经 esbuild（`plugin-src/client/build.mjs`）打成 `lib/client/jet-hub.js`（**353053 B**） | 文件读取 + 字节/行数计数 |
| 8 | **渠道数会涨** | 本 fork 13 个渠道（`client.js` 的 13 张卡）；上游 `src/provider-registry.ts` 有 **17 个 id**：既有 13 + `opencode` + `officeace` + `accio` + `aggregate`，另有自动车道 `auto` | grep 计数 |

### 一条好消息

`src/settings-compat.ts` 在两侧**只差 2 行品牌字符串**（注释里的「Jet Hub」与 `effect` 标签），其余逐字相同 —— 这个契约面风险很低。

### 什么情况下 3b 才值得

- 每版逐项移植的**人工成本**超过一次重做（例如一个上游版本要移植十几处、且每处都要重新读上游注释与实测依据）；
- 或者我们决定**连聚合 / 自动车道一起要** —— 那等于重新裁定本 fork「只留账号车道」的范围，是一次产品决策，不只是技术搬运；
- 或者上游**重新提供**了挂载选项契约（或在 3b 里接受丢掉 `disableOpencode` / `outlet`，另写一层挂载后补丁把它们补回来）。
- 反过来说：只要 `disableOpencode` 与 `outlet` 上游不给，3b 就**不是「一次性重做」而是「重做 + 永久失去两项控制」** —— 前者是成本，后者是能力倒退。

## 四、3c — 外科手术（本次实际做法，作为对照基线）

以下为**截至本文更新时的工作树状态**（未提交修改 / 未跟踪文件），不是已发布版本：

| 层级 | 内容 | 落点 |
| --- | --- | --- |
| Tier 1 | WorkBuddy **五档**思考档位（`low` / `medium` / `high` / `xhigh` / `max`，默认仍 `high`），依据是真实登录态实测五档全部 HTTP 200 且有真实 `reasoning_content`，拼错的档位被服务端拒（HTTP 400 `code:11133`） | `vendor/channel-pack/src/product.ts` |
| Tier 1 | Loomy `spark-x` 上下文窗口 **262144**（远端虚报 1048576，真实墙在 256K，越界时上游收下请求但 0 输出）；覆盖表落在**远端与兜底两条路径**上 | `loomy-product.ts`、`loomy-adapter.ts` |
| Tier 1 | 档位展示顺序改为**弱 → 强**（codearts / minimax / raccoon）；`defaultEffort` 与数组位置解耦 | `llm-adapter.ts`、`minimax-adapter.ts`、`raccoon-adapter.ts`、`raccoon-product.ts`、`llm-register-compat.ts` |
| Tier 2 | 目录完整性 / 变更广播 / 冷启动有界预热；**短路判据从「已定义」改成「已完整」**（否则残缺目录永久固化） | 新增 `catalog-broadcast.ts`、`catalog-prewarm.ts`；改 `remote-catalog-gate.ts`、`models.ts`、`service.ts`、`buddy-{oauth,auth,adapter}.ts`、`cline-{models,adapter}.ts` 及另外 6 个适配器的广播钩子 |
| Tier 2 | Cline 的 models.dev 目录健壮化：`Accept-Encoding: br, gzip`、ETag 条件请求、**304 回退成上次结果**、超时 20s→60s、`supportsImage: false` 保真 | `cline-models-dev.ts` |
| 随带修复 | 渠道包**恢复可独立再构建**：`image-pricing` 常量从已删除的宿主半身搬进渠道包（此前重建直接失败，而产物早已内联该常量 ⇒ 长期不可见） | 新增 `src/image-pricing.ts`；改 `llm-register-compat.ts` |
| 说明 | 网关消息 source 身份**两条上游给了不同答案**（父仓库 `plugin:…` 前缀 vs gitee 裸 kind + `declare module`）；本 fork 取 gitee 侧，依据是装着的 `dsh-llm` 契约与全仓增强口径 | `openai-gateway/messages.ts`、`responses.ts` |

对照意义：Tier 1 + Tier 2 全部改动集中在**渠道包的少数文件**上，diff 小、每处都能指回一条实测依据；
代价是**每处都要手搬**，且必须直接读 gitee 上游（父仓库帮不上忙）。
测试从 8 套增至 **13 套**，关键改动都做了**变异测试**（改回缺陷形态确认用例变红）。

## 五、怎么选

1. **默认 3c。** 只要上游还在改渠道与模型数据，就继续逐项移植；每项移植都带实测依据与注释，这棵树我们看得懂。
2. **3a 作为可选增量。** 有真实需求（要用 Accio / OfficeAce）时立项；先做单渠道小样。注意它**不只是复制 12 个文件** —— 还要处理 `model-catalog.ts` 的分叉决策、`normalizeNameKey` 的最小搬运、`dsml.ts` 等缺失模块，以及手写 `client.js` 的设置页。
3. **3b 暂缓。** 触发条件见上节三条。**在此之前不要为了「更新」而更新** —— 换源会把 `disableOpencode`（挡住 OpenCode 匿名车道回流）和 `outlet`（出网审计的唯一钩子）一起丢掉。
4. **无论选哪条，父仓库都只用来取宿主半身的修复**（如网关消息来源身份），渠道包数据一律以 gitee 上游为准。
