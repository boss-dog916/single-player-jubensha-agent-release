import type { z } from "zod";
import type { GamePhase } from "@/src/lib/types/game";

export type LlmRole = "system" | "developer" | "user" | "assistant";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
};

export type LlmCallContext = {
  gameSessionId?: string | null;
  agentType: string;
  roleId?: string | null;
  actId?: string | null;
  phase?: GamePhase | string | null;
};

export type BaseLlmInput = LlmCallContext & {
  taskProfile?: LlmTaskProfile;
  model?: string;
  messages?: LlmMessage[];
  prompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: unknown;
  maxRetries?: number;
  onTrace?: (event: LlmTraceEvent) => void;
};

export type LlmTraceEvent = {
  stage: "request_start" | "context_budget" | "http_start" | "response_headers" | "completion" | "schema_parse" | "error";
  contextCompression?: unknown;
  at: string;
  elapsedMs: number;
  model?: string;
  provider?: LlmProvider;
  taskType?: string;
  requestConfig?: LlmRequestConfig;
  promptChars?: number;
  returnedModel?: string;
  status?: number;
  providerRequestId?: string | null;
  finishReason?: string | null;
  usage?: unknown;
  parseLatencyMs?: number;
  retryCount?: number;
  error?: string;
  errorCode?: string;
};

export type GenerateTextInput = BaseLlmInput;

export type GenerateTextResult = {
  text: string;
  model: string;
  latencyMs: number;
  agentRunId: string;
};

export type GenerateStructuredInput<T> = BaseLlmInput & {
  schemaName: string;
  jsonSchema?: JsonSchemaObject;
  zodSchema?: z.ZodType<T, z.ZodTypeDef, unknown>;
  mockOutput?: unknown;
  onRawResponse?: (response: { text: string; model: string; latencyMs: number; retryCount: number; usage: unknown; finishReason?: string | null; reasoningChars?: number; returnedModel?: string; requestConfig?: LlmRequestConfig }) => Promise<void>;
};

export type LlmProvider = "bupt" | "bailian" | "compatible";
export type LlmTaskProfile = "manual_activity_extractor" | "manual_planner" | "manual_semantic_extractor" | "manual_semantic_repair"
  | "ai_player" | "reaction_planner" | "dm_analyzer" | "dm_realizer" | "discussion_generation"
  | "discussion_checker" | "share_generation" | "share_checker" | "semantic_observer" | "runtime";
export type TaskModelProfile = {
  taskType: LlmTaskProfile; provider: LlmProvider; model: string; endpointIdentity: string;
  profileVersion: string; temperature?: number; timeoutMs: number; maxOutputTokens?: number;
  structuredMode: "json_object" | "json_schema"; reasoningPolicy: "disabled" | "runtime_default";
  credentialEnv?: string;
};
export type LlmRequestConfig = TaskModelProfile & { taskType: LlmTaskProfile; agentType: string };

export type GenerateStructuredResult<T> = {
  data: T;
  rawText: string;
  model: string;
  latencyMs: number;
  agentRunId: string;
};

export interface LlmClient {
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  generateStructured<T>(input: GenerateStructuredInput<T>): Promise<GenerateStructuredResult<T>>;
}
