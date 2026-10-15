/**
 * 缺少厂商视觉计价协议时的同步估算。
 *
 * ## 为什么在本目录（而不是 `src/` 的宿主半身）
 *
 * 本模块原先住在**宿主半身** `src/image-pricing.js`，由 `llm-register-compat.ts`
 * 经 `../../../src/image-pricing.js` 引用。那在**上游仓库**里成立（宿主与渠道包
 * 同仓），但在**本 fork** 里不成立：
 *
 * 1. 本 fork 把宿主半身裁到只剩渠道车道（commit「slim: keep only the
 *    account-channel lane」），`src/image-pricing.js` **被删除**；
 * 2. 而 `vendor/channel-pack/` 是**可独立再构建**的子树（见 `NOTICE.md`），
 *    它的 `src/` 只允许依赖 `@deepseek-ai/*` 与自身目录内的文件；
 * 3. ⇒ 删除宿主半身后，渠道包的**再构建**（`npm run channel-pack`）直接失败：
 *    `Could not resolve "../../../src/image-pricing.js"`。
 *
 * 该缺陷**长期不可见**，因为 `pack.js` 是构建产物、常量早已被内联进去，
 * 测试跑的是 `pack.js`（照旧全绿）；只有真正重建时才会暴露。
 *
 * ⇒ 把常量搬进渠道包自身，**保持再构建路径自洽**：这是「一次构建、可复现」
 * 的必要条件，也让 `NOTICE.md` 的「宿主提供的依赖只有 `@deepseek-ai/*`」
 * 这句描述恢复为事实。
 *
 * 语义与取值**逐字照搬**原 `src/image-pricing.js`（1024 是兜底估算值，
 * 不代表所有厂商的真实消耗或上限；已移出请求的图片只计描述文本）。
 */
export const FALLBACK_IMAGE_PRICING = Object.freeze({
  /** @param {readonly { offloaded?: boolean }[]} images */
  priceImages(images: readonly { offloaded?: boolean }[]) {
    return images.map((image) => image.offloaded === true
      ? { visualTokens: 0, text: '[image omitted]' }
      : { visualTokens: 1024, text: '[image]' })
  },
})
