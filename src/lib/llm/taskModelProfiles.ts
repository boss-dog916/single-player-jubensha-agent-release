import "server-only";
import { getServerEnv } from "@/src/lib/env/serverEnv";
import { RUNTIME_BASELINE } from "@/src/lib/env/runtimeBaseline";
import { bailianApiKeyName, bailianEndpoint } from "./providerAdapter";
import type { BaseLlmInput, LlmTaskProfile, TaskModelProfile } from "./llmTypes";

const parserTasks = new Set<LlmTaskProfile>(["manual_activity_extractor", "manual_planner", "manual_semantic_extractor", "manual_semantic_repair"]);
const optional = (name: string) => process.env[name]?.trim() || undefined;
// Opt-in for the dedicated local process only; never changes the ordinary runtime default.
export function localPlaytestRuntimeOverride(): boolean {
  if (!optional("LONG_NIGHT_PLAYTEST_DIR") || !optional("LONG_NIGHT_PLAYTEST_RUNTIME_PROVIDER")) return false;
  if (process.env.NODE_ENV === "production") throw new Error("Local playtest cannot run in production");
  if (optional("LONG_NIGHT_PLAYTEST_RUNTIME_PROVIDER") !== "bailian") throw new Error("Local playtest Runtime provider must be bailian");
  return true;
}
function positive(name: string, fallback: number) {
  const raw = optional(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
export function endpointIdentity(endpoint: string | undefined): string {
  if (!endpoint) return "https://api.openai.com/v1";
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error("LLM endpoint must not contain credentials, query or fragment");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
}
// This public profile deliberately contains no credentials; it is safe to fingerprint and persist.
export function resolveTaskModelProfile(task: LlmTaskProfile = "runtime"): TaskModelProfile {
  if (task === "manual_activity_extractor") {
    return { taskType: task, provider: "bailian", model: "qwen3.8-flash",
      endpointIdentity: endpointIdentity(bailianEndpoint("qwen3.8-flash")),
      profileVersion: "manual-activity-bailian-1", temperature: .1, timeoutMs: 180000, maxOutputTokens: 16000,
      structuredMode: "json_object", reasoningPolicy: "disabled" };
  }
  if (parserTasks.has(task)) {
    const suffix = task === "manual_planner" ? "PLANNER" : task === "manual_semantic_extractor" ? "EXTRACTOR" : "REPAIR";
    const model = optional(`BAILIAN_MANUAL_${suffix}_MODEL`) ?? "qwen3.8-flash";
    return { taskType: task, provider: "bailian", model,
      endpointIdentity: endpointIdentity(bailianEndpoint(model)),
      profileVersion: task === "manual_planner" ? "manual-bailian-planner-5" : "manual-bailian-1", temperature: .1,
      timeoutMs: positive(`BAILIAN_MANUAL_${suffix}_TIMEOUT_MS`, 180000),
      maxOutputTokens: positive(`BAILIAN_MANUAL_${suffix}_MAX_TOKENS`, suffix === "PLANNER" ? 6000 : 10000),
      structuredMode: "json_object", reasoningPolicy: "disabled" };
  }
  const env = getServerEnv();
  if (task === "semantic_observer") {
    const selected = optional("DM_SEMANTIC_OBSERVER_PROVIDER") ?? "bailian";
    if (selected !== "bupt" && selected !== "bailian" && selected !== "compatible") throw new Error("Invalid Observer provider");
    const model = optional("DM_SEMANTIC_OBSERVER_MODEL") ?? "deepseek-v4.1-flash";
    return { taskType: task, provider: selected, model,
      credentialEnv: optional("DM_SEMANTIC_OBSERVER_API_KEY") ? "DM_SEMANTIC_OBSERVER_API_KEY" : undefined,
      endpointIdentity: endpointIdentity(optional("DM_SEMANTIC_OBSERVER_BASE_URL") ?? (selected === "bailian" ?
      bailianEndpoint(model) : env.openaiBaseUrl)),
      profileVersion: selected === "bailian" ? "public-semantic-observer-bailian-1" : "public-semantic-observer-1", temperature: 0, timeoutMs: Math.min(10_000, positive("DM_SEMANTIC_OBSERVER_TIMEOUT_MS", 6000)),
      maxOutputTokens: positive("DM_SEMANTIC_OBSERVER_MAX_TOKENS", 2400),
      structuredMode: "json_object", reasoningPolicy: "disabled" };
  }
  const provider = optional("RUNTIME_LLM_PROVIDER") ?? "bailian";
  if (provider !== "bailian" && provider !== "compatible") throw new Error("RUNTIME_LLM_PROVIDER must be bailian or compatible");
  const model = optional("RUNTIME_LLM_MODEL") ?? (localPlaytestRuntimeOverride() ? optional("LONG_NIGHT_PLAYTEST_RUNTIME_MODEL") : undefined) ?? "qwen3.8-flash";
  return { taskType: task, provider, model,
    credentialEnv: optional("RUNTIME_LLM_API_KEY") ? "RUNTIME_LLM_API_KEY" : undefined,
    endpointIdentity: endpointIdentity(optional("RUNTIME_LLM_BASE_URL") ?? (provider === "bailian" ? bailianEndpoint(model) : env.openaiBaseUrl)),
    profileVersion: RUNTIME_BASELINE.version, timeoutMs: env.llmTimeoutMs,
    structuredMode: "json_object", reasoningPolicy: "disabled" };
}
export function effectiveTaskModelProfile(input: BaseLlmInput): TaskModelProfile {
  const profile = resolveTaskModelProfile(input.taskProfile);
  const model = input.model ?? profile.model;
  const runtime = !profile.taskType.startsWith("manual_");
  const explicitEndpoint = optional(profile.taskType === "semantic_observer" ? "DM_SEMANTIC_OBSERVER_BASE_URL" : "RUNTIME_LLM_BASE_URL");
  return { ...profile, model, ...(profile.provider === "bailian" && model !== profile.model && !explicitEndpoint ? { endpointIdentity: endpointIdentity(bailianEndpoint(model)) } : {}), temperature: input.temperature ?? profile.temperature,
    timeoutMs: input.timeoutMs ?? profile.timeoutMs, maxOutputTokens: input.maxOutputTokens ?? profile.maxOutputTokens,
    ...(runtime ? { maxOutputTokens: input.agentType === "ai_player_reaction_planner" ? RUNTIME_BASELINE.plannerOutputTokens
      : Math.min(input.maxOutputTokens ?? profile.maxOutputTokens ?? RUNTIME_BASELINE.maxOutputTokens, RUNTIME_BASELINE.maxOutputTokens) } : {}) };
}
export function hasTaskApiKey(task: LlmTaskProfile): boolean {
  const profile = resolveTaskModelProfile(task);
  return Boolean(optional(profile.credentialEnv ?? (profile.provider === "bailian" ? bailianApiKeyName(profile.model) : "OPENAI_API_KEY")));
}
export function manualExtractorEnabled(): boolean { return process.env.BAILIAN_MANUAL_EXTRACTOR_ENABLED === "true"; }
