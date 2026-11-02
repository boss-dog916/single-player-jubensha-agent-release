import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/db/prisma";
import { ShareRuntimeClueSchema, type ClueScope, type VisibleRuntimeClue, type CluePublication } from "@/src/lib/schemas/runtimeClueSchema";
import { getGameSession } from "./gameService";
import { getScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import { assertDMTransactionFence, conversationCheckpoint, withConversation } from "./conversationService";
import { getRuntimeMode } from "./runtimeMode";
import type { DMFlowCursor, GameSession } from "@/src/lib/types/game";
import { getMessage } from "./messageService";

export class RuntimeClueError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
async function context(gameId: string) {
  const session = await getGameSession(gameId), cursor = session.dmFlowCursor;
  if (!session.runtimeDefinitionId || getRuntimeMode(session) !== "runtime_auto" || !cursor?.lifecycle || cursor.lifecycle.recoveryNeedsAttention)
    throw new RuntimeClueError("当前线索状态不可用。");
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  if (cursor.lifecycle.definitionId !== view.id || cursor.lifecycle.definitionVersion !== view.version) throw new RuntimeClueError("线索定义版本已变化。");
  const roles = [session.userRoleId, ...session.aiRoleIds].filter((r): r is string => Boolean(r));
  const scope = { definitionId: view.id, definitionVersion: view.version, actId: session.currentActId };
  return { session, cursor, view, roles, scope };
}
const sameDefinition = (r: { definitionId: string; definitionVersion: number }, s: ClueScope) => r.definitionId === s.definitionId && r.definitionVersion === s.definitionVersion;
const grantFor = (cursor: DMFlowCursor, scope: ClueScope, clueId: string, roleId: string) =>
  cursor.clueGrants?.find(r => sameDefinition(r, scope) && r.clueId === clueId && r.roleId === roleId);
const permissionFor = (cursor: DMFlowCursor, scope: ClueScope, clueId: string, roleId: string) =>
  cursor.clueSharePermissions?.find(r => sameDefinition(r, scope) && r.clueId === clueId && r.roleId === roleId);

async function save(gameId: string, c: Awaited<ReturnType<typeof context>>, next: DMFlowCursor, publications: { receipt: CluePublication; text: string; title: string }[]) {
  await prisma.$transaction(async tx => {
    await assertDMTransactionFence(tx, gameId);
    const changed = await tx.gameSession.updateMany({ where: { id: gameId, runtimeDefinitionId: c.view.id, currentActId: c.scope.actId,
      currentPhase: c.session.currentPhase, dmFlowCursorJson: JSON.stringify(c.cursor) }, data: { dmFlowCursorJson: JSON.stringify(next) } });
    if (!changed.count) throw new RuntimeClueError("线索状态已变化，请刷新后重试。");
    const last = await tx.message.findFirst({ where: { gameSessionId: gameId }, orderBy: { createdAt: "desc" } });
    for (const [i, { receipt: r, text, title }] of publications.entries()) await tx.message.create({ data: {
      id: r.messageId, gameSessionId: gameId, speakerType: r.roleId === "dm" ? "dm" : r.roleId === c.session.userRoleId ? "user" : "ai_player",
      speakerRoleId: r.roleId, speakerName: r.roleId === "dm" ? "DM" : r.roleId, phase: c.session.currentPhase,
      speechAct: "statement", content: `【线索：${title}】\n${text}`, targetRoleIds: "[]",
      createdAt: new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1) + i),
      metadata: JSON.stringify({ act_id: r.actId, runtimeDefinitionId: r.definitionId, runtimeDefinitionVersion: r.definitionVersion,
        sourceNodeId: r.nodeId, sourceNodeType: "clue_release", clueId: r.clueId, storyBoardEligible: true,
        revealed_facts: [text], emotional_points: [], questions_raised: [], mentioned_role_ids: [], event_tags: [], topic_tags: [] })
    } });
  });
  // Also replay this idempotent queue step on duplicate requests after a crash.
  for (const { receipt } of publications) await queuePublicClue(gameId, receipt.messageId);
}
async function queuePublicClue(gameId: string, messageId: string) {
  const message = await getMessage(messageId);
  await (await import("./storyBoardQueueService")).enqueuePublicMessageForStoryBoard({ gameSessionId: gameId, message });
}

// Only called under the existing conversation lease by the current-node executor.
async function executeClueNodeLocked(gameId: string, expected: ClueScope & { nodeId: string }) {
  const c = await context(gameId), { session, cursor, view, scope, roles } = c;
  if (expected.definitionId !== scope.definitionId || expected.definitionVersion !== scope.definitionVersion || expected.actId !== scope.actId || expected.nodeId !== cursor.nodeId ||
    !["reading", "free_discussion", "dm_question"].includes(session.currentPhase) || cursor.textPresentation && !cursor.textPresentation.confirmed)
    throw new RuntimeClueError("线索节点已过期或尚未授权执行。");
  const nodes = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes) ?? [];
  const node = nodes.find(n => n.nodeId === expected.nodeId);
  if (!node?.clueAction || !["clue_release", "reading_start"].includes(node.type) || `runtime_act_${node.actIndex}` !== scope.actId) throw new RuntimeClueError("非法线索节点。");
  const errors = (await import("./dmLifecycleValidation")).validateDMLifecycle(view.definition, session.runtimeScope as import("./dmLifecycleValidation").DMLifecycleScope).filter(i => i.fatal);
  if (errors.length) throw new RuntimeClueError("线索节点未通过Runtime校验。");
  if (cursor.completedNodeIds.includes(node.nodeId)) {
    for (const r of cursor.cluePublications ?? []) if (sameDefinition(r, scope) && r.nodeId === node.nodeId) await queuePublicClue(gameId, r.messageId);
    return;
  }
  if ((await conversationCheckpoint(gameId)).changed) throw new RuntimeClueError("公开上下文已更新，稍后继续发放。");
  const next: DMFlowCursor = { ...cursor, clueGrants: [...(cursor.clueGrants ?? [])], clueSharePermissions: [...(cursor.clueSharePermissions ?? [])],
    cluePublications: [...(cursor.cluePublications ?? [])] };
  const publications: Parameters<typeof save>[3] = [], now = new Date().toISOString();
  for (const clueId of node.clueAction.clueIds) {
    const clue = view.definition.clues.find(c => c.clueId === clueId)!;
    const recipients = clue.visibility === "public" ? roles : clue.targetRoleNames;
    for (const roleId of recipients) {
      if (node.clueAction.action === "grant" && !grantFor(next, scope, clueId, roleId)) next.clueGrants!.push({ ...scope, clueId, roleId, nodeId: node.nodeId, grantedAt: now });
      if (node.clueAction.action === "allow_share" && !grantFor(next, scope, clueId, roleId)) throw new RuntimeClueError("线索尚未正式发放，不能允许公开。");
      if ((node.clueAction.action === "allow_share" || clue.visibility === "public") && !permissionFor(next, scope, clueId, roleId))
        next.clueSharePermissions!.push({ ...scope, clueId, roleId, nodeId: node.nodeId, allowedAt: now });
    }
    if (node.clueAction.action === "grant" && clue.visibility === "public" && !next.cluePublications!.some(r => sameDefinition(r, scope) && r.clueId === clueId)) {
      const receipt = { ...scope, clueId, roleId: "dm", nodeId: node.nodeId, requestId: `grant:${node.nodeId}:${clueId}`, messageId: randomUUID(), publishedAt: now };
      next.cluePublications!.push(receipt); publications.push({ receipt, text: clue.rawText!, title: clue.title });
    }
  }
  // A reading gate grants attachments on entry, but completes only after reading.
  if (node.type !== "reading_start") {
    next.consumedNodeIds = [...new Set([...next.consumedNodeIds, node.nodeId])];
    next.completedNodeIds = [...new Set([...next.completedNodeIds, node.nodeId])];
  }
  await save(gameId, c, next, publications);
}

export async function executeRuntimeClueNode(gameId: string, expected: ClueScope & { nodeId: string }) {
  const ran = await withConversation(gameId, "", async () => { await executeClueNodeLocked(gameId, expected); return true; }, true);
  if (!ran) throw new RuntimeClueError("对话正在处理，线索发放保留待办。");
}
export async function getRoleRuntimeClues(gameId: string, roleId: string, knownSession?: GameSession): Promise<VisibleRuntimeClue[]> {
  const session = knownSession ?? await getGameSession(gameId);
  if (session.gameId !== gameId) throw new RuntimeClueError("线索读取会话不匹配。");
  if (!session.runtimeDefinitionId || getRuntimeMode(session) !== "runtime_auto" || !session.dmFlowCursor?.lifecycle || session.dmFlowCursor.lifecycle.recoveryNeedsAttention) return [];
  // Existing games with no clue receipts must not reload/revalidate the full
  // definition on every snapshot, AI reading or discussion generation.
  if (!session.dmFlowCursor.clueGrants?.length && !session.dmFlowCursor.cluePublications?.length) return [];
  const c = await context(gameId);
  if (c.session.currentActId !== session.currentActId || c.view.id !== session.runtimeDefinitionId ||
    c.view.version !== session.dmFlowCursor.lifecycle.definitionVersion) throw new RuntimeClueError("线索读取阶段已变化，请刷新后重试。");
  if (!c.roles.includes(roleId)) throw new RuntimeClueError("非法线索读者。", 403);
  const receipts = (c.cursor.cluePublications ?? []).filter(r => sameDefinition(r, c.scope));
  const messages = receipts.length ? await prisma.message.findMany({ where: { gameSessionId: gameId, id: { in: receipts.map(r => r.messageId) } } }) : [];
  const confirmed = receipts.filter(r => {
    const clue = c.view.definition.clues.find(clue => clue.clueId === r.clueId);
    if (!clue?.rawText) return false;
    return messages.some(m => {
      if (m.id !== r.messageId || m.speakerRoleId !== r.roleId) return false;
      const meta = JSON.parse(m.metadata ?? "{}");
      return meta.clueId === clue.clueId && meta.runtimeDefinitionId === r.definitionId &&
        meta.runtimeDefinitionVersion === r.definitionVersion && meta.act_id === r.actId && m.content.includes(clue.rawText!);
    });
  });
  // Repair a crash between the durable publication and its ordinary queue step.
  // Only already-public Message evidence is queued, never private grant text.
  for (const r of confirmed) if (messages.find(m => m.id === r.messageId)?.storyBoardStatus === "not_queued") await queuePublicClue(gameId, r.messageId);
  return c.view.definition.clues.flatMap(clue => {
    const grant = grantFor(c.cursor, c.scope, clue.clueId, roleId);
    const publication = confirmed.find(r => r.clueId === clue.clueId);
    if (!grant && !publication) return [];
    return [{ clueId: clue.clueId, title: clue.title, text: clue.rawText ?? "", source: clue.source,
      ...(clue.pdf ? { pdfUrl: `/api/games/${gameId}/player-display/pdf?actIndex=${clue.releaseActIndex}&sectionId=${encodeURIComponent(clue.pdf.sourceDocumentSectionId)}` } : {}),
      visibility: publication ? "public" as const : "private" as const, granted: Boolean(grant), grantedAt: grant?.grantedAt ?? null,
      shareAllowed: Boolean(permissionFor(c.cursor, c.scope, clue.clueId, roleId)), publiclyShared: Boolean(publication), messageId: publication?.messageId ?? null }];
  });
}
export async function getPlayerRuntimeClues(gameId: string, knownSession?: GameSession) {
  const s = knownSession ?? await getGameSession(gameId); return s.userRoleId ? getRoleRuntimeClues(gameId, s.userRoleId, s) : [];
}

async function publish(gameId: string, roleId: string, input: { clueId: string; actId: string; requestId: string }, expected?: ClueScope) {
  const c = await context(gameId), { cursor, scope } = c;
  if (expected && (!sameDefinition(expected, scope) || expected.actId !== scope.actId)) throw new RuntimeClueError("AI线索分享任务已过期。");
  const prior = cursor.cluePublications?.find(r => r.requestId === input.requestId && sameDefinition(r, scope));
  if (prior && (prior.roleId !== roleId || prior.clueId !== input.clueId || prior.actId !== input.actId)) throw new RuntimeClueError("分享requestId冲突。");
  if (clueDisabled(c.view.definition, c.session.currentActId)) throw new RuntimeClueError("本幕只阅读私密资料，不开放线索公开。", 409);
  const window = await (await import("./runtimeInputPolicy")).runtimeInputPolicy(gameId);
  const alreadyPublic = cursor.cluePublications?.some(r => r.clueId === input.clueId && sameDefinition(r, scope));
  if (!alreadyPublic && window && (window.policy !== "directed_sharing" || !window.targets.includes(roleId)))
    throw new RuntimeClueError("当前独立回答或选择窗口尚未开放线索分享。", 409);
  if (!prior && (input.actId !== scope.actId || !["free_discussion", "dm_question"].includes(c.session.currentPhase))) throw new RuntimeClueError("当前阶段不能分享线索。");
  const clue = c.view.definition.clues.find(c => c.clueId === input.clueId);
  if (!c.roles.includes(roleId) || !clue || !grantFor(cursor, scope, input.clueId, roleId) || !permissionFor(cursor, scope, input.clueId, roleId))
    throw new RuntimeClueError("线索未发放给本人或尚未允许公开。", 403);
  const existing = cursor.cluePublications?.find(r => r.clueId === input.clueId && sameDefinition(r, scope));
  if (existing) { await queuePublicClue(gameId, existing.messageId); return { duplicate: true, messageId: existing.messageId }; }
  if ((await conversationCheckpoint(gameId)).changed) throw new RuntimeClueError("公开上下文已更新，保留分享待办。");
  const receipt: CluePublication = { ...scope, ...input, roleId, nodeId: cursor.nodeId!, messageId: randomUUID(), publishedAt: new Date().toISOString() };
  await save(gameId, c, { ...cursor, cluePublications: [...(cursor.cluePublications ?? []), receipt] }, [{ receipt, text: clue.rawText!, title: clue.title }]);
  return { duplicate: false, messageId: receipt.messageId };
}
export async function shareHumanRuntimeClue(gameId: string, raw: unknown) {
  const parsed = ShareRuntimeClueSchema.safeParse(raw);
  if (!parsed.success) throw new RuntimeClueError("分享格式错误，不能指定其他角色。", 400);
  const result = await withConversation(gameId, "", async () => {
    const s = await getGameSession(gameId);
    if (!s.userRoleId) throw new RuntimeClueError("请先选择角色。", 403);
    return publish(gameId, s.userRoleId, parsed.data);
  }, true);
  if (!result) throw new RuntimeClueError("对话正在处理，请以相同requestId重试。");
  return result;
}
async function shareAICluesLocked(gameId: string, roleId: string, clueIds: string[], expected: ClueScope) {
  const s = await getGameSession(gameId);
  if (!s.aiRoleIds.includes(roleId) || clueIds.length > 5 || new Set(clueIds).size !== clueIds.length) throw new RuntimeClueError("非法AI线索分享。", 403);
  // Preflight the whole batch before publishing any item.
  const clues = await getRoleRuntimeClues(gameId, roleId);
  if (clueIds.some(id => !clues.some(c => c.clueId === id && c.granted && c.shareAllowed))) throw new RuntimeClueError("AI不能分享未授权线索。", 403);
  const results = [];
  for (const clueId of clueIds) results.push(await publish(gameId, roleId, { clueId, actId: expected.actId, requestId: `ai:${expected.definitionId}:${expected.actId}:${roleId}:${clueId}` }, expected));
  return results;
}
export async function shareAIRuntimeClues(gameId: string, roleId: string, clueIds: string[], expected: ClueScope) {
  const result = await withConversation(gameId, "", () => shareAICluesLocked(gameId, roleId, clueIds, expected), true);
  if (!result) throw new RuntimeClueError("对话正在处理，AI线索分享保留待办。");
  return result;
}

function clueDisabled(d: import("./scriptRuntimeDefinitionService").ScriptRuntimeDefinitionJson, actId: string) { return d.acts.some(a => `runtime_act_${a.actIndex}` === actId && a.modelPolicy === "disabled"); }
