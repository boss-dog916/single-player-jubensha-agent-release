import { publicDiscussionRoster, resolveAddressing } from "../orchestration/addressingResolution";
import { explicitUserAddressing, responseInQuestionThread } from "./discussionReply";
import { discussionPacing, isActualDiscussionQuestion } from "./discussionPacing";
import { matchingReceipt } from "./runtimeChoiceState";
import { getDiscussionReadiness } from "./discussionReadiness";
import { getGameSession } from "./gameService";
import { getMessageInGame, listMessages } from "./messageService";
import { getResponseDeliveries, responseKey, settleFailedDMResponse } from "./responseDelivery";
import { executeSelectedReactions } from "../orchestration/discussionOrchestrator";

export async function nextResponseRecovery(gameId: string) {
  const readiness = await getDiscussionReadiness(gameId);
  if (readiness?.pendingQuestions.length) return { ...readiness.pendingQuestions[0], deadline: undefined };
  const session = await getGameSession(gameId), pending = session.dmFlowCursor?.pendingDMQuestion;
  const definition = session.runtimeDefinitionId ? await (await import("./scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(session.runtimeDefinitionId) : null;
  const currentNode = definition?.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === session.dmFlowCursor?.nodeId);
  if (definition && session.dmFlowCursor && discussionPacing(session, definition.definition).matchingDiscussion && currentNode && !matchingReceipt(session.dmFlowCursor, currentNode)) {
    const messages = await listMessages(gameId);
    const invitation = messages.find(m => m.speaker_type === "dm" && m.metadata.act_id === session.currentActId && m.metadata.sourceNodeId === currentNode.nodeId);
    const latest = messages.filter(m => m.speaker_type === "user" && m.metadata.act_id === session.currentActId &&
      (!invitation || (m.created_at?.getTime() ?? 0) >= (invitation.created_at?.getTime() ?? 0))).at(-1);
    // Recover the newest unfinished direct question/selected failed responders,
    // not every old opinion or every participant in a group invitation.
    if (!latest || !isActualDiscussionQuestion(latest)) return null;
    const roster = publicDiscussionRoster(definition.definition.roles.map(r => ({ role_id: r.roleName, name: r.roleName })), messages);
    const base = resolveAddressing(latest.content, roster), address = explicitUserAddressing(latest, roster, base) ?? base;
    const deliveries = await getResponseDeliveries(gameId), byId = new Map(messages.map(m => [m.message_id, m]));
    const roleId = session.aiRoleIds.find(role => (address.directTargets.includes(role) || Boolean(deliveries.get(responseKey(latest.message_id, role))?.attempts)) &&
      !deliveries.get(responseKey(latest.message_id, role))?.skipped &&
      !messages.some(m => m.speaker_type === "ai_player" && m.speaker_role_id === role && responseInQuestionThread(m, latest.message_id, byId)));
    return roleId ? { messageId: latest.message_id, roleId, deadline: undefined } : null;
  }
  const publicMessages = await listMessages(gameId);
  const latestUser = publicMessages.filter(m => m.speaker_type === "user" && m.metadata.act_id === session.currentActId).at(-1);
  const interaction = latestUser && (await import("./publicDiscussionContext")).currentDMInteraction(session, publicMessages, latestUser);
  if (interaction?.kind === "player_followup") {
    const deliveries = await getResponseDeliveries(gameId);
    const roleId = interaction.target_role_ids.find(role => !deliveries.get(responseKey(latestUser!.message_id, role))?.skipped &&
      !publicMessages.some(m => m.speaker_type === "ai_player" && m.speaker_role_id === role && m.reply_to_message_id === latestUser!.message_id));
    if (roleId) return { messageId: latestUser!.message_id, roleId, deadline: undefined };
  }
  if (!pending || pending.actIndex !== Number(session.currentActId.match(/(\d+)$/)?.[1]) ||
    !["waiting", "partial_answered"].includes(pending.status) || pending.nodeId !== session.dmFlowCursor?.nodeId) return null;
  const node = definition?.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === pending.nodeId);
  const wait = node?.textExecution?.wait?.maxWaitMs ?? node?.discussionExit?.questionWaitMs;
  if (!wait || Date.now() >= Date.parse(pending.askedAt) + wait) return null;
  const messages = await listMessages(gameId);
  const roleId = pending.targetRoleNames.find(role => session.aiRoleIds.includes(role) && !pending.skippedRoleNames?.includes(role) &&
    !messages.some(m => m.speaker_type === "ai_player" && m.speaker_role_id === role && m.reply_to_message_id === pending.messageId));
  return roleId ? { messageId: pending.messageId, roleId, deadline: Date.parse(pending.askedAt) + wait } : null;
}

/** Internal scheduled delivery, initial + one retry. The old player button and
 * endpoint are removed. Call only under the existing conversation control lease. */
export async function retryDiscussionQuestion(gameId: string, messageId: string, roleId: string) {
  const readiness = await getDiscussionReadiness(gameId);
  const next = await nextResponseRecovery(gameId);
  if (!readiness?.pendingQuestions.some(q => q.messageId === messageId && q.roleId === roleId) &&
    !(next?.messageId === messageId && next.roleId === roleId)) return;
  const states = await getResponseDeliveries(gameId);
  if (states.get(responseKey(messageId, roleId))?.skipped) { await settleFailedDMResponse(gameId, messageId, roleId); return; }
  const { conversationCheckpoint, conversationStage, deferConversationSeed } = await import("./conversationService");
  const checkpoint = await conversationCheckpoint(gameId);
  if (checkpoint.changed && checkpoint.seedMessageId) { await deferConversationSeed(gameId, checkpoint.seedMessageId); return; }
  // DM tick/control routes enter in stage=dm; beginConversationTurn requires planning.
  await conversationStage("planning");
  const question = await getMessageInGame(gameId, messageId);
  await executeSelectedReactions({ gameSessionId: gameId, latestMessageId: messageId,
    responseDeadlineMs: Math.min(Date.now() + 30_000, question.speaker_type === "dm" ? next?.deadline ?? Infinity : Infinity),
    selectedReactions: [{ role_id: roleId, wants_to_speak: true, trigger_type: "direct_question_to_self",
      relevance_score: 5, urgency_score: 5, emotional_intensity_score: 2, boundary_risk: "low",
      target_role_ids: question.speaker_role_id ? [question.speaker_role_id] : [],
      speech_act: question.speaker_type === "dm" ? "answer_dm_question" : question.speaker_type === "user" ? "answer_user_question" : "answer",
      reason: "自动补齐仍未发布回应的问题，至多初次加一次恢复",
      brief_intent: "回应这条原问题。优先补充合法新细节；可以说明不知道或暂不愿透露，不能重复整段背景、编造或泄露有效秘密。回答后停止，不新增追问。" }] });
}
