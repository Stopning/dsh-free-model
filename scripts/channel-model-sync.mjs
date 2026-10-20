/**
 * 模型数据块同步器 —— 把 `vendor/channel-pack/src/*-product.ts` 里被
 * `// OFM-MODELS:BEGIN <file>::<CONST> …` / `// OFM-MODELS:END` 标记的
 * 模型数据块，与 gitee 上游的**同名常量**对拍（默认只读）或整段同步（--apply）。
 *
 *     node scripts/channel-model-sync.mjs                    # 只读对拍
 *     node scripts/channel-model-sync.mjs --apply            # 差异块整段替换为上游
 *     node scripts/channel-model-sync.mjs --upstream DIR     # 指定上游工作树（默认 /tmp/upstream-hub）
 *     node scripts/channel-model-sync.mjs --only officeace-product.ts
 *
 * ## 输入 / 输出（契约）
 *
 * - 输入①：本仓库 `vendor/channel-pack/src/` 里带标记的文件（标记行自带
 *   `<file>::<CONST>`，上游侧按同名常量定位）。
 * - 输入②：上游工作树（`dsh-providers-hub` 的 checkout；上游**没有**标记）。
 * - 输出：stdout 每块一行 `same / DIFF / missing-upstream / BROKEN-MARKER`；
 *   `--apply` 时把差异块的「注释+声明+数据」整段换成上游对应段（逐字节，
 *   不做本地改写 —— 上游注释是取证的依据，值得留）。
 * - 边界：只动标记块内部；BEGIN/END 两行保留（上游没有它们，替换时跳过）。
 *   **不做** git 操作、不重建 `pack.js` —— 改完自己跑
 *   `node scripts/build-channel-pack.mjs` 与 `node scripts/test-all.mjs`。
 * - 退出码：0＝全 same 或已 apply；2＝有 missing/BROKEN（标记或上游常量对不上，
 *   必须人工处理，不能装没看见）。
 *
 * ## 为什么按「标记块」而不是整文件拷贝
 *
 * 上游同名文件里还有本 fork 不消费的东西（新渠道、provider-registry 等），
 * 整文件覆盖会一并带进来。标记把「可照抄的数据」与「本地接线」切开：
 * 数据照抄、接线不动。**这就是加标记的全部意义** —— 未来更新直接对照标记复制。
 *
 * ## 对拍判据：剥注释后比数据行
 *
 * 上游大量改动只是取证注释（数据没变）；只比数据行避免「注释噪声」假报。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const srcDir = path.join(root, 'vendor', 'channel-pack', 'src')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const upstream = argv.includes('--upstream')
  ? argv[argv.indexOf('--upstream') + 1]
  : '/tmp/upstream-hub'
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined

if (!existsSync(path.join(upstream, 'src'))) {
  console.error(`channel-model-sync: 上游工作树不存在：${upstream}`)
  console.error('  git clone --depth 300 https://gitee.com/iJetLi/deepseek-harness-codearts.git /tmp/upstream-hub')
  process.exit(2)
}

/** 从 BEGIN 标记行提取 `<file>::<CONST>`（格式不符返回 null ⇒ BROKEN-MARKER）。 */
function markerName(line) {
  const m = line.match(/OFM-MODELS:BEGIN\s+(\S+?)::(\S+?)（/)
  return m ? { file: m[1], constName: m[2] } : null
}

/**
 * 定位 `const NAME … = [` 到收尾 `]` 的行区间，并回溯紧邻的注释块起点。
 * 输入行数组，返回 `{ cstart, end }`（闭区间）或 null。
 */
function locateBlock(lines, constName) {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`(const|export const)\\s+${constName}\\b`).test(lines[i])) { start = i; break }
  }
  if (start < 0) return null
  let end = -1
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\](\s+as\s+const)?\)?;?$/.test(lines[j].trim())) { end = j; break }
  }
  if (end < 0) return null
  let cstart = start
  for (let k = start - 1; k >= 0 && (/^\s*\*/.test(lines[k]) || /^\s*\/\*\*/.test(lines[k])); k--) cstart = k
  return { cstart, end }
}

/** 剥注释行（`*` / `//` / `/*` 开头），只留数据。 */
const stripComments = (lines) => lines.filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))

let same = 0, diff = 0, missing = 0
const diffs = []

for (const f of readdirSync(srcDir).filter((n) => n.endsWith('.ts'))) {
  if (only !== undefined && !f.includes(only)) continue
  const ourLines = readFileSync(path.join(srcDir, f), 'utf8').split('\n')
  for (let i = 0; i < ourLines.length; i++) {
    if (!ourLines[i].includes('OFM-MODELS:BEGIN')) continue
    const mk = markerName(ourLines[i])
    if (mk === null) { console.log(`BROKEN-MARKER     ${f}:${i + 1} BEGIN 行解析失败`); missing++; continue }
    const label = `${f}::${mk.constName}`
    const upPath = path.join(upstream, 'src', mk.file)
    if (!existsSync(upPath)) { console.log(`missing-upstream  ${label}（上游无 src/${mk.file}）`); missing++; continue }
    const ours = locateBlock(ourLines, mk.constName)
    if (ours === null) { console.log(`BROKEN-MARKER     ${label}（标记块内找不到声明）`); missing++; continue }
    // END 行：从块起点向后找（BEGIN 行本身在 cstart-1 之前，locateBlock 的 cstart 是注释起点）
    let ourEndMarker = -1
    for (let j = i; j < ourLines.length; j++) {
      if (ourLines[j].includes('OFM-MODELS:END')) { ourEndMarker = j; break }
    }
    if (ourEndMarker < 0) { console.log(`BROKEN-MARKER     ${label}（缺 END 行）`); missing++; continue }
    const upLines = readFileSync(upPath, 'utf8').split('\n')
    const ups = locateBlock(upLines, mk.constName)
    if (ups === null) { console.log(`missing-upstream  ${label}（上游 ${mk.file} 无此常量）`); missing++; continue }
    const ourData = stripComments(ourLines.slice(ours.cstart, ourEndMarker)).join('\n')
    const upData = stripComments(upLines.slice(ups.cstart, ups.end + 1)).join('\n')
    if (ourData === upData) { same++; console.log(`same              ${label}`); continue }
    diff++
    console.log(`DIFF              ${label}`)
    diffs.push({ f, mk, beginLine: i, ours, ourEndMarker, upLines, ups })
  }
}

if (APPLY) {
  // 按文件分组、同文件内从后往前替换（避免行号漂移）。
  const byFile = new Map()
  for (const d of diffs) {
    if (!byFile.has(d.f)) byFile.set(d.f, [])
    byFile.get(d.f).push(d)
  }
  for (const [f, list] of byFile) {
    const lines = readFileSync(path.join(srcDir, f), 'utf8').split('\n')
    for (const d of list.sort((a, b) => b.beginLine - a.beginLine)) {
      const replacement = d.upLines.slice(d.ups.cstart, d.ups.end + 1)
      // 保留 BEGIN 行（d.beginLine）与 END 行（d.ourEndMarker），只换中间段。
      lines.splice(d.beginLine + 1, d.ourEndMarker - d.beginLine - 1, ...replacement)
      console.log(`applied           ${d.f}::${d.mk.constName}`)
    }
    writeFileSync(path.join(srcDir, f), lines.join('\n'))
  }
}

console.log(`\nchannel-model-sync: ${same} same / ${diff} ${APPLY ? 'applied' : 'DIFF'} / ${missing} missing`)
if (diff > 0 && !APPLY) console.log('（--apply 可把差异块整段同步为上游；改完记得重建 pack.js 并跑测试）')
process.exit(missing > 0 ? 2 : 0)
