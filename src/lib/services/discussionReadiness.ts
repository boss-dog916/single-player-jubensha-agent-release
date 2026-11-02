import { getResponseDeliveries, responseKey, type DeliveryState } from "./responseDelivery";
import { explicitUserAddressing, responseInQuestionThread } from "./discussionReply";
import type { GameSession, Message } from "../types/game";
import type { ScriptRuntimeDefinitionJson } from "./scriptRuntimeDefinitionService";
import { publicDiscussionRoster, resolveAddressing } from "../orchestration/addressingResolution";
import { isActualDiscussionQuestion } from "./discussionPacing";

// Derive readiness from public receipts. No secret facts, new Agent or timer-
// based permission grant. An unconfirmed start gate still belongs to discussion.
export function activeDiscussionNode(session: Pick<GameSession, "currentActId" | "dmFlowCursor">, definition: ScriptRuntimeDefinitionJson) {
  const nodes = definition.dmFlow?.actFlows.find(f => `runtime_act_${f.actIndex}` === session.currentActId)?.nodes ?? [];
  const index = nodes.findIndex(n => n.nodeId === session.dmFlowCursor?.nodeId);
  if (index < 0) return null;
  if (nodes[index]?.discussionExit) return nodes[index];
  const gate = session.dmFlowCursor?.textPresentation;
  if (gate?.kind === "start" && !gate.confirmed && gate.offset === 0) {
    const prior = nodes.slice(0, index).reverse().find(n => n.discussionExit);
    return prior && session.dmFlowCursor?.completedNodeIds.includes(prior.nodeId) ? prior : null;
  }
  return null;
}

export function discussionReadiness(session: Pick<GameSession, "currentActId" | "currentPhase" | "dmFlowCursor" | "aiRoleIds" | "userRoleId">,
  definition: ScriptRuntimeDefinitionJson, messages: Message[], now = Date.now(), deliveries = new Map<string, DeliveryState>()) {
  if (definition.acts.some(a => `runtime_act_${a.actIndex}` === session.currentActId && a.modelPolicy === "disabled")) return null;
  const node = activeDiscussionNode(session, definition);
  if (!node) return null;
  const publicMessages = messages.filter(m => m.metadata.act_id === session.currentActId &&
    ["free_discussion", "share_round", "dm_question"].includes(m.phase) && ["user", "ai_player"].includes(m.speaker_type));
  const byId = new Map(messages.map(m => [m.message_id, m]));
  const baseline = publicMessages.filter(m => m.speaker_type === "user" || m.metadata.discussionPublicationMode === "act_share" ||
    !m.metadata.discussionPublicationMode && (m.speech_act === "share" || m.speech_act === "clarify" &&
      byId.get(m.reply_to_message_id ?? "")?.speaker_type === "dm" &&
      byId.get(m.reply_to_message_id ?? "")?.metadata.sourceNodeId === node.nodeId &&
      !byId.get(m.reply_to_message_id ?? "")?.metadata.conditionalRuleId));
  const sharedRoleIds = [...new Set(baseline.map(m => m.speaker_role_id).filter((id): id is string => Boolean(id)))];
  const pendingRoleIds = session.aiRoleIds.filter(id => !sharedRoleIds.includes(id));
  const humanExpressed = Boolean(session.userRoleId && sharedRoleIds.includes(session.userRoleId));
  const roster = publicDiscussionRoster(definition.roles.map(r => ({ role_id: r.roleName, name: r.roleName })), messages);
  const questions = publicMessages.filter(m => isActualDiscussionQuestion(m) &&
    !(m.speaker_type === "ai_player" && m.metadata.discussionFollowupAllowed === false)).flatMap(m => {
    const heuristic = resolveAddressing(m.content, roster);
    const address = explicitUserAddressing(m, roster, heuristic) ?? heuristic;
    // Clear direct questions and natural AI "you" questions have durable
    // recipients. A general invitation does not require five compulsory replies.
    const targets = address.addressingMode === "direct" ? address.directTargets :
      m.speaker_type === "ai_player" && !/大家|各位|你们/.test(m.content) ? m.target_role_ids ?? [] : [];
    return targets.filter(id => session.aiRoleIds.includes(id) && id !== m.speaker_role_id).map(roleId => ({ messageId: m.message_id, roleId,
      answered: publicMessages.some(a => a.speaker_role_id === roleId && responseInQuestionThread(a, m.message_id, byId)) }));
  });
  const skippedQuestions = questions.filter(q => !q.answered && deliveries.get(responseKey(q.messageId, q.roleId))?.skipped).map(({ messageId, roleId }) => ({ messageId, roleId }));
  const pendingQuestions = questions.filter(q => !q.answered && !deliveries.get(responseKey(q.messageId, q.roleId))?.skipped).map(({ messageId, roleId }) => ({ messageId, roleId }));
  const pendingQuestionDetails = pendingQuestions.map(q => {
    const message = byId.get(q.messageId)!;
    return { ...q, questionText: message.content, askerName: message.speaker_name ?? message.speaker_role_id,
      source: message.speaker_type };
  });
  const lastPublicAt = Math.max(0, ...publicMessages.map(m => m.created_at?.getTime() ?? 0));
  const configured = Number(process.env.DISCUSSION_QUIET_MS ?? 45_000);
  if (!Number.isInteger(configured) || configured < 0) throw new Error("DISCUSSION_QUIET_MS must be a non-negative integer");
  const quietMs = Math.min(configured, node.discussionExit!.maxWaitMs);
  const quietUntil = lastPublicAt + quietMs;
  const everyoneShared = !pendingRoleIds.length && humanExpressed;
  const ready = everyoneShared && !pendingQuestions.length && now >= quietUntil;
  const guidanceStarted = messages.some(m => m.metadata.act_id === session.currentActId && m.speaker_type === "dm" &&
    m.metadata.sourceNodeId === node.nodeId && Boolean(m.metadata.conditionalRuleId));
  return { nodeId: node.nodeId, sharedRoleIds, pendingRoleIds, humanExpressed, pendingQuestions, pendingQuestionDetails, skippedQuestions,
    answeredExchangeCount: questions.filter(q => q.answered).length, quietUntil, quietMs, ready,
    canGuide: everyoneShared && !pendingQuestions.length && (guidanceStarted || ready),
    reason: pendingRoleIds.length ? "awaiting_baseline_shares" : !humanExpressed ? "awaiting_human_share" :
      pendingQuestions.length ? "awaiting_direct_answers" : !ready ? "discussion_settling" : "discussion_ready" };
}

export async function getDiscussionReadiness(gameId: string) {
  const { getGameSession } = await import("./gameService");
  const session = await getGameSession(gameId);
  if (!session.runtimeDefinitionId) return null;
  const { definition } = await (await import("./scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const messages = await (await import("./messageService")).listMessages(gameId);
  return discussionReadiness(session, definition, messages, Date.now(), await getResponseDeliveries(gameId));
}

// At most initial delivery + one recovery; failed attempts remain unconfirmed.
export async function nextUnansweredDiscussionQuestion(gameId: string) {
  return (await getDiscussionReadiness(gameId))?.pendingQuestions[0] ?? null;
}
