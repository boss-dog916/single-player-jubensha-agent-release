import "server-only";

import OpenAI from "openai";
import { assertContextBudget } from "./contextBudget";
import { compressPrompt, compressionOptions, supportsPromptCompression } from "./promptCompression";
import { providerReasoningOptions } from "@/src/lib/llm/providerReasoning";
import { effectiveTaskModelProfile, resolveTaskModelProfile } from "./taskModelProfiles";
import { providerConnection, providerRequestFields, redactLlmSecrets, safeProviderError } from "./providerAdapter";
import { localPlaytestFetch, localPlaytestMode } from "./localPlaytestGuard";
import { zodResponseFormat } from "openai/helpers/zod";
import { completeAgentRun, createAgentRun, failAgentRun } from "@/src/lib/services/agentRunService";
import { LlmClientError, normalizeLlmError, throwLlmError } from "@/src/lib/llm/llmErrors";
import type {
  GenerateStructuredInput,
  GenerateStructuredResult,
  GenerateTextInput,
  GenerateTextResult,
  JsonSchemaObject,
  LlmClient,
  LlmMessage,
  TaskModelProfile
} from "@/src/lib/llm/llmTypes";

export function createOpenAiLlmClient(profile?: TaskModelProfile): LlmClient {
  profile ??= resolveTaskModelProfile();
  const connection = providerConnection(profile.provider, profile.model, profile);

  if (!connection.apiKey) {
    throw new LlmClientError({
      type: "authentication",
      message: `${connection.apiKeyName} is not configured.`
    });
  }

  const openai = new OpenAI({
    apiKey: connection.apiKey,
    baseURL: connection.baseURL,
    timeout: connection.timeoutMs,
    maxRetries: 0
  });

  return {
    generateText: (input) => generateText(openai, input, profile),
    generateStructured: (input) => generateStructured(openai, input, profile)
  };
}

async function generateText(openai: OpenAI, input: GenerateTextInput, suppliedProfile?: TaskModelProfile): Promise<GenerateTextResult> {
  const profile = requestProfile(input, suppliedProfile);
  const originalFetch = globalThis.fetch;
  if (input.gameSessionId) openai = openai.withOptions({ fetch: async (url, init) => {
    if (!profile.taskType.startsWith("manual_")) {
      await (await import("@/src/lib/services/runtimeModelPolicy")).assertRuntimeModelCall(input);
    }
    return localPlaytestMode() ? localPlaytestFetch(url, init, input, profile) : originalFetch(url, init);
  } });
  else if (localPlaytestMode()) openai = openai.withOptions({ fetch: (url, init) => localPlaytestFetch(url, init, input, profile) });

  const model = input.model ?? profile.model;
  const startedAt = Date.now();
  const promptChars = countPromptChars(input);
  let retryCount = 0;
  const agentRun = input.gameSessionId
    ? await createAgentRun({
        gameSessionId: input.gameSessionId,
        agentType: input.agentType,
        roleId: input.roleId,
        actId: input.actId,
        phase: input.phase,
        model,
        runKind: "llm",
        promptChars,
        inputJson: buildInputLog(input, profile)
      })
    : null;

  try {
    if (!profile.taskType.startsWith("manual_")) assertContextBudget(toChatMessages(input));
    const completion = await withMeasuredRetries(
      () =>
        openai.chat.completions.create(
          {
            model,
            messages: toChatMessages(input),
            temperature: input.temperature,
            ...providerRequestFields(profile, input)
          },
          requestOptions(input)
        ),
      (count) => {
        retryCount = count;
      }, input.maxRetries
    );
    const text = redactLlmSecrets(completion.choices[0]?.message.content ?? "");
    const latencyMs = Date.now() - startedAt;

    if (agentRun) {
      await completeAgentRun({
        agentRunId: agentRun.id,
        outputJson: {
          text,
          raw: safeCompletion(completion, profile)
        },
        latencyMs,
        promptChars,
        outputChars: text.length,
        retryCount,
        ...extractCompletionMetrics(completion)
      });
    }

    return {
      text,
      model,
      latencyMs,
      agentRunId: agentRun?.id ?? ""
    };
  } catch (originalError) {
    const error = safeProviderError(originalError);
    if (agentRun) {
      await recordFailure(agentRun.id, error, Date.now() - startedAt, {
        promptChars,
        retryCount
      });
    }
    throwLlmError(error);
  }
}

async function generateStructured<T>(
  openai: OpenAI,
  input: GenerateStructuredInput<T>,
  suppliedProfile?: TaskModelProfile
): Promise<GenerateStructuredResult<T>> {
  const profile = requestProfile(input, suppliedProfile);
  const model = input.model ?? profile.model;
  const requestConfig = { ...profile, agentType: input.agentType };
  const jsonObjectMode = profile.structuredMode === "json_object";
  if (jsonObjectMode) {
    const schema = input.zodSchema
      ? zodResponseFormat(input.zodSchema, input.schemaName).json_schema.schema
      : input.jsonSchema;
    input = { ...input, messages: [...(input.messages ?? [{ role: "user", content: input.prompt ?? "" }]),
      { role: "user", content: `Return only a JSON object conforming to this schema: ${JSON.stringify(schema)}` }] };
  }
  // Budget the actual serialized messages, including the appended schema.
  // Audited discussion shapes share one registry and the same compression pass.
  const compression = supportsPromptCompression(input.agentType)
    ? compressPrompt({ agentType: input.agentType, messages: toChatMessages(input),
      protectedPublicMessageIds: (input.metadata as { compressionSafety?: { protectedPublicMessageIds?: string[] } } | undefined)?.compressionSafety?.protectedPublicMessageIds
    }, compressionOptions(input.maxOutputTokens ?? profile.maxOutputTokens ?? 1500)) : undefined;
  if (compression) input = { ...input, messages: compression.messages,
    metadata: { ...(input.metadata && typeof input.metadata === "object" ? input.metadata : {}), contextCompression: compression.report } };
  const startedAt = Date.now();
  const promptChars = countPromptChars(input);
  let retryCount = 0;
  const trace = (stage: Parameters<NonNullable<typeof input.onTrace>>[0]["stage"], extra: object = {}) =>
    input.onTrace?.(redactLlmSecrets({ stage, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, model,
      provider: profile.provider, taskType: profile.taskType, ...extra }));
  trace("request_start", { promptChars, requestConfig });
  if (compression) trace("context_budget", { contextCompression: compression.report });
  if (input.onTrace || localPlaytestMode() || input.gameSessionId) {
    openai = openai.withOptions({ fetch: async (url, init) => {
      if (input.gameSessionId && !profile.taskType.startsWith("manual_")) await (await import("@/src/lib/services/runtimeModelPolicy")).assertRuntimeModelCall(input);
      trace("http_start");
      const response = await localPlaytestFetch(url, init, input, profile);
      trace("response_headers", { status: response.status, providerRequestId: response.headers.get("x-request-id") });
      return response;
    } });
  }
  const agentRun = input.gameSessionId
    ? await createAgentRun({
        gameSessionId: input.gameSessionId,
        agentType: input.agentType,
        roleId: input.roleId,
        actId: input.actId,
        phase: input.phase,
        model,
        runKind: "llm",
        promptChars,
        inputJson: buildInputLog(input, profile)
      })
    : null;

  try {
    if (compression?.error) throw compression.error;
    if (!profile.taskType.startsWith("manual_")) assertContextBudget(toChatMessages(input));
    if (input.zodSchema) {
      const zodSchema = input.zodSchema;
      const completion = await withMeasuredRetries(
        () =>
          (jsonObjectMode || input.onRawResponse || input.onTrace ? openai.chat.completions.create.bind(openai.chat.completions)
            : openai.chat.completions.parse.bind(openai.chat.completions))(
            {
              model,
              messages: toChatMessages(input),
              temperature: input.temperature,
              ...providerRequestFields(profile, input),
              response_format: jsonObjectMode ? { type: "json_object" } : zodResponseFormat(zodSchema, input.schemaName)
            },
            requestOptions(input)
          ),
        (count) => {
          retryCount = count;
        }, input.maxRetries
      );
      const message = completion.choices[0]?.message;
      const finalContent = redactLlmSecrets(message?.content ?? "");
      trace("completion", { usage: completion.usage ?? null, finishReason: completion.choices[0]?.finish_reason ?? null, returnedModel: completion.model, retryCount });
      if (input.onRawResponse) await input.onRawResponse(redactLlmSecrets({ text: finalContent, model, latencyMs: Date.now() - startedAt, retryCount, usage: completion.usage ?? null, requestConfig,
        finishReason: completion.choices[0]?.finish_reason ?? null, returnedModel: completion.model, reasoningChars: String((message as { reasoning_content?: string } | undefined)?.reasoning_content ?? "").length }));
      const parseStartedAt = Date.now();
      let parsed: T | null | undefined;
      try { parsed = jsonObjectMode || input.onRawResponse || input.onTrace
        ? zodSchema.parse(JSON.parse(finalContent))
        : message && "parsed" in message ? message.parsed as T : null;
      } finally { trace("schema_parse", { parseLatencyMs: Date.now() - parseStartedAt }); }

      if (parsed === null || parsed === undefined) {
        throw new SyntaxError("OpenAI returned no structured JSON payload.");
      }

      const latencyMs = Date.now() - startedAt;

      if (agentRun) {
        await completeAgentRun({
          agentRunId: agentRun.id,
          outputJson: {
            data: parsed,
            raw: safeCompletion(completion, profile)
          },
          latencyMs,
          promptChars,
          outputChars: JSON.stringify(parsed).length,
          retryCount,
          ...extractCompletionMetrics(completion)
        });
      }

      return {
        data: parsed,
        rawText: JSON.stringify(parsed),
        model,
        latencyMs,
        agentRunId: agentRun?.id ?? ""
      };
    }

    if (!input.jsonSchema) {
      throw new Error("generateStructured requires either jsonSchema or zodSchema.");
    }

    const completion = await withMeasuredRetries(
      () =>
        openai.chat.completions.create(
          {
            model,
            messages: toChatMessages(input),
            temperature: input.temperature,
            ...providerRequestFields(profile, input),
            response_format: jsonObjectMode ? { type: "json_object" } : {
              type: "json_schema",
              json_schema: {
                name: input.schemaName,
                schema: input.jsonSchema,
                strict: true
              }
            }
          },
          requestOptions(input)
        ),
      (count) => {
        retryCount = count;
      }, input.maxRetries
    );
    const rawText = redactLlmSecrets(completion.choices[0]?.message.content ?? "");
    trace("completion", { usage: completion.usage ?? null, finishReason: completion.choices[0]?.finish_reason ?? null, retryCount });
    if (input.onRawResponse) await input.onRawResponse(redactLlmSecrets({ text: rawText, model, latencyMs: Date.now() - startedAt, retryCount, usage: completion.usage ?? null, requestConfig }));
    const parseStartedAt = Date.now();
    const data = JSON.parse(rawText) as T;
    trace("schema_parse", { parseLatencyMs: Date.now() - parseStartedAt });
    const latencyMs = Date.now() - startedAt;

    if (agentRun) {
      await completeAgentRun({
        agentRunId: agentRun.id,
        outputJson: {
          data,
          rawText,
          raw: safeCompletion(completion, profile)
        },
        latencyMs,
        promptChars,
        outputChars: rawText.length,
        retryCount,
        ...extractCompletionMetrics(completion)
      });
    }

    return {
      data,
      rawText,
      model,
      latencyMs,
      agentRunId: agentRun?.id ?? ""
    };
  } catch (originalError) {
    const error = safeProviderError(originalError);
    trace("error", { error: error.message, errorType: error.type, retryCount, status: (originalError as { status?: number })?.status, errorCode: (originalError as { code?: string })?.code });
    if (agentRun) {
      await recordFailure(agentRun.id, error, Date.now() - startedAt, {
        promptChars,
        retryCount
      });
    }
    throwLlmError(error);
  }
}

function toChatMessages(input: GenerateTextInput | GenerateStructuredInput<unknown>) {
  const messages: LlmMessage[] =
    input.messages ??
    [
      {
        role: "user",
        content: input.prompt ?? ""
      }
    ];

  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function requestProfile(input: GenerateTextInput, supplied?: TaskModelProfile): TaskModelProfile {
  if (!supplied) return effectiveTaskModelProfile(input);
  return { ...supplied, model: input.model ?? supplied.model, temperature: input.temperature ?? supplied.temperature,
    timeoutMs: input.timeoutMs ?? supplied.timeoutMs, maxOutputTokens: input.maxOutputTokens ?? supplied.maxOutputTokens };
}

function buildInputLog(input: GenerateTextInput | GenerateStructuredInput<unknown>, profile: TaskModelProfile) {
  return redactLlmSecrets({
    llmRoute: profile,
    prompt: input.prompt,
    messages: input.messages,
    temperature: input.temperature,
    maxOutputTokens: input.maxOutputTokens,
    reasoningEffort: input.reasoningEffort,
    providerReasoning: profile.provider === "bailian" || profile.reasoningPolicy === "disabled" ? { enable_thinking: false } : providerReasoningOptions(profile.model, input),
    timeoutMs: input.timeoutMs,
    metadata: input.metadata,
    schemaName: "schemaName" in input ? input.schemaName : undefined,
    jsonSchema: "jsonSchema" in input ? scrubJsonSchema(input.jsonSchema) : undefined,
    hasZodSchema: "zodSchema" in input ? Boolean(input.zodSchema) : undefined
  });
}

function safeCompletion<T>(completion: T, profile: TaskModelProfile): T {
  const safe = redactLlmSecrets(completion);
  if (profile.provider === "bailian") {
    for (const choice of (safe as { choices?: Array<{ message?: Record<string, unknown> }> }).choices ?? []) {
      if (choice.message) delete choice.message.reasoning_content;
    }
  }
  return safe;
}

function scrubJsonSchema(jsonSchema: JsonSchemaObject | undefined) {
  return jsonSchema ?? null;
}

function requestOptions(input: GenerateTextInput | GenerateStructuredInput<unknown>) {
  if (!input.timeoutMs && !input.signal) return undefined;
  return { ...(input.timeoutMs ? { timeout: input.timeoutMs } : {}), ...(input.signal ? { signal: input.signal } : {}) };
}

function countPromptChars(input: GenerateTextInput | GenerateStructuredInput<unknown>): number {
  return toChatMessages(input).reduce((total, message) => total + message.content.length, 0);
}

type CompletionMetricsSource = {
  id?: string;
  _request_id?: string | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number | null } | null;
    completion_tokens_details?: { reasoning_tokens?: number | null } | null;
  } | null;
};

function extractCompletionMetrics(completion: CompletionMetricsSource) {
  return {
    inputTokens: completion.usage?.prompt_tokens ?? null,
    outputTokens: completion.usage?.completion_tokens ?? null,
    reasoningTokens: completion.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    cachedInputTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? null,
    providerRequestId: completion._request_id ?? completion.id ?? null,
    // The current non-streaming API only exposes the completed response.
    ttftMs: null
  };
}

async function withMeasuredRetries<T>(
  operation: () => Promise<T>,
  onRetryCount: (retryCount: number) => void,
  maxRetries = 2
): Promise<T> {

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !isRetryableError(error)) {
        throw error;
      }

      const retryCount = attempt + 1;
      onRetryCount(retryCount);
      await delay(500 * 2 ** attempt);
    }
  }
}

function isRetryableError(error: unknown): boolean {
  if (["test_budget", "context_limit", "quota", "authentication"].includes(normalizeLlmError(error).type)) return false;
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { status?: number; code?: string; name?: string };

  return (
    candidate.status === 408 ||
    candidate.status === 409 ||
    candidate.status === 429 ||
    (typeof candidate.status === "number" && candidate.status >= 500) ||
    candidate.name === "APIConnectionError" ||
    candidate.code === "ECONNRESET" ||
    candidate.code === "ETIMEDOUT"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function recordFailure(
  agentRunId: string,
  error: unknown,
  latencyMs: number,
  metrics: { promptChars: number; retryCount: number }
): Promise<void> {
  const normalized = normalizeLlmError(error);

  await failAgentRun({
    agentRunId,
    error: normalized.type,
    errorMessage: normalized.message,
    latencyMs,
    promptChars: metrics.promptChars,
    retryCount: metrics.retryCount
  });
}
