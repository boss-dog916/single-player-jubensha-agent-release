import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/db/prisma";
import { SubmitGroupMatchingSchema, publicMatchingReceipt, type GroupMatchingView, type GroupMatchingReceipt } from "@/src/lib/schemas/runtimeChoiceSchema";
import type { DMFlowCursor } from "@/src/lib/types/game";
import { getGameSession } from "./gameService";
import { getScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import { getRuntimeMode } from "./runtimeMode";
import { choiceRoleIds, matchingReceipt } from "./runtimeChoiceState";
import { RuntimeChoiceError } from "./runtimeChoiceService";
import { authorizedMatchingHint, validateMatchingAssignments, scoreMatching } from "./groupMatchingKeyService";
import { assertDMTransactionFence, withConversation, conversationCheckpoint } from "./conversationService";
import { listMessages } from "./messageService";
import { createAgentRun, completeAgentRun, failAgentRun } from "./agentRunService";

export async function getGroupMatchingView(gameId: string): Promise<GroupMatchingView | null> {
  const session = await getGameSession(gameId), cursor = session.dmFlowCursor;
  if (!session.runtimeDefinitionId || !cursor?.lifecycle || cursor.lifecycle.recoveryNeedsAttention || getRuntimeMode(session) !== "runtime_auto") return null;
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const node = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === cursor.nodeId);
  if (node?.choice?.type !== "group_matching" || !cursor.consumedNodeIds.includes(node.nodeId)) return null;
  const choice = node.choice;
  return { choiceId: choice.choiceId, nodeId: node.nodeId, actId: session.currentActId, round: choice.round, maxRounds: choice.maxRounds,
    prompt: choice.prompt, roleIds: node.targetRoleNames, options: choice.options,
    history: (cursor.groupMatchingReceipts ?? []).filter(r => r.definitionId === view.id && r.definitionVersion === view.version && r.choiceId === choice.choiceId && r.round <= choice.round).map(publicMatchingReceipt),
    hint: await authorizedMatchingHint(view.id, choice.choiceId, choice.round),
    canSubmit: Boolean(session.userRoleId && choiceRoleIds(node, session).includes(session.userRoleId) &&
      ["free_discussion", "dm_question"].includes(session.currentPhase) && !matchingReceipt(cursor, node)) };
}

// Like human chat insertion, this may commit while an AI owns the conversation
// lease. CAS protects the node; revision invalidates old generation commits.
// Never revoke another worker's lease, and never wait for optional AI opinions.
export async function submitGroupMatching(gameId: string, raw: unknown) {
  const parsed = SubmitGroupMatchingSchema.safeParse(raw);
  if (!parsed.success) throw new RuntimeChoiceError("完整分配提交格式错误。", 400);
  const input = parsed.data, session = await getGameSession(gameId);
  if (!session.runtimeDefinitionId || !session.userRoleId || getRuntimeMode(session) !== "runtime_auto") throw new RuntimeChoiceError("只有当前真人代表可以提交。", 403);
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const node = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === input.nodeId);
  if (node?.choice?.type !== "group_matching" || node.choice.choiceId !== input.choiceId || node.choice.round !== input.round)
    throw new RuntimeChoiceError("非法团队匹配节点或轮次。", 400);
  let assignments: ReturnType<typeof validateMatchingAssignments>;
  try { assignments = validateMatchingAssignments(node, input.assignments); }
  catch { throw new RuntimeChoiceError("每名角色和每个选项必须恰好出现一次。", 400); }
  const result = await prisma.$transaction(async tx => {
    const row = await tx.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    const cursor = row.dmFlowCursorJson ? JSON.parse(row.dmFlowCursorJson) as DMFlowCursor : null;
    if (row.userRoleId !== session.userRoleId || row.runtimeDefinitionId !== view.id || cursor?.lifecycle?.definitionId !== view.id ||
      cursor.lifecycle.definitionVersion !== view.version || cursor.lifecycle.recoveryNeedsAttention) throw new RuntimeChoiceError("会话身份或定义已变化。");
    const old = cursor.groupMatchingReceipts?.find(r => r.requestId === input.requestId);
    if (old) {
      if (old.nodeId === node.nodeId && old.round === input.round && old.choiceId === input.choiceId && old.actId === input.actId &&
        old.submittedByRoleId === row.userRoleId && JSON.stringify(old.assignments) === JSON.stringify(assignments)) return { receipt: publicMatchingReceipt(old), duplicate: true };
      throw new RuntimeChoiceError("requestId 已用于另一项提交。");
    }
    if (cursor.choiceReceipts?.some(r => r.requestId === input.requestId)) throw new RuntimeChoiceError("requestId 已用于个人选择。");
    if (matchingReceipt(cursor, node)) throw new RuntimeChoiceError("本轮已经提交，只能在后续回合重新分配。");
    if (cursor.nodeId !== node.nodeId || row.currentActId !== input.actId || input.actId !== `runtime_act_${node.actIndex}` ||
      cursor.actIndex !== node.actIndex || !["free_discussion", "dm_question"].includes(row.currentPhase) ||
      !cursor.consumedNodeIds.includes(node.nodeId) || cursor.completedNodeIds.includes(node.nodeId) ||
      cursor.textPresentation && !cursor.textPresentation.confirmed) throw new RuntimeChoiceError("尚未到达可提交的匹配回合。");
    if (!node.targetRoleNames.includes(row.userRoleId!)) throw new RuntimeChoiceError("真人不是本次团队的参与者。", 403);
    if (input.round > 1 && !cursor.groupMatchingReceipts?.some(r => r.definitionId === view.id && r.definitionVersion === view.version &&
      r.choiceId === input.choiceId && r.round === input.round - 1)) throw new RuntimeChoiceError("上一轮尚未提交。");
    const correctCount = await scoreMatching(tx, view.id, node, assignments);
    const receipt: GroupMatchingReceipt = { ...input, assignments, definitionId: view.id, definitionVersion: view.version,
      submittedByRoleId: row.userRoleId!, correctCount, submittedAt: new Date().toISOString(),
      resultStatus: node.choice?.type === "group_matching" && node.choice.resultMode === "deferred" ? "pending" : "published" };
    const next: DMFlowCursor = { ...cursor, groupMatchingReceipts: [...(cursor.groupMatchingReceipts ?? []), receipt],
      completedNodeIds: [...new Set([...cursor.completedNodeIds, node.nodeId])],
      textPresentation: { nodeId: node.nodeId, token: randomUUID(), kind: "continue", offset: 0, confirmed: false } };
    const updated = await tx.gameSession.updateMany({ where: { id: gameId, userRoleId: row.userRoleId, runtimeDefinitionId: view.id,
      currentActId: input.actId, currentPhase: row.currentPhase, dmFlowCursorJson: row.dmFlowCursorJson }, data: { dmFlowCursorJson: JSON.stringify(next) } });
    if (!updated.count) throw new RuntimeChoiceError("分配状态已变化，请刷新后用原requestId重试。");
    if (receipt.resultStatus !== "pending") {
      const last = await tx.message.findFirst({ where: { gameSessionId: gameId }, orderBy: { createdAt: "desc" } });
      await tx.message.create({ data: { gameSessionId: gameId, speakerType: "dm", speakerRoleId: "dm", speakerName: "DM", phase: row.currentPhase,
        speechAct: "statement", targetRoleIds: "[]", content: `第${input.round}轮：本轮答对${correctCount}人。`,
        createdAt: new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)),
        metadata: JSON.stringify({ act_id: input.actId, runtimeDefinitionId: view.id, runtimeDefinitionVersion: view.version,
          sourceNodeId: node.nodeId, sourceNodeType: "dm_prompt", sourceMode: "script_fixed", source: "script_fixed", storyBoardEligible: false,
          groupMatchingResult: true, choiceId: input.choiceId, round: input.round, revealed_facts: [], emotional_points: [], questions_raised: [],
          mentioned_role_ids: [], event_tags: [], topic_tags: [] }) } });
    }
    await tx.conversationState.updateMany({ where: { gameSessionId: gameId }, data: { revision: { increment: 1 } } });
    return { receipt: publicMatchingReceipt(receipt), duplicate: false };
  });
  void (await import("./dmTextFlowService")).scheduleTextDMTick(gameId).catch(() => null);
  return result;
}

export async function runGroupMatchingDiscussion(gameId: string) {
  return withConversation(gameId, "", async () => {
    const session = await getGameSession(gameId), cursor = session.dmFlowCursor;
    if (!cursor || !session.runtimeDefinitionId || cursor.groupMatchingDiscussionNodeIds?.includes(cursor.nodeId!)) return;
    const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
    const node = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === cursor.nodeId);
    if (node?.choice?.type !== "group_matching" || matchingReceipt(cursor, node) || !cursor.consumedNodeIds.includes(node.nodeId) ||
      !node.choice.inviteRoleNames.some(r => session.aiRoleIds.includes(r))) return;
    await conversationCheckpoint(gameId);
    const seed = (await listMessages(gameId)).find(m => m.metadata.sourceNodeId === node.nodeId && m.metadata.groupMatchingDiscussion === true);
    if (!seed) return;
    await prisma.$transaction(async tx => {
      await assertDMTransactionFence(tx, gameId);
      const changed = await tx.gameSession.updateMany({ where: { id: gameId, runtimeDefinitionId: view.id, currentActId: session.currentActId,
        dmFlowCursorJson: JSON.stringify(cursor) }, data: { dmFlowCursorJson: JSON.stringify({ ...cursor,
          groupMatchingDiscussionNodeIds: [...(cursor.groupMatchingDiscussionNodeIds ?? []), node.nodeId] }) } });
      if (!changed.count) throw new RuntimeChoiceError("匹配讨论位置已变化。");
    });
    const run = await createAgentRun({ gameSessionId: gameId, agentType: "group_matching_discussion", runKind: "span",
      actId: session.currentActId, phase: session.currentPhase, inputJson: { nodeId: node.nodeId, seedMessageId: seed.message_id } });
    try {
      const result = await (await import("@/src/lib/orchestration/autoDiscussionRunner")).runAutoDiscussionAfterMessage({ gameId, seedMessageId: seed.message_id,
        budget: { maxReactionWaves: 1, maxTotalAiReplies: 2, maxRepliesPerWave: 2, allowFollowupAfterAiReply: false, shouldCloseWithDm: false } });
      await completeAgentRun({ agentRunId: run.id, outputJson: { totalAiReplies: result.totalAiReplies, stopReason: result.stopReason } });
    } catch (error) { await failAgentRun({ agentRunId: run.id, error: error instanceof Error ? error.message : "匹配建议生成失败" }); }
  }, true);
}
