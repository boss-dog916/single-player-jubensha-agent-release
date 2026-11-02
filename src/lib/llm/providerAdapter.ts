import "server-only";
import { getServerEnv } from "@/src/lib/env/serverEnv";
import { LlmClientError, normalizeLlmError } from "./llmErrors";
import { providerReasoningOptions } from "./providerReasoning";
import type { BaseLlmInput, LlmProvider, TaskModelProfile } from "./llmTypes";

export function bailianApiKeyName(model?: string) {
  return /^qwen/i.test(model ?? "") && process.env.QWEN_BASE_URL?.trim() ? "QWEN_API_KEY" : "BAILIAN_API_KEY";
}
export function bailianEndpoint(model?: string) {
  return bailianApiKeyName(model) === "QWEN_API_KEY" ? process.env.QWEN_BASE_URL!.trim()
    : process.env.BAILIAN_BASE_URL?.trim() || "https://dashscope.aliyuncs.com/compatible-mode/v1";
}
export function providerConnection(provider: LlmProvider, model?: string, profile?: TaskModelProfile) {
  if (provider === "bupt" || provider === "compatible") {
    const env = getServerEnv();
    const apiKeyName = profile?.credentialEnv ?? "OPENAI_API_KEY";
    return { apiKey: process.env[apiKeyName]?.trim(), apiKeyName, baseURL: profile?.endpointIdentity ?? env.openaiBaseUrl, timeoutMs: profile?.timeoutMs ?? env.llmTimeoutMs };
  }
  if (process.env.NEXT_PUBLIC_BAILIAN_API_KEY) throw new Error("NEXT_PUBLIC_BAILIAN_API_KEY must not be used");
  if (process.env.NEXT_PUBLIC_QWEN_API_KEY) throw new Error("NEXT_PUBLIC_QWEN_API_KEY must not be used");
  const apiKeyName = profile?.credentialEnv ?? bailianApiKeyName(model);
  return { apiKey: process.env[apiKeyName]?.trim(), apiKeyName,
    baseURL: profile?.endpointIdentity ?? bailianEndpoint(model), timeoutMs: profile?.timeoutMs ?? 180000 };
}
export function providerRequestFields(profile: TaskModelProfile, input: BaseLlmInput) {
  return profile.provider === "bailian"
    ? { max_tokens: input.maxOutputTokens ?? profile.maxOutputTokens, enable_thinking: false }
    : { max_completion_tokens: input.maxOutputTokens ?? profile.maxOutputTokens,
      ...(profile.reasoningPolicy === "disabled" && /^qwen/i.test(profile.model)
        ? { enable_thinking: false }
        : providerReasoningOptions(profile.model, profile.reasoningPolicy === "disabled" ? { reasoningEffort: "none" } : input)) };
}
export function redactLlmSecrets<T>(value: T): T {
  const secrets = [process.env.BAILIAN_API_KEY, process.env.QWEN_API_KEY, process.env.OPENAI_API_KEY,
    process.env.RUNTIME_LLM_API_KEY, process.env.DM_SEMANTIC_OBSERVER_API_KEY].map(s => s?.trim()).filter((s): s is string => Boolean(s));
  function scrub(item: unknown): unknown {
    if (typeof item === "string") return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), item);
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, v]) =>
      [key, /^(api[_-]?key|authorization)$/i.test(key) ? "[REDACTED]" : scrub(v)]));
    return item;
  }
  return scrub(value) as T;
}
export function safeProviderError(error: unknown): LlmClientError {
  const normalized = normalizeLlmError(error);
  return new LlmClientError({ type: normalized.type, message: redactLlmSecrets(normalized.message) });
}
