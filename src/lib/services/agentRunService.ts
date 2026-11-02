import type { AgentRun as PrismaAgentRun, Prisma } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import { getTraceContext } from "@/src/lib/observability/traceContext";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";

export type AgentRunStatus = "pending" | "success" | "failed";

export type AgentRunRecord = {
  id: string;
  gameSessionId: string;
  traceId: string | null;
  parentRunId: string | null;
  runKind: string;
  agentType: string;
  roleId: RoleId | null;
  actId: string | null;
  phase: string | null;
  inputJson: Prisma.JsonValue;
  outputJson: Prisma.JsonValue | null;
  checkerResultJson: Prisma.JsonValue | null;
  status: AgentRunStatus;
  error: string | null;
  errorMessage: string | null;
  model: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  promptChars: number | null;
  outputChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  retryCount: number | null;
  providerRequestId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateAgentRunInput = {
  id?: string;
  gameSessionId: string;
  traceId?: string | null;
  parentRunId?: string | null;
  runKind?: "interaction" | "span" | "llm";
  agentType: string;
  roleId?: RoleId | null;
  actId?: string | null;
  phase?: string | null;
  inputJson: unknown;
  model?: string | null;
  promptChars?: number | null;
};

export type AgentRunMetrics = {
  ttftMs?: number | null;
  promptChars?: number | null;
  outputChars?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  cachedInputTokens?: number | null;
  retryCount?: number | null;
  providerRequestId?: string | null;
};

export type CompleteAgentRunInput = AgentRunMetrics & {
  agentRunId: string;
  outputJson: unknown;
  checkerResultJson?: unknown;
  latencyMs?: number | null;
};

export type FailAgentRunInput = AgentRunMetrics & {
  agentRunId: string;
  error: string;
  errorMessage?: string | null;
  outputJson?: unknown;
  checkerResultJson?: unknown;
  latencyMs?: number | null;
};

export async function createAgentRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
  const context = getTraceContext();
  const record = await prisma.agentRun.create({
    data: {
      id: input.id,
      gameSessionId: input.gameSessionId,
      traceId: input.traceId ?? context?.traceId ?? null,
      parentRunId: input.parentRunId === undefined ? context?.parentRunId ?? null : input.parentRunId,
      runKind: input.runKind ?? "span",
      agentType: input.agentType,
      roleId: input.roleId ?? null,
      actId: input.actId ?? null,
      phase: input.phase ?? null,
      input: toJsonInput(input.inputJson),
      model: input.model ?? null,
      promptChars: input.promptChars ?? null,
      status: "pending",
      error: null
    }
  });

  return toAgentRunRecord(record);
}

export async function completeAgentRun({
  agentRunId,
  outputJson,
  checkerResultJson = null,
  latencyMs = null,
  ttftMs,
  promptChars,
  outputChars,
  inputTokens,
  outputTokens,
  reasoningTokens,
  cachedInputTokens,
  retryCount,
  providerRequestId
}: CompleteAgentRunInput): Promise<AgentRunRecord> {
  const record = await prisma.agentRun.update({
    where: { id: agentRunId },
    data: {
      output: toJsonInput(outputJson),
      checkerResult: checkerResultJson === null || checkerResultJson === undefined ? null : toJsonInput(checkerResultJson),
      status: "success",
      error: null,
      errorMessage: null,
      latencyMs,
      finishedAt: new Date(),
      ...definedMetrics({
        ttftMs,
        promptChars,
        outputChars,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedInputTokens,
        retryCount,
        providerRequestId
      })
    }
  });

  return toAgentRunRecord(record);
}

export async function failAgentRun({
  agentRunId,
  error,
  errorMessage = null,
  outputJson = null,
  checkerResultJson = null,
  latencyMs = null,
  ttftMs,
  promptChars,
  outputChars,
  inputTokens,
  outputTokens,
  reasoningTokens,
  cachedInputTokens,
  retryCount,
  providerRequestId
}: FailAgentRunInput): Promise<AgentRunRecord> {
  const record = await prisma.agentRun.update({
    where: { id: agentRunId },
    data: {
      output: outputJson === null || outputJson === undefined ? null : toJsonInput(outputJson),
      checkerResult: checkerResultJson === null || checkerResultJson === undefined ? null : toJsonInput(checkerResultJson),
      status: "failed",
      error,
      errorMessage,
      latencyMs,
      finishedAt: new Date(),
      ...definedMetrics({
        ttftMs,
        promptChars,
        outputChars,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cachedInputTokens,
        retryCount,
        providerRequestId
      })
    }
  });

  return toAgentRunRecord(record);
}

export async function listAgentRuns(gameSessionId: string): Promise<AgentRunRecord[]> {
  const records = await prisma.agentRun.findMany({
    where: { gameSessionId },
    orderBy: { createdAt: "asc" }
  });

  return records.map(toAgentRunRecord);
}

export async function getAgentRun(agentRunId: string): Promise<AgentRunRecord | null> {
  const record = await prisma.agentRun.findUnique({
    where: { id: agentRunId }
  });

  return record ? toAgentRunRecord(record) : null;
}

export async function listRecentAgentRuns(
  gameSessionId: string,
  agentTypes: string[],
  limit = 8
): Promise<AgentRunRecord[]> {
  const records = await prisma.agentRun.findMany({
    where: {
      gameSessionId,
      ...(agentTypes.length > 0
        ? {
            agentType: {
              in: agentTypes
            }
          }
        : {})
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  return records.map(toAgentRunRecord);
}

export async function listAgentRunsByTraceId(traceId: string): Promise<AgentRunRecord[]> {
  const records = await prisma.agentRun.findMany({
    where: { traceId },
    orderBy: [{ startedAt: "asc" }, { createdAt: "asc" }]
  });

  return records.map(toAgentRunRecord);
}

export async function getLatestAgentRunForRole(input: {
  gameSessionId: string;
  agentType: string;
  roleId: RoleId;
  actId: string;
}): Promise<AgentRunRecord | null> {
  const record = await prisma.agentRun.findFirst({
    where: {
      gameSessionId: input.gameSessionId,
      agentType: input.agentType,
      roleId: input.roleId,
      actId: input.actId
    },
    orderBy: { createdAt: "desc" }
  });

  return record ? toAgentRunRecord(record) : null;
}

function toAgentRunRecord(record: PrismaAgentRun): AgentRunRecord {
  return {
    id: record.id,
    gameSessionId: record.gameSessionId,
    traceId: record.traceId,
    parentRunId: record.parentRunId,
    runKind: record.runKind,
    agentType: record.agentType,
    roleId: record.roleId,
    actId: record.actId,
    phase: record.phase,
    inputJson: fromJsonValue<Prisma.JsonValue>(record.input, null),
    outputJson: fromJsonValue<Prisma.JsonValue | null>(record.output, null),
    checkerResultJson: fromJsonValue<Prisma.JsonValue | null>(record.checkerResult, null),
    status: record.status as AgentRunStatus,
    error: record.error,
    errorMessage: record.errorMessage,
    model: record.model,
    latencyMs: record.latencyMs,
    ttftMs: record.ttftMs,
    promptChars: record.promptChars,
    outputChars: record.outputChars,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    reasoningTokens: record.reasoningTokens,
    cachedInputTokens: record.cachedInputTokens,
    retryCount: record.retryCount,
    providerRequestId: record.providerRequestId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function definedMetrics(metrics: AgentRunMetrics): Prisma.AgentRunUpdateInput {
  return Object.fromEntries(
    Object.entries(metrics).filter(([, value]) => value !== undefined)
  ) as Prisma.AgentRunUpdateInput;
}
