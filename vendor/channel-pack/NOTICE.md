# vendor/channel-pack — 上游免费渠道包的来源与再构建

本目录是 **[dsh-codearts-auth](https://gitee.com/iJetLi/deepseek-harness-codearts)**
的完整拷贝，由 `dsh-our-free-model` 的 Host 半身在独立 fiber 上挂载，
使 CodeArts、CodeBuddy、WorkBuddy、LobsterAI、Qoder、Qoder 中国版、TRAE、
Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini、OfficeAce、Accio Work 这十五个账号渠道的
登录流程、账号池、积分领取、模型黑名单与本地 OpenAI 网关可用。OFM 挂载时关闭上游 OpenCode 账号接入，原有匿名免费车道保持独立。
目录名与内部标识符在本插件的再构建中统一改为 channel-pack；出处与许可证不变。

- 上游仓库：`https://gitee.com/iJetLi/deepseek-harness-codearts`
  （上游现已更名为 **`dsh-providers-hub`**；URL 不变，作者 **Jet** / `iJetLi`）
- 吸收的提交：基线为 `345f0a07b22713c0ae189ca7d8b97ec4f64626c6`（2026-10-06）
- 作者与版权：**Jet**，MIT，© 2026 Jet（见 `LICENSE`，与上游一致）
- 本 fork 的后续跟进（模型档位、`spark-x` 上下文窗口、档位顺序、目录完整性/广播/预热）
  一律以该 gitee 上游的实测结论为准逐条移植；**它不是 fork 父仓库转手给的**，
  父仓库并未固定节奏刷新这段副本。

## 移植文件与来源钉定（2026-10-15）

本目录**不再是对 `345f0a0` 的纯拷贝**。以下文件来自 gitee 上游
`2d8deab30ecd447e58d3b92cb5cbf43380705cb0`（2026-10-15，`dsh-providers-hub` 0.2.0-rc.11），
逐文件搬入，只做了标注的本地改动：

| 文件 | 改动 |
| --- | --- |
| `officeace-*.ts`（5 个）、`dsml.ts` | 原样移植（新渠道 OfficeAce，华为云 ModelArts MaaS 云端直连）|
| `accio-*.ts`（7 个）、`model-catalog.ts`、`canonical-models.ts`、`session-title.ts` | 原样移植（新渠道 Accio Work，阿里；后三个是 Accio 的依赖）—— `accio-credits.ts` 的 `ProviderBalanceDetail` 改为**本地声明**（不搬上游 794 行的 provider-runtime 注册表），`openai-compat.ts` 补 `detailFieldText`（Accio 错误体的一条腿）|

⚠️ **移植一个带「锁定永久积分」的渠道，必须同时登记 `channel-pack-rpc.ts` 的
`PERMANENT_LOCK_PROVIDERS`** —— 上游那个 issue 的缺陷是「UI 有按钮、执行代码没有」，
而**只接执行代码、漏登记白名单是它的镜像**：写入被白名单先一步拒掉 ⇒
`index.ts` 那段锁定分道永远读不到 `true`，成为**死代码**，症状同样静默。
两侧都要可达，故 `channel-officeace-login` 套件直接经真实 RPC 断言
「写入被接受 → 读回一致 → 可取消」（把 officeace 从白名单删掉会让它变红）。
| `catalog-broadcast.ts`、`catalog-prewarm.ts` | 原样移植，仅把日志前缀 `[jet-hub]` 改为本目录的 `[channel-pack]` |
| `image-pricing.ts` | 从宿主半身搬入（见下条红线），语义逐字保留 |
| `remote-catalog-gate.ts`、`models.ts`、`service.ts`、`buddy-oauth.ts`、`buddy-auth.ts`、`buddy-adapter.ts`、`cline-models.ts`、`cline-adapter.ts`、`llm-adapter.ts`、`loomy-{product,adapter}.ts`、`raccoon-{product,adapter}.ts`、`minimax-adapter.ts`、`product.ts`、其余 6 个适配器 | 按上游 `6ad85a2`（!IKJVTF）、`0e12773`、`02653ea`、`50023bc`、`e2fec4f`、`556c81c`/`c770cf8`（cline models.dev）的实测结论**手工移植**（本目录与上游从未同仓，无法 cherry-pick）；每处的依据写在对齐的源码注释里 |

⚠️ **仍移植了 Accio 才需要的共享件**：`model-catalog.ts`（目录骨架，上游 12 个适配器 + RPC 层共用）、
`canonical-models.ts`（**本目录只用它的 `normalizeNameKey`** —— Accio 的 `modelCode` 是 `1Drift-*` 这类内部代号，
对外 id 必须归一成 slug；其余聚合车道专用部分在本 fork 是**死代码**，刻意保留原文件不裁剪以便对拍上游）、
`session-title.ts`（会话命名）。**未移植**：`provider-registry.ts` / `provider-runtime.ts` 等上游入口层
（本 fork 的 RPC 仍走既有的位置形参 + switch 形态，不消费那两张表）。

⚠️ **上游没有的、本目录独有的**（两者都来自 **fork 父仓库**，均早于本 fork 的基点 `7e3a1da`）：
`channel-fetch.ts` 的 `ChannelOutlet` 出网钩子（提交 `8d6db2f`，作者 zixin947），
与 `disableOpencode` 挂载开关（提交 `7bc8068`，作者 Ebony-Vinyl）——
gitee 上游既无 `outlet` 概念也无该开关，且它**无条件注册** OpenCode 匿名车道。
⇒ 整包换源到上游会同时丢掉这两样（详见仓库根 `docs/upstream-revendor-assessment.md`）。
- ⚠️ **本目录必须能独立再构建**：`src/` 只允许依赖 `@deepseek-ai/*` 与自身目录内的文件。
  历史上曾从宿主半身（`../../../src/image-pricing.js`）取一个常量，而那个文件随本 fork 的
  瘦身被删除 ⇒ 重建直接失败（产物早已内联该常量，故测试全绿、长期不暴露）。
  该常量已搬进本目录（`src/image-pricing.ts`）。

## 目录内容

| 路径 | 说明 |
| --- | --- |
| `src/` | 上游 TypeScript 源码，包含下述 OFM 本地适配（便于审计与再构建） |
| `pack.js` | **插件运行时实际加载的代码**：直接由 `src/` 经 `scripts/build-channel-pack.mjs` 打包成单文件（jose/undici 内联，`@deepseek-ai/*` 保持外部），使发布清单不超文件上限 |
| `qoder-auth-wasm.wasm` | Qoder 加密推理所需的 WASM，必须与 `pack.js` 同目录（`pack.js` 按 `import.meta.url` 定位它） |
| `locale/` | 上游文案 |
| `scripts/`、`tsconfig.json`、`package.json` | 再构建所需的元数据（`lib/` 与 `node_modules/` 不入库，按下面步骤重建） |

宿主提供的依赖（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-credentials`、
`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`）不在此目录，按 Node 解析规则
从安装它的 profile 的 `node_modules` 取；缺少时渠道包整体降级（`/summary.channels`
报告 `state: "failed"` 与原因），免费车道不受影响。

## 再构建

直接从受版本管理的 `src/` 打包，不使用未入库的 `lib/`：

```bash
# 在仓库外准备构建依赖，保持插件零运行依赖
npm install --prefix /tmp/ofm-channel-build --no-package-lock --ignore-scripts esbuild@0.24.2 jose@6.2.9 undici@8.11.2
mkdir -p vendor/channel-pack/node_modules
cp -R /tmp/ofm-channel-build/node_modules/jose /tmp/ofm-channel-build/node_modules/undici vendor/channel-pack/node_modules/
OFM_ESBUILD_DIR=/tmp/ofm-channel-build npm run channel-pack
# qoder-auth-wasm.wasm 沿用上游已有文件，须与 pack.js 同目录
# 清理本次创建的构建依赖；这些目录不入库、不随插件发布
rm -rf vendor/channel-pack/node_modules
```

## OFM 本地适配

- `src/index.ts`：增加可选 `disableOpencode` 挂载配置；OFM 开启它时跳过重复 OpenCode adapter、默认匿名账号和能力表预热，保留历史账号及凭据。省略时维持上游行为。
- `src/channel-pack-rpc.ts`：追加同一配置，关闭时拒绝 `opencode.*` 与通用 `account.create(provider=opencode)`。
- 打包入口改为 `src/index.ts`；宿主模块仍保持外部，jose/undici 内联。
- 构建依赖固定为 esbuild 0.24.2、jose 6.2.9、undici 8.11.2；本次重构建核对了原包的依赖代码，未借此升级运行依赖。

本目录**不含**上游的浏览器半身（`plugin-src/client`）与其设置页——
界面由 `dsh-our-free-model` 自己的三页界面取代，渠道操作经上游的
`/api/channel-pack` RPC 完成（`connection.rpc.call('/api', 'channel-pack', { method, payload })`）。
