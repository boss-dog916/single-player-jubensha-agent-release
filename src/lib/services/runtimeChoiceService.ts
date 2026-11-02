import "server-only";
import { buildRuntimeChoicePrompt } from "./runtimeChoiceContext";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/src/lib/db/prisma";
import { generateStructured } from "@/src/lib/llm/llmClient";
import { SubmitRuntimeChoiceSchema, type RuntimeChoiceSubmission, type RuntimeChoiceView } from "@/src/lib/schemas/runtimeChoiceSchema";
import type { DMFlowCursor } from "@/src/lib/types/game";
import { getGameSession, buildAiPlayerContext } from "./gameService";
import { getScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import { assertDMTransactionFence, withConversation, conversationCheckpoint } from "./conversationService";
import { getRuntimeMode } from "./runtimeMode";
import { choiceRoleIds, choiceReceipts, choiceComplete } from "./runtimeChoiceState";
import { createAgentRun, completeAgentRun, failAgentRun } from "./agentRunService";

const MAX_ATTEMPTS = 2;
export class RuntimeChoiceError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
async function choiceContext(gameId: string) {
  const session = await getGameSession(gameId);
  if (!session.runtimeDefinitionId || getRuntimeMode(session) !== "runtime_auto" || !session.dmFlowCursor?.lifecycle ||
    session.dmFlowCursor.lifecycle.recoveryNeedsAttention) throw new RuntimeChoiceError("当前游戏不可提交选择。");
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const cursor = session.dmFlowCursor;
  if (cursor.lifecycle!.definitionId !== view.id || cursor.lifecycle!.definitionVersion !== view.version)
    throw new RuntimeChoiceError("剧本版本已变化，需要先恢复当前会话。");
  const nodes = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes) ?? [];
  return { session, view, cursor, nodes, node: nodes.find(n => n.nodeId === cursor.nodeId) };
}
async function saveCursor(gameId: string, before: DMFlowCursor, next: DMFlowCursor, actId: string) {
  await prisma.$transaction(async tx => {
    await assertDMTransactionFence(tx, gameId);
    const changed = await tx.gameSession.updateMany({ where: { id: gameId, runtimeDefinitionId: before.lifecycle!.definitionId,
      currentActId: actId, currentPhase: { in: ["free_discussion", "dm_question"] }, dmFlowCursorJson: JSON.stringify(before) },
      data: { dmFlowCursorJson: JSON.stringify(next) } });
    if (!changed.count) throw new RuntimeChoiceError("选择状态已变化，请刷新后重试。");
  });
}

// Internal AI actor is derived by the runner, never accepted from the public API.
async function commitChoice(gameId: string, input: RuntimeChoiceSubmission, roleId: string, aiToken?: string) {
  const { session, view, cursor, nodes, node } = await choiceContext(gameId);
  if (aiToken ? !session.aiRoleIds.includes(roleId) : roleId !== session.userRoleId) throw new RuntimeChoiceError("不能替其他角色选择。", 403);
  if (cursor.groupMatchingReceipts?.some(r => r.requestId === input.requestId)) throw new RuntimeChoiceError("requestId 已用于团队匹配。");
  const priorRequest = cursor.choiceReceipts?.find(r => r.requestId === input.requestId);
  if (priorRequest) {
    if (priorRequest.roleId === roleId && priorRequest.definitionId === view.id && priorRequest.definitionVersion === view.version &&
      priorRequest.choiceId === input.choiceId && priorRequest.nodeId === input.nodeId && priorRequest.actId === input.actId && priorRequest.optionId === input.optionId && priorRequest.reason === input.reason)
      return { receipt: priorRequest, duplicate: true };
    throw new RuntimeChoiceError("requestId 已用于另一项选择。");
  }
  const authored = nodes.find(n => n.nodeId === input.nodeId);
  if (authored?.choice?.type === "group_matching") throw new RuntimeChoiceError("团队匹配必须由真人完整提交，不能提交个人选项。", 400);
  if (authored?.choice?.choiceId !== input.choiceId || !authored.choice.options.some(o => o.optionId === input.optionId))
    throw new RuntimeChoiceError("非法的选择节点或 optionId。", 400);
  if (authored.choice.requiresReason ? !input.reason?.trim() : input.reason !== undefined) throw new RuntimeChoiceError("请为最终决定填写理由；普通选择不接受额外理由。", 400);
  if (cursor.choiceReceipts?.some(r => r.choiceId === input.choiceId && r.roleId === roleId)) throw new RuntimeChoiceError("该角色已提交，不能更改选择。");
  if (session.currentActId !== input.actId || node?.nodeId !== input.nodeId || node.actIndex !== cursor.actIndex ||
    input.actId !== `runtime_act_${node.actIndex}` || !["free_discussion", "dm_question"].includes(session.currentPhase) ||
    !cursor.consumedNodeIds.includes(node.nodeId) || cursor.completedNodeIds.includes(node.nodeId) ||
    cursor.textPresentation && !cursor.textPresentation.confirmed) throw new RuntimeChoiceError("尚未到达该选择节点，或节点已经完成。");
  if (!choiceRoleIds(node, session).includes(roleId)) throw new RuntimeChoiceError("该角色不是本节点的参与者。", 403);
  const attempt = cursor.choiceAttempts?.find(a => a.choiceId === input.choiceId && a.roleId === roleId);
  if (aiToken && (attempt?.token !== aiToken || attempt.status !== "running")) throw new RuntimeChoiceError("AI 选择任务已过期。");
  const receipt = { ...input, roleId, definitionId: view.id, definitionVersion: view.version, submittedAt: new Date().toISOString() };
  const next: DMFlowCursor = { ...cursor, choiceReceipts: [...(cursor.choiceReceipts ?? []), receipt],
    choiceAttempts: cursor.choiceAttempts?.map(a => a === attempt ? { ...a, status: "completed", lastError: undefined } : a) };
  if (choiceComplete(next, node, session)) next.completedNodeIds = [...new Set([...next.completedNodeIds, node.nodeId])];
  await saveCursor(gameId, cursor, next, input.actId);
  return { receipt, duplicate: false };
}

export async function submitHumanRuntimeChoice(gameId: string, raw: unknown) {
  const parsed = SubmitRuntimeChoiceSchema.safeParse(raw);
  if (!parsed.success) throw new RuntimeChoiceError("选择提交格式错误；不能指定其他角色。", 400);
  const result = await withConversation(gameId, "", async () => {
    await conversationCheckpoint(gameId);
    const session = await getGameSession(gameId);
    if (!session.userRoleId) throw new RuntimeChoiceError("请先选择自己的角色。", 403);
    const result = await commitChoice(gameId, parsed.data, session.userRoleId);
    if (!result.duplicate) await (await import("./dmLifecycleService")).runDMLifecycle({ gameSessionId: gameId, trigger: "discussion_turn_limit_reached" });
    return result;
  }, true);
  if (!result) throw new RuntimeChoiceError("对话正在处理中，请稍后使用相同 requestId 重试。");
  return result;
}

export async function getRuntimeChoiceView(gameId: string): Promise<RuntimeChoiceView | null> {
  const session = await getGameSession(gameId);
  if (!session.runtimeDefinitionId || !session.dmFlowCursor?.lifecycle || session.dmFlowCursor.lifecycle.recoveryNeedsAttention ||
    !["free_discussion", "dm_question"].includes(session.currentPhase) || getRuntimeMode(session) !== "runtime_auto") return null;
  const { node, cursor } = await choiceContext(gameId);
  if (!node?.choice || node.choice.type === "group_matching" || !cursor.consumedNodeIds.includes(node.nodeId) || cursor.completedNodeIds.includes(node.nodeId)) return null;
  const receipts = choiceReceipts(cursor, node), roles = choiceRoleIds(node, session);
  const own = receipts.find(r => r.roleId === session.userRoleId);
  return { choiceId: node.choice.choiceId, nodeId: node.nodeId, actId: session.currentActId, prompt: node.choice.prompt,
    options: node.choice.options, requiresReason: node.choice.requiresReason, endsGame: node.choice.endsGame, ownOptionId: own?.optionId ?? null, canSubmit: roles.includes(session.userRoleId!) && !own,
    participants: roles.map(roleId => {
      const attempt = cursor.choiceAttempts?.find(a => a.choiceId === node.choice!.choiceId && a.roleId === roleId);
      return { roleId, completed: receipts.some(r => r.roleId === roleId), attempts: attempt?.attempts ?? 0, error: attempt?.lastError };
    }) };
}

export async function runRuntimeAIChoices(gameId: string) {
  await (await import("./modelAvailabilityService")).assertModelAvailable(gameId);
  const original = await choiceContext(gameId);
  if (original.session.currentPhase === "finished" || original.view.definition.acts.some(a => `runtime_act_${a.actIndex}` === original.session.currentActId && a.modelPolicy === "disabled")) return;
  if (!original.node?.choice || original.node.choice.type === "group_matching") return;
  for (const roleId of choiceRoleIds(original.node, original.session).filter(r => original.session.aiRoleIds.includes(r))) {
    const ran = await withConversation(gameId, "", async () => {
      await conversationCheckpoint(gameId);
      const { session, node, cursor, view } = await choiceContext(gameId);
      if (view.id !== original.view.id || view.version !== original.view.version || session.currentActId !== original.session.currentActId ||
        node?.nodeId !== original.node!.nodeId || !node.choice || cursor.textPresentation && !cursor.textPresentation.confirmed || !cursor.consumedNodeIds.includes(node.nodeId) ||
        cursor.completedNodeIds.includes(node.nodeId) || choiceReceipts(cursor, node).some(r => r.roleId === roleId)) return true;
      const old = cursor.choiceAttempts?.find(a => a.choiceId === node.choice!.choiceId && a.roleId === roleId);
      if ((old?.attempts ?? 0) >= MAX_ATTEMPTS) return true;
      const token = randomUUID(), choiceId = node.choice.choiceId;
      const claim = { choiceId, roleId, attempts: (old?.attempts ?? 0) + 1, token, status: "running" as const };
      await saveCursor(gameId, cursor, { ...cursor, choiceAttempts: [...(cursor.choiceAttempts ?? []).filter(a => a !== old), claim] }, session.currentActId);
      const run = await createAgentRun({ gameSessionId: gameId, roleId, actId: session.currentActId, phase: session.currentPhase,
        agentType: "runtime_choice_submission", runKind: "span", inputJson: { choiceId, nodeId: node.nodeId, attempt: claim.attempts, token } });
      try {
        const context = await buildAiPlayerContext(gameId, roleId);
        const prepared = buildRuntimeChoicePrompt(context, node.choice);
        const schema = z.object({ optionId: z.enum(node.choice.options.map(o => o.optionId) as [string, ...string[]]) }).strict();
        const result = await generateStructured({ gameSessionId: gameId, roleId, actId: session.currentActId, phase: session.currentPhase,
          agentType: "ai_player_runtime_choice", taskProfile: "ai_player", schemaName: "runtime_option", zodSchema: schema,
          maxRetries: 0, timeoutMs: 6_000, maxOutputTokens: 100,
          metadata: { choiceContext: prepared.metrics },
          messages: prepared.messages });
        const output = schema.parse(result.data); // Validate even a custom client/Mock.
        if ((await conversationCheckpoint(gameId)).changed) throw new RuntimeChoiceError("公开上下文已更新，保留选择待办。");
        const saved = await commitChoice(gameId, { choiceId, nodeId: node.nodeId, actId: session.currentActId,
          optionId: output.optionId, requestId: token }, roleId, token);
        await completeAgentRun({ agentRunId: run.id, outputJson: saved, latencyMs: Date.now() - run.startedAt.getTime() });
      } catch (error) {
        const message = error instanceof Error ? error.message : "AI选择失败";
        await failAgentRun({ agentRunId: run.id, error: message, latencyMs: Date.now() - run.startedAt.getTime() });
        if ((await import("../llm/llmErrors")).normalizeLlmError(error).type === "context_limit")
          await (await import("./modelAvailabilityService")).recordModelFailure(gameId, error);
        const fresh = await choiceContext(gameId).catch(() => null);
        if (!fresh || fresh.view.id !== view.id || fresh.view.version !== view.version || fresh.session.currentActId !== session.currentActId) return true;
        const attempt = fresh.cursor.choiceAttempts?.find(a => a.token === token && a.status === "running");
        const paused = await (await import("./modelAvailabilityService")).getModelAvailability(gameId);
        if (fresh.node?.nodeId === node.nodeId && attempt) {
          // A stale worker can never overwrite another attempt or a receipt.
          await saveCursor(gameId, fresh.cursor, { ...fresh.cursor,
            choiceAttempts: fresh.cursor.choiceAttempts!.map(a => a === attempt ? { ...a, status: "failed", lastError: message,
              ...(paused ? { attempts: Math.max(0, a.attempts - 1) } : {}) } : a) }, fresh.session.currentActId).catch(() => null);
        }
        if (paused) throw error;
      }
      await (await import("./dmLifecycleService")).runDMLifecycle({ gameSessionId: gameId, trigger: "discussion_turn_limit_reached" });
      return true;
    }, true);
    if (!ran) return;
  }
}
