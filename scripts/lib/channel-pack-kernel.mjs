// Minimal host contracts for the generated channel pack's offline mount test.
// Provider implementation, pool persistence and RPC handlers remain real.
export class Service {
  constructor(ctx, name) { this.ctx = ctx; ctx.provide(name, this) }
}
export class LlmAdapter {}
export class LlmError extends Error {
  // ⚠️ 形参顺序对齐真实 `@deepseek-ai/dsh-llm` 的 `LlmError(message, code, options)`
  //（2026-10-21 修正：原先写成 `(code, message)` 是反的 —— 桩不校验，
  //  于是 `err.code` 拿到 message、`err.message` 拿到 code，
  //  任何断言错误码的用例都会拿到对调的值）。
  constructor(message, code) { super(message); this.code = code }
}
export const credentialRef = value => value
export const ReasoningEffortId = value => value
export const ToolCallId = value => value
export const createUserMessage = value => value
export const attributionHeaders = () => ({})
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'
export const QUOTA_EXCEEDED_CODE = 'QUOTA_EXCEEDED'
export const isContextWindowExceededError = error => error?.code === CONTEXT_WINDOW_EXCEEDED_CODE
export const isQuotaExceededError = error => error?.code === QUOTA_EXCEEDED_CODE
const schema = new Proxy(() => schema, { get: () => schema })
export default schema
