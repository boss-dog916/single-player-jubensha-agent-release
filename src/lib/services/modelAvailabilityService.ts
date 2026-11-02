import "server-only";
import { prisma } from "@/src/lib/db/prisma";
import { LlmClientError, modelFailureNotice, normalizeLlmError, type LlmErrorType } from "@/src/lib/llm/llmErrors";

// A durable failure/recovery receipt in existing AgentRun, not another game FSM.
// Player views expose only this safe notice, never provider messages or prompts.
const agentType = "model_availability";
const blocking = new Set<LlmErrorType>(["authentication", "quota", "test_budget", "context_limit", "rate_limit", "network", "timeout", "service_unavailable"]);
export async function getModelAvailability(gameId: string) {
  const row = await prisma.agentRun.findFirst({ where: { gameSessionId: gameId, agentType }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] });
  if (!row || row.status !== "failed") return null;
  const type = row.error as LlmErrorType;
  return { paused: true as const, code: type, message: modelFailureNotice(type), canResume: type !== "test_budget", since: row.startedAt.toISOString() };
}
export async function assertModelAvailable(gameId?: string | null) {
  if (!gameId) return;
  if (await (await import("./runtimeModelPolicy")).runtimeModelsDisabled(gameId)) return;
  const notice = await getModelAvailability(gameId);
  if (notice) throw new LlmClientError({ type: notice.code, message: notice.message });
}
export async function recordModelFailure(gameId: string | null | undefined, error: unknown) {
  const normalized = normalizeLlmError(error);
  if (!gameId || !blocking.has(normalized.type)) return;
  if (await getModelAvailability(gameId)) return;
  const session = await prisma.gameSession.findUnique({ where: { id: gameId } });
  if (!session) return;
  const prior = await prisma.agentRun.findFirst({ where: { gameSessionId: gameId, agentType }, orderBy: { startedAt: "desc" } });
  const startedAt = new Date(Math.max(Date.now(), (prior?.startedAt.getTime() ?? 0) + 1));
  await prisma.agentRun.create({ data: { gameSessionId: gameId, agentType, runKind: "span", actId: session.currentActId,
    phase: session.currentPhase, status: "failed", error: normalized.type, errorMessage: modelFailureNotice(normalized.type),
    input: "{}", output: "{}", startedAt, finishedAt: startedAt, latencyMs: 0 } });
}

export async function resumeModelExecution(gameId: string) {
  const { withConversation, deferConversationSeed, conversationCheckpoint } = await import("./conversationService");
  const result = await withConversation(gameId, "", async () => {
    await conversationCheckpoint(gameId);
    const issue = await getModelAvailability(gameId);
    if (!issue) return { resumed: false };
    if (!issue.canResume) throw new LlmClientError({ type: issue.code, message: issue.message });
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    const cursor = session.dmFlowCursorJson ? JSON.parse(String(session.dmFlowCursorJson)) : null;
    const question = cursor?.pendingDMQuestion;
    // Outage time must not consume an unanswered question's soft wait. The
    // original Message/asked-at evidence is untouched; only its live wait resets.
    if (question && ["waiting", "partial_answered"].includes(question.status)) question.askedAt = new Date().toISOString();
    const prior = await prisma.agentRun.findFirst({ where: { gameSessionId: gameId, agentType }, orderBy: { startedAt: "desc" } });
    await prisma.$transaction([
      ...(cursor ? [prisma.gameSession.update({ where: { id: gameId, dmFlowCursorJson: session.dmFlowCursorJson }, data: { dmFlowCursorJson: JSON.stringify(cursor) } })] : []),
      prisma.agentRun.create({ data: { gameSessionId: gameId, agentType, runKind: "span", status: "success", actId: session.currentActId,
        phase: session.currentPhase, input: "{}", output: JSON.stringify({ resumed: true }), startedAt: new Date(Math.max(Date.now(), (prior?.startedAt.getTime() ?? 0) + 1)), finishedAt: new Date(), latencyMs: 0 } })
    ]);
    const state = await prisma.conversationState.findUnique({ where: { gameSessionId: gameId } });
    const publicSeed = state?.seedMessageId ? await prisma.message.findFirst({ where: { id: state.seedMessageId, gameSessionId: gameId } }) : null;
    const humanBatch = publicSeed?.speakerType === "user" && state?.batchIdsJson !== "[]";
    // Preserve an unplanned human batch: the existing responder can prioritize
    // its pending DM question and then hand the human seed back as usual.
    const seed = humanBatch ? state!.seedMessageId : question && ["waiting", "partial_answered"].includes(question.status) ? question.messageId : state?.seedMessageId;
    const definition = session.runtimeDefinitionId ? await (await import("./scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(session.runtimeDefinitionId) : null;
    const node = definition?.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === cursor?.nodeId);
    // Choice work uses the existing text tick, not the chat seed. Leaving its
    // conversation pending would prevent the choice worker's control lease.
    if (seed && (!node?.choice || humanBatch)) await deferConversationSeed(gameId, seed);
    return { resumed: true };
  });
  if (!result) throw new Error("对话仍在处理中，请稍后恢复。");
  return result;
}
