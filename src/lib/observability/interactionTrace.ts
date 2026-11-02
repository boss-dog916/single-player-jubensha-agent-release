import "server-only";

import { randomUUID } from "node:crypto";
import {
  completeAgentRun,
  createAgentRun,
  failAgentRun
} from "@/src/lib/services/agentRunService";
import { runInTraceContext } from "@/src/lib/observability/traceContext";

export type TracedInteractionResult<T> = {
  traceId: string;
  value: T;
};

export class InteractionTraceError extends Error {
  readonly traceId: string;
  readonly originalError: unknown;

  constructor(traceId: string, error: unknown) {
    super(error instanceof Error ? error.message : "Interaction failed.");
    this.name = "InteractionTraceError";
    this.traceId = traceId;
    this.originalError = error;
  }
}

export async function runTracedInteraction<T>(input: {
  gameSessionId: string;
  action: string;
  phase?: string | null;
  inputJson?: unknown;
  callback: () => Promise<T>;
}): Promise<TracedInteractionResult<T>> {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const root = await createAgentRun({
    id: traceId,
    gameSessionId: input.gameSessionId,
    traceId,
    parentRunId: null,
    runKind: "interaction",
    agentType: `interaction:${input.action}`,
    phase: input.phase,
    inputJson: input.inputJson ?? {}
  });

  try {
    const value = await runInTraceContext(
      { traceId, parentRunId: root.id },
      input.callback
    );

    await completeAgentRun({
      agentRunId: root.id,
      outputJson: { completed: true },
      latencyMs: Date.now() - startedAt
    });

    return { traceId, value };
  } catch (error) {
    await failAgentRun({
      agentRunId: root.id,
      error: "interaction_failed",
      errorMessage: error instanceof Error ? error.message : "Interaction failed.",
      latencyMs: Date.now() - startedAt
    });

    throw new InteractionTraceError(traceId, error);
  }
}

export function unwrapInteractionTraceError(error: unknown): {
  traceId: string | null;
  error: unknown;
} {
  return error instanceof InteractionTraceError
    ? { traceId: error.traceId, error: error.originalError }
    : { traceId: null, error };
}
