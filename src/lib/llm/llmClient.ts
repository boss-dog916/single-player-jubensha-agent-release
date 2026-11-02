import { isOptionalResponse } from "../services/responseDelivery";
import "server-only";

import { registerRuntimeModelSignal } from "@/src/lib/services/runtimeModelPolicy";
import { assertModelAvailable, recordModelFailure } from "@/src/lib/services/modelAvailabilityService";
import { bailianFallbackProfile } from "./bailianFailover";
import { LlmClientError } from "./llmErrors";
import { withLlmBudget, withLlmPriority } from "@/src/lib/llm/concurrencyBudget";
import { createOriginalBrowserMockClient } from "./localPlaytestMock";
import { createMockLlmClient } from "@/src/lib/llm/mockLlmClient";
import { createOpenAiLlmClient } from "@/src/lib/llm/openaiClient";
import { effectiveTaskModelProfile } from "./taskModelProfiles";
import { RUNTIME_BASELINE } from "@/src/lib/env/runtimeBaseline";
import { assertLocalPlaytestCall, localPlaytestManifest, localPlaytestMode } from "./localPlaytestGuard";
import type {
  GenerateStructuredInput,
  GenerateStructuredResult,
  GenerateTextInput,
  GenerateTextResult,
  LlmClient,
  TaskModelProfile
} from "@/src/lib/llm/llmTypes";

let client: LlmClient | null = null;
let testClient: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  if (!client) {
    client = createOpenAiLlmClient();
  }

  return client;
}

async function requestBudget<T>(input: GenerateTextInput, profile: TaskModelProfile, operation: () => Promise<T>): Promise<T> {
  // Authorisation/manifest guards run before any DB span or queue mutation.
  assertLocalPlaytestCall(input, profile);
  const startedAt = Date.now();
  const background = input.agentType === "story_board_writer";
  const planner = input.agentType === "ai_player_reaction_planner";
  const runtime = !profile.taskType.startsWith("manual_");
  const span = input.gameSessionId ? await (await import("@/src/lib/services/agentRunService")).createAgentRun({
    gameSessionId: input.gameSessionId, agentType: "llm_request_lifecycle", roleId: input.roleId,
    actId: input.actId, phase: input.phase, inputJson: { sourceAgentType: input.agentType,
      endpointIdentity: profile.endpointIdentity, model: profile.model, lane: background ? "background" : "foreground",
      httpTimeoutMs: background ? storyBoardTimeout(input.timeoutMs ?? profile.timeoutMs) : input.timeoutMs ?? profile.timeoutMs,
      queuedAt: new Date(startedAt).toISOString() } }) : null;
  let queueEnteredAt: number | null = null, acquiredAt: number | null = null;
  const phases: Array<{ stage: string; at: string; status?: number }> = [];
  let contextCompression: unknown;
  const previousTrace = input.onTrace;
  input.onTrace = event => {
    if (event.stage === "context_budget") contextCompression = event.contextCompression;
    phases.push({ stage: event.stage, at: event.at, ...(event.status !== undefined ? { status: event.status } : {}) });
    previousTrace?.(event);
  };
  const metrics = () => {
    const http = phases.find(p => p.stage === "http_start");
    return { queueWaitMs: queueEnteredAt === null ? null : (acquiredAt ?? Date.now()) - queueEnteredAt,
      serviceMs: http ? Date.now() - Date.parse(http.at) : null, httpStarted: Boolean(http),
      headersReceived: phases.some(p => p.stage === "response_headers"),
      cancelledByParent: Boolean(input.signal?.aborted), phases, ...(contextCompression ? { contextCompression } : {}) };
  };
  try {
    if (runtime && input.gameSessionId) await (await import("@/src/lib/services/runtimeModelPolicy")).assertRuntimeModelCall(input);
    if (runtime) await assertModelAvailable(input.gameSessionId);
    const run = () => {
      queueEnteredAt = Date.now();
      return withLlmBudget(async () => {
        acquiredAt = Date.now();
        if (runtime && input.gameSessionId) await (await import("@/src/lib/services/runtimeModelPolicy")).assertRuntimeModelCall(input);
        if (runtime) await assertModelAvailable(input.gameSessionId);
        const output = await operation();
        if (runtime && input.gameSessionId) await (await import("@/src/lib/services/runtimeModelPolicy")).assertRuntimeModelCall(input);
        return output;
      }, profile.provider, input.signal, background ? "background" : "foreground");
    };
    const output = runtime
      ? await withLlmPriority(background ? 2 : planner ? 1 : 0, run) : await run();
    if (span) await (await import("@/src/lib/services/agentRunService")).completeAgentRun({
      agentRunId: span.id, outputJson: metrics(), latencyMs: Date.now() - startedAt });
    return output;
  } catch (error) {
    const deadline = input.signal?.aborted && input.signal.reason instanceof Error &&
      (input.signal.reason.name === "TimeoutError" || input.signal.reason.message === "Semantic observation deadline exceeded");
    const failure = deadline ? new LlmClientError({ type: "timeout", message: "模型请求超过当前任务期限。" }) : error;
    const normalized = (await import("./llmErrors")).normalizeLlmError(failure);
    // The Orchestrator aggregates Planner failures before deciding to pause.
    // Transient background failures belong to their own durable task, not the game.
    const isolatedBackground = background && ["timeout", "network", "rate_limit", "service_unavailable"].includes(normalized.type);
    const feedback = input.agentType === "dm_node_realizer" && (input.metadata as { responseKind?: string } | undefined)?.responseKind === "dm_text_feedback";
    const isolatedResponse = feedback || isOptionalResponse() && ["ai_player_reaction_planner", "ai_player_discussion_utterance", "discussion_checker"].includes(input.agentType ?? "") && !["authentication", "quota", "test_budget"].includes(normalized.type);
    if (runtime && !planner && !isolatedBackground && !isolatedResponse && (!input.signal?.aborted || deadline) && !(deadline && profile.taskType === "semantic_observer"))
      await recordModelFailure(input.gameSessionId, failure);
    if (span) await (await import("@/src/lib/services/agentRunService")).failAgentRun({ agentRunId: span.id,
      error: normalized.type, errorMessage: (await import("./providerAdapter")).redactLlmSecrets(normalized.message),
      outputJson: { ...metrics(), failureType: normalized.type,
        failureScope: isolatedResponse ? "optional_response" : planner ? "planner_aggregate" : isolatedBackground ? "background_task" : "foreground" }, latencyMs: Date.now() - startedAt });
    throw failure;
  }
}

function storyBoardTimeout(fallback: number) {
  const configured = Number(process.env.STORY_BOARD_TIMEOUT_MS ?? RUNTIME_BASELINE.storyBoardTimeoutMs);
  if (!Number.isInteger(configured) || configured <= 0) throw new Error("STORY_BOARD_TIMEOUT_MS must be a positive integer");
  return Math.min(fallback, configured);
}

function limitRuntimeInput<T extends GenerateTextInput>(input: T, profile: TaskModelProfile): T {
  if (profile.taskType.startsWith("manual_")) return input;
  return { ...input, maxRetries: RUNTIME_BASELINE.httpRetries, maxOutputTokens: profile.maxOutputTokens,
    ...(input.agentType === "story_board_writer"
      ? { timeoutMs: storyBoardTimeout(input.timeoutMs ?? profile.timeoutMs) } : {}) };
}

export function setLlmClientForTests(nextClient: LlmClient | null): void {
  testClient = nextClient;
  client = nextClient;
}

function routeInput<T extends GenerateTextInput>(input: T): { input: T; client: LlmClient } {
  if (testClient) return { input, client: testClient };
  if (localPlaytestMode() === "mock") {
    const original = ["old-house-group-matching", "old-house-six-act", "long-night-full"].includes(localPlaytestManifest().manifest.fixtureKind ?? "");
    return { input: { ...input, model: "mock-playtest" }, client: original ? createOriginalBrowserMockClient() : createMockLlmClient() };
  }
  const profile = effectiveTaskModelProfile(input);
  return { input: { ...input, model: profile.model, temperature: profile.temperature,
    maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs, maxRetries: input.maxRetries ?? 0 },
    client: createOpenAiLlmClient(profile) };
}

export async function generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
  const profile = effectiveTaskModelProfile(input);
  const handle = registerRuntimeModelSignal(profile.taskType.startsWith("manual_") ? {} : input);
  input = { ...input, signal: handle.signal };
  try { return await requestBudget(input, profile, async () => {
    if (profile.provider === "bupt" || !profile.taskType.startsWith("manual_")) await (await import("@/src/lib/services/conversationService")).assertConversationProviderStart(input.gameSessionId);
    assertLocalPlaytestCall(input, profile);
    input = limitRuntimeInput(input, profile);
    return callWithBailianFailover(input, profile, (c, i) => c.generateText(i));
  }); } finally { handle.release(); }
}

export async function generateStructured<T>(
  input: GenerateStructuredInput<T>
): Promise<GenerateStructuredResult<T>> {
  const profile = effectiveTaskModelProfile(input);
  const handle = registerRuntimeModelSignal(profile.taskType.startsWith("manual_") ? {} : input);
  input = { ...input, signal: handle.signal };
  try { return await requestBudget(input, profile, async () => {
    if (profile.provider === "bupt" || !profile.taskType.startsWith("manual_")) await (await import("@/src/lib/services/conversationService")).assertConversationProviderStart(input.gameSessionId);
    assertLocalPlaytestCall(input, profile);
    input = limitRuntimeInput(input, profile);
    return callWithBailianFailover(input, profile, (c, i) => c.generateStructured(i));
  }); } finally { handle.release(); }
}

async function callWithBailianFailover<I extends GenerateTextInput, R>(input: I, profile: TaskModelProfile, call: (client: LlmClient, input: I) => Promise<R>): Promise<R> {
  const execute = (selected: TaskModelProfile) => {
    const actual = { ...input, model: selected.model, maxRetries: 0 };
    const routed = routeInput(actual);
    return call(routed.client, routed.input);
  };
  // Mock and custom clients keep their original contracts. HTTP Mock tests use
  // the real adapter with fake transport and therefore exercise this branch.
  if (testClient || localPlaytestMode() === "mock") { const r=routeInput(input); return call(r.client,r.input); }
  const already = bailianFallbackProfile(profile, input);
  if (already) return execute(already);
  try { const r=routeInput(input); return await call(r.client,r.input); }
  catch (error) {
    const backup=bailianFallbackProfile(profile,input,error);
    if (!backup) throw error;
    // Both attempts use the original AbortSignal/deadline, lease and durable
    // HTTP ledger. A backup failure goes to ordinary pause/recovery; no loop.
    await (await import("@/src/lib/services/runtimeModelPolicy")).assertRuntimeModelCall(input);
    await (await import("@/src/lib/services/conversationService")).assertConversationProviderStart(input.gameSessionId);
    return execute(backup);
  }
}
