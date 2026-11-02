import "server-only";
import { applicationDatabaseUrl, RUNTIME_BASELINE } from "./runtimeBaseline";

const DEFAULT_OPENAI_MODEL = "qwen3.8-flash";
const DEFAULT_LLM_TIMEOUT_MS = RUNTIME_BASELINE.timeoutMs;

export type ServerEnv = {
  databaseUrl: string | undefined;
  openaiApiKey: string | undefined;
  openaiBaseUrl: string | undefined;
  openaiModel: string;
  llmTimeoutMs: number;
};

export function getServerEnv(): ServerEnv {
  if (process.env.NEXT_PUBLIC_OPENAI_API_KEY) {
    throw new Error("NEXT_PUBLIC_OPENAI_API_KEY must not be used. Use server-only OPENAI_API_KEY.");
  }

  return {
    databaseUrl: applicationDatabaseUrl(),
    openaiApiKey: optionalEnv(process.env.OPENAI_API_KEY),
    openaiBaseUrl: optionalEnv(process.env.OPENAI_BASE_URL),
    openaiModel: optionalEnv(process.env.OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL,
    llmTimeoutMs: parsePositiveInteger(process.env.LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS)
  };
}

export function hasOpenAiApiKey(): boolean {
  return Boolean(getServerEnv().openaiApiKey);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed ? trimmed : undefined;
}
