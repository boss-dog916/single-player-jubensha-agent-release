import { ZodError } from "zod";
import { APIConnectionError, APIConnectionTimeoutError } from "openai";

export type LlmErrorType =
  | "authentication"
  | "quota"
  | "context_limit"
  | "test_budget"
  | "service_unavailable"
  | "rate_limit"
  | "network"
  | "timeout"
  | "json_parse"
  | "zod_validation"
  | "unknown";

export type NormalizedLlmError = {
  type: LlmErrorType;
  message: string;
  cause?: unknown;
};

export class LlmClientError extends Error {
  readonly type: LlmErrorType;
  readonly cause?: unknown;

  constructor(error: NormalizedLlmError) {
    super(error.message);
    this.name = "LlmClientError";
    this.type = error.type;
    this.cause = error.cause;
  }
}

export function normalizeLlmError(error: unknown): NormalizedLlmError {
  // The SDK wraps fetch guards in APIConnectionError. Preserve our typed guard
  // and provider codes through that cause chain, without classifying by prose.
  let nested = error as { cause?: unknown } | undefined;
  for (let depth = 0; depth < 6 && nested?.cause; depth++) {
    if (nested.cause instanceof LlmClientError) return normalizeLlmError(nested.cause);
    nested = nested.cause as typeof nested;
  }
  if (error instanceof LlmClientError) {
    return {
      type: error.type,
      message: error.message,
      cause: error.cause
    };
  }

  if (error instanceof SyntaxError) {
    return {
      type: "json_parse",
      message: error.message,
      cause: error
    };
  }

  if (error instanceof ZodError) {
    return {
      type: "zod_validation",
      message: error.message,
      cause: error
    };
  }

  const maybeError = error as { name?: string; status?: number; code?: string; message?: string; error?: { code?: string } };
  const name = maybeError?.name ?? "";
  const status = maybeError?.status;
  const code = maybeError?.code ?? maybeError?.error?.code ?? "";
  const message = maybeError?.message ?? "Unknown LLM error.";

  if (status === 402 || /insufficient_quota|insufficient_balance|arrearage|quotaexhausted|allocationquota|freeallocatedquota/i.test(code)) {
    return { type: "quota", message, cause: error };
  }
  if (status === 401 || name === "AuthenticationError" || /invalid_api_key|invalidapikey|accessdenied/i.test(code)) {
    return { type: "authentication", message, cause: error };
  }

  if (status === 429 || name === "RateLimitError") {
    return { type: "rate_limit", message, cause: error };
  }

  if (typeof status === "number" && status >= 500) return { type: "service_unavailable", message, cause: error };

  if (error instanceof APIConnectionTimeoutError || name === "APIConnectionTimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return { type: "timeout", message, cause: error };
  }

  if (
    error instanceof APIConnectionError ||
    name === "APIConnectionError" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED"
  ) {
    return { type: "network", message, cause: error };
  }

  return {
    type: "unknown",
    message,
    cause: error
  };
}

export function modelFailureNotice(type: LlmErrorType): string {
  const notices: Partial<Record<LlmErrorType, string>> = {
    context_limit: "本地模型上下文超限，请开发者精简任务上下文后恢复；请求尚未发送。",
    authentication: "模型API密钥无效或未配置，请开发者修正配置后恢复。",
    quota: "模型服务商额度或余额不足，请开发者检查账户后恢复。",
    rate_limit: "模型服务暂时限流，请稍候再恢复。",
    network: "模型网络连接失败，请检查网络后恢复。",
    timeout: "模型请求超时，请稍候再恢复。",
    service_unavailable: "模型服务暂时不可用，请稍候再恢复。",
    test_budget: "本局测试模型请求次数已耗尽；测试硬上限不能通过恢复重置，请保留记录。"
  };
  return notices[type] ?? "模型任务未完成，请保留进度并检查调试记录。";
}

export function throwLlmError(error: unknown): never {
  throw new LlmClientError(normalizeLlmError(error));
}
