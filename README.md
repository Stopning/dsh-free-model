# 模型接入 (Our Free Model) — channels-only fork

> **DSH 插件**（DeepSeek Harness · cordis bundle，`dsh-plugin`）——
> [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) **2.1.0** 的精简 fork。
> 只保留「把外部账号接进来」这一条车道：**十三个账号渠道 + 数据看板 + 运行日志 + 本地网关**。
> 上游的匿名免费车道、EAC 协付车道、聚合渠道、省 Token、路由与发布/更新通道全部移除。
> 设置页里的入口名是 **模型接入**（英文界面 **Model Access**）；包名与 bundle id 仍是 `dsh-our-free-model`，
> 那是宿主注册的键，改名会连带 `cordis.patch.yml`，没有收益。

## 保留了什么

四个设置页（导航栏从九页降到四页）：

| 页面 | 作用 |
| --- | --- |
| **白嫖模型接入** | 十三张渠道卡：CodeArts、CodeBuddy / WorkBuddy（国内 + 国际）、LobsterAI、Qoder / Qoder CN、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini。浏览器登录、账号池、续期、积分查询与一键领取、每日自动签到、逐模型开关、余额查询。 |
| **数据看板** | 渠道包自己的逐请求 Token 账本：今日 / 全部消耗、平均生成速度、首字延迟、缓存命中率、成功率、账号透视、模型性能表。 |
| **运行日志** | 逐条请求明细：结果、耗时、首字、速度、Token 细分；失败行悬停看原因。 |
| **网关设置** | 渠道包的本地 OpenAI 兼容网关（开关、端点、密钥、模型数）+ 本插件的局域网中继（可选绑定地址/端口、独立中继密钥、轮换）+ 出口代理分区（订阅分流或单个 http/socks5 出口）。 |

## 移除了什么，以及为什么

| 移除 | 原因 |
| --- | --- |
| **免费模型**页：匿名 opencode 车道 + Kilo 免费池 | 第三方灰产通道（伪装客户端 + 池化公共凭据），随时可能失效或改协议；不想要。 |
| **EAC 模型**页：GitHub 授权协付车道 | 依赖仓库方网关与 star 授权。 |
| **聚合渠道**页（76 家自带 Key 的提供商） | 与插件自己的模型适配器（`src/adapter.js`）绑定，随它一起移除。 |
| **省 Token**页 | 压缩管线（RTK / 提示词瘦身 / 本地应答）跑在同一个适配器里。 |
| **路由**页（combo 降级链） | 由同一个适配器提供。 |
| 公告中心、自更新、热重载 | 上游发布清单签名验不过；一个 fork 也不该让别人替你换掉本机字节。 |
| 本地转发（18899）与局域网转发 | 转发的正是被删掉的那条车道。 |
| `packages/standalone/`（独立 Web 产品）、`worker/`（EAC 的 Cloudflare 授权网关）、`feed/` + `catalog/`（公告源与发布清单） | 三块卫星全部 `import` 被删车道，留着就是一套永远跑不起来的代码。 |

规模变化：`src/` 从 **58 个模块 → 5 个**（`store/key/chan-relay/egress/trust`），宿主 `index.js` 从 **2343 行 → 684 行**，离线测试从 45 个套件 → 8 个。

## 安装

**命令行（纯 dsh web）**

```
dsh plugin --profile web add /绝对路径/dsh-free-model
```

安装后重启应用一次。`--profile` 填实际使用的 profile 名。

**DSHEAC AIO / 桌面端**：桌面端启动 web 前有一道 profile 闸门，只放行 dsh 自己在
`.dsh-module-fallback` 下生成的链接；profile 目录树里出现任何其它符号链接或 junction
会直接拒绝启动（`PROFILE_UPGRADE_REQUIRED`）。所以**不要用 `link:` 依赖、不要建 junction**，
用应用内插件管理器，或放一个真实目录：

1. 把仓库内容复制到 `<profile>/node_modules/dsh-our-free-model/`
   （必需：`index.js`、`client.js`、`src/`、`vendor/channel-pack/`、`locale/`、`icon.svg`、
   `cordis.patch.yml`、`package.json`；上游文档里的 `adapter/` 在本 fork 已不存在）
2. `dependencies` 里写 `"dsh-our-free-model": "2.1.0"`（跟随 `package.json` 的 `version`），不要写 `link:`
3. `dsh.profile.bundles` 末尾追加 `"dsh-our-free-model"`

不要再往 `cordis.patch.yml` 加条目：被 `dsh.profile.bundles` 引用的包，其自带 patch 层会自动生效，
两处同时注册会报 `duplicate loader entry id: our-free-model`。

### 覆盖安装到一个已经装过上游版本的 profile

profile 是 `nodeLinker: hoisted` 时，`node_modules/dsh-our-free-model/` 是**真目录**，
直接换内容即可（不动 `dependencies`：`^2.0.0` 已经匹配 2.1.0）：

```bash
P=~/.dsh/profiles/web/node_modules/dsh-our-free-model
cp -a "$P" ~/backup/files/dsh-our-free-model-2.0.0-web-install-$(date +%Y%m%d)   # 先留回滚副本
rm -rf "$P"; mkdir -p "$P"
# 从 fork 复制：index.js client.js package.json cordis.patch.yml icon.svg LICENSE README*.md src/ locale/ vendor/
```

两点注意：

- **宿主半身是进程内的**：换完文件要重启一次 dsh 才会加载新的 `index.js`；浏览器半身刷新页面即可（同版本客户端会被重新取用）。
- **回滚**：把备份拷回去，或让 pnpm 按 lockfile 的 integrity 重新取 2.0.0。反过来说，**下次在这个 profile 里跑 `pnpm install`（例如插件管理器装/卸别的插件）会把 `node_modules` 按 lockfile 对齐，把你手工替换的 fork 覆盖回 registry 版 2.0.0** —— 要长期固化，得把这个 fork 发到某个 registry，或在 profile 里用 `file:`/`link:` 依赖（桌面端闸门不接受软链，命令行 web 可以）。

## 配置

唯一的状态文件是 `~/.dsh/our-free-model/settings.json`（0600）。本 fork 只读这三个键：

```json
{
  "egress": {
    "enabled": false,
    "mode": "subscription",
    "url": "",
    "mihomoPath": ""
  },
  "chanGateway": {
    "relay": { "enabled": false, "host": "127.0.0.1", "port": 18326, "key": "" }
  }
}
```

2.1.0 写下的其它键（`enabled`、`forward`、`tokenSaver`、`aggregate`、`combos`、
`announcementsAcked`…）会被原样保留但不再生效——`JsonStore` 把文件合并到默认值之上，
所以你已有的出口地址与中继密钥在升级时不会丢。

### HTTP 面

全部经信任围栏，前缀 `/api/our-free-model`：

```
GET  /summary              四个页面要的文档（settings.egress / channels / version / outlet）
GET  /outlet               当前出口节点与延迟（读数，失败也只是缺读数）
GET  /egress/url           订阅地址本身——只在页面点「显示/复制」时读
POST /settings             只接受 egress 分区
GET  /chan-gateway         中继与网关状态（不含密钥）
POST /chan-gateway/apply   改绑定地址/端口
GET  /chan-gateway/key     中继密钥（按需读）
POST /chan-gateway/rotate  轮换中继密钥
```

数据看板与运行日志**不经过这里**：渠道包自己持有逐请求账本，浏览器半身直接走 shell 的
`connection` RPC（`usage.tokenLedger` / `usage.tokenLedgerHistory`）。

## 安全

- **凭据**：账号 token 进渠道包自己的凭据目录，页面永远拿不到明文；订阅地址按凭据对待，只在点「显示」时读取，常规 payload 里只有打码后的 host。
- **局域网中继是唯一对外监听**：默认关；开启后必须用独立的中继密钥（与本机网关密钥不通用）。**能连上这台机器的人都能消耗你的渠道额度**——只在可信网络启用，必要时用防火墙限制来源网段。
- **信任围栏**：插件路由优先级高于内核 `/api`，所以内置了与内核一致的准入检查——优先复用 composition 的 `connection` 服务，缺失时退回结构化围栏（Host 必须回环、拒绝跨站标记、Origin/Referer 必须同源）。
- 本 fork 不再向任何上游插件地址发请求：出口只剩模型 provider（以及你启用的出口代理）。
- **出网面审计**：见 [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md)——13 家渠道的域名与 TLS 证书主体、两处不带凭据的第三方调用、本地暴露面与已知风险；复跑 `node scripts/egress-audit.mjs --tls`（只读）。

## 测试

```bash
npm test                            # 8 个离线套件，无需网络、不花额度
node scripts/host-smoke-test.mjs     # 只跑宿主 HTTP 面
node scripts/client-lint.mjs         # 只跑浏览器半身（字典键一一对应 + CSS 规则可达）
```

| 套件 | 覆盖 |
| --- | --- |
| `client-lint` | 浏览器半身：注册、双语字典键一一对应且无冗余、每条 CSS 规则可达、发出的 `ofm_*` 类都有定义 |
| `host-smoke` | 宿主 HTTP 面全量：四个页面的数据、出口校验、中继密钥生成/轮换/落盘、**被删路由必须 404** |
| `trust` / `chan-relay` / `egress` | 三个宿主模块各自的契约 |
| `channel-pack` / `channel-network` | 渠道包挂载、十三个 provider 注册、积分、图片计价、代理与 OAuth 生命周期 |

上游的 45 个套件里，其余的都在测被删掉的车道，已一并移除。

## 渠道包

`vendor/channel-pack/` 是一个完整子项目（有自己的 `package.json`、TypeScript 源码、
测试与构建脚本），`pack.js` 是它的打包产物：

```bash
npm run channel-pack      # 从 vendor/channel-pack/src 重新打包（需要 esbuild）
```

来源、授权与改造说明见 `vendor/channel-pack/NOTICE.md`。

## 许可

本仓库 MIT（见 `LICENSE`）；渠道包部分见 `vendor/channel-pack/LICENSE` 与 `NOTICE.md`。
所有渠道账号、额度与积分规则归各提供商所有，请遵守各自的服务条款。
