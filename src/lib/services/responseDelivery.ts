import { AsyncLocalStorage } from "node:async_hooks";

export const RESPONSE_ATTEMPT_LIMIT = 2; // initial answer + one automatic recovery
const optionalResponse = new AsyncLocalStorage<boolean>();
export function withOptionalResponse<T>(operation: () => Promise<T>) { return optionalResponse.run(true, operation); }
export function isOptionalResponse() { return optionalResponse.getStore() === true; }
export const responseKey = (messageId: string, roleId: string) => JSON.stringify([messageId, roleId]);
export type DeliveryState = { attempts: number; skipped: boolean };

/** Count real deliveries, not empty executor clicks, Checker rewrites, or polls.
 * Legacy rows are read only; new receipts survive restarts without a new queue. */
export function summarizeResponseDeliveries(runs: Array<{ agentType: string; input: string; output: string | null; status: string }>) {
  const states = new Map<string, DeliveryState>();
  for (const run of runs) {
    const input = JSON.parse(run.input || "{}"), output = JSON.parse(run.output || "{}");
    let messageId: string | undefined, roles: string[] = [];
    if (run.agentType === "ai_response_delivery" && output.outcome !== "cancelled") {
      messageId = input.messageId; roles = [input.roleId];
    } else if (run.agentType === "discussion_reaction_executor" && !input.responseDeliveryPolicy) {
      messageId = input.latestMessageId;
      roles = [...new Set<string>((output.attempts ?? []).map((a: { roleId: string }) => a.roleId))];
    }
    if (!messageId) continue;
    for (const role of roles.filter(Boolean)) {
      const key = responseKey(messageId, role), attempts = (states.get(key)?.attempts ?? 0) + 1;
      states.set(key, { attempts, skipped: attempts >= RESPONSE_ATTEMPT_LIMIT });
    }
  }
  return states;
}
export async function getResponseDeliveries(gameId: string) {
  const { prisma } = await import("../db/prisma");
  const runs = await prisma.agentRun.findMany({ where: { gameSessionId: gameId,
    agentType: { in: ["ai_response_delivery", "discussion_reaction_executor"] } },
    select: { agentType: true, input: true, output: true, status: true } });
  return summarizeResponseDeliveries(runs);
}
export async function beginResponseDelivery(input: { gameId: string; messageId: string; roleId: string; actId: string; phase: string }) {
  const { createAgentRun } = await import("./agentRunService");
  return createAgentRun({ gameSessionId: input.gameId, agentType: "ai_response_delivery", runKind: "span", roleId: input.roleId,
    actId: input.actId, phase: input.phase, inputJson: { messageId: input.messageId, roleId: input.roleId, limit: RESPONSE_ATTEMPT_LIMIT } });
}
export async function finishResponseDelivery(id: string, outcome: "published" | "failed" | "cancelled", reason?: string) {
  const { completeAgentRun, failAgentRun } = await import("./agentRunService");
  if (outcome === "failed") await failAgentRun({ agentRunId: id, error: "ai_response_not_published", errorMessage: reason ?? "AI回应未发布",
    outputJson: { outcome, reason } });
  else await completeAgentRun({ agentRunId: id, outputJson: { outcome } });
}
export async function settleFailedDMResponse(gameId: string, messageId: string, roleId: string, reason?: string) {
  const state = (await getResponseDeliveries(gameId)).get(responseKey(messageId, roleId));
  const { getGameSession, updateGameSession } = await import("./gameService");
  const session = await getGameSession(gameId), pending = session.dmFlowCursor?.pendingDMQuestion;
  if (!pending || pending.messageId !== messageId || !session.aiRoleIds.includes(roleId) ||
    !pending.targetRoleNames.includes(roleId) || !["waiting", "partial_answered"].includes(pending.status)) return;
  if (!state?.skipped) {
    if (reason) await updateGameSession(gameId, { dmFlowCursor: { ...session.dmFlowCursor!, pendingDMQuestion: { ...pending, responseLastError: reason } } });
    return;
  }
  const skipped = [...new Set([...(pending.skippedRoleNames ?? []), roleId])];
  const { prisma } = await import("../db/prisma");
  const replies = await prisma.message.findMany({ where: { gameSessionId: gameId, replyToMessageId: messageId, speakerType: "ai_player" }, select: { speakerRoleId: true } });
  const softCueSettled = Boolean(pending.publicPointRuleId && pending.targetRoleNames.length && pending.targetRoleNames.every(role =>
    session.aiRoleIds.includes(role) && (skipped.includes(role) || replies.some(r => r.speakerRoleId === role))));
  await updateGameSession(gameId, { dmFlowCursor: { ...session.dmFlowCursor!, pendingDMQuestion: { ...pending,
    ...(softCueSettled ? { status: "closed" as const, closeReason: "ai_response_skipped" as const } : {}),
    skippedRoleNames: skipped, responseLastError: "角色回应重试仍未发布，保留未知并继续演绎。" } } });
}
