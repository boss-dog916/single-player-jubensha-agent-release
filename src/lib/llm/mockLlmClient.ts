import "server-only";

import { completeAgentRun, createAgentRun, failAgentRun } from "@/src/lib/services/agentRunService";
import { LlmClientError, normalizeLlmError, throwLlmError } from "@/src/lib/llm/llmErrors";
import type {
  GenerateStructuredInput,
  GenerateStructuredResult,
  GenerateTextInput,
  GenerateTextResult,
  LlmClient
} from "@/src/lib/llm/llmTypes";

const MOCK_MODEL = "mock-llm";

export function createMockLlmClient(): LlmClient {
  return {
    generateText,
    generateStructured
  };
}

async function generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
  const startedAt = Date.now();
  const promptChars = countPromptChars(input);
  const agentRun = input.gameSessionId
    ? await createAgentRun({
        gameSessionId: input.gameSessionId,
        agentType: input.agentType,
        roleId: input.roleId,
        actId: input.actId,
        phase: input.phase,
        model: input.model ?? MOCK_MODEL,
        runKind: "llm",
        promptChars,
        inputJson: {
          prompt: input.prompt,
          messages: input.messages,
          metadata: input.metadata,
          reasoningEffort: input.reasoningEffort,
          maxOutputTokens: input.maxOutputTokens
        }
      })
    : null;
  const text = input.prompt
    ? `[mock] ${input.prompt.slice(0, 160)}`
    : "[mock] LLM text response.";
  const latencyMs = Date.now() - startedAt;

  if (agentRun) {
    await completeAgentRun({
      agentRunId: agentRun.id,
      outputJson: { text },
      latencyMs,
      promptChars,
      outputChars: text.length,
      retryCount: 0
    });
  }

  return {
    text,
    model: input.model ?? MOCK_MODEL,
    latencyMs,
    agentRunId: agentRun?.id ?? ""
  };
}

async function generateStructured<T>(
  input: GenerateStructuredInput<T>
): Promise<GenerateStructuredResult<T>> {
  const startedAt = Date.now();
  const promptChars = countPromptChars(input);
  const agentRun = input.gameSessionId
    ? await createAgentRun({
        gameSessionId: input.gameSessionId,
        agentType: input.agentType,
        roleId: input.roleId,
        actId: input.actId,
        phase: input.phase,
        model: input.model ?? MOCK_MODEL,
        runKind: "llm",
        promptChars,
        inputJson: {
          prompt: input.prompt,
          messages: input.messages,
          metadata: input.metadata,
          reasoningEffort: input.reasoningEffort,
          maxOutputTokens: input.maxOutputTokens,
          schemaName: input.schemaName,
          jsonSchema: input.jsonSchema ?? null,
          hasZodSchema: Boolean(input.zodSchema)
        }
      })
    : null;

  try {
    const fallbackOutput = input.mockOutput ?? createJsonSchemaMockOutput(input.jsonSchema);
    const data = input.zodSchema ? input.zodSchema.parse(fallbackOutput) : (fallbackOutput as T);
    const latencyMs = Date.now() - startedAt;

    if (agentRun) {
      await completeAgentRun({
        agentRunId: agentRun.id,
        outputJson: { data },
        latencyMs,
        promptChars,
        outputChars: JSON.stringify(data).length,
        retryCount: 0
      });
    }

    return {
      data,
      rawText: JSON.stringify(data),
      model: input.model ?? MOCK_MODEL,
      latencyMs,
      agentRunId: agentRun?.id ?? ""
    };
  } catch (error) {
    const normalized = normalizeLlmError(error);

    if (agentRun) {
      await failAgentRun({
        agentRunId: agentRun.id,
        error: normalized.type,
        errorMessage: normalized.message,
        latencyMs: Date.now() - startedAt,
        promptChars,
        retryCount: 0
      });
    }

    throwLlmError(new LlmClientError(normalized));
  }
}

function countPromptChars(input: GenerateTextInput | GenerateStructuredInput<unknown>): number {
  if (input.messages) {
    return input.messages.reduce((total, message) => total + message.content.length, 0);
  }

  return input.prompt?.length ?? 0;
}

function createJsonSchemaMockOutput(jsonSchema: GenerateStructuredInput<unknown>["jsonSchema"]) {
  const properties = jsonSchema?.properties;

  if (!properties) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const schema = value as { type?: string; items?: unknown };

      if (schema.type === "array") {
        return [key, []];
      }

      if (schema.type === "number" || schema.type === "integer") {
        return [key, 0];
      }

      if (schema.type === "boolean") {
        return [key, false];
      }

      if (schema.type === "object") {
        return [key, {}];
      }

      return [key, ""];
    })
  );
}
