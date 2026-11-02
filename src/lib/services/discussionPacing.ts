import type { GameSession, Message } from "../types/game";
import type { ScriptRuntimeDefinitionJson } from "./scriptRuntimeDefinitionService";

/** Phase policy, derived from the existing Cursor. No new persisted state. */
export function discussionPacing(session: Pick<GameSession, "currentActId" | "currentPhase" | "dmFlowCursor" | "aiRoleIds">,
  definition?: ScriptRuntimeDefinitionJson | null) {
  const node = definition?.dmFlow?.actFlows.find(f => `runtime_act_${f.actIndex}` === session.currentActId)
    ?.nodes.find(n => n.nodeId === session.dmFlowCursor?.nodeId);
  // Matching is an explicitly authored discussion/choice window, even when
  // the FSM still calls its phase dm_question. Do not suppress team opinions.
  const matching = node?.choice?.type === "group_matching" && !session.dmFlowCursor?.completedNodeIds.includes(node.nodeId);
  const awaitingStart = session.dmFlowCursor?.textPresentation?.kind === "start" && !session.dmFlowCursor.textPresentation.confirmed;
  return { mode: session.currentPhase === "dm_question" && !matching && !awaitingStart ? "dm_performance" as const : "discussion" as const,
    nodeId: session.dmFlowCursor?.nodeId ?? null, matchingDiscussion: Boolean(matching) };
}

export function isActualDiscussionQuestion(message: Pick<Message, "speech_act" | "content" | "metadata">) {
  return message.speech_act === "question" || message.metadata.questions_raised.length > 0 || /[?？]|[吗呢][。！!\s]*$/.test(message.content);
}

export function performanceResponders(session: Pick<GameSession, "dmFlowCursor" | "aiRoleIds"> & { runtimeDefinitionId?: string | null }, message: Message, textTargets: string[] = []) {
  const pending = session.dmFlowCursor?.pendingDMQuestion;
  if (message.speaker_type !== "dm") return [];
  const isCurrentQuestion = pending?.messageId === message.message_id && pending.nodeId === session.dmFlowCursor?.nodeId;
  const isAuthoredQuestion = message.metadata.textInteraction === true && message.metadata.sourceNodeId === session.dmFlowCursor?.nodeId;
  if (!isCurrentQuestion && !isAuthoredQuestion && !(!session.runtimeDefinitionId && isActualDiscussionQuestion(message))) return [];
  const targets = isCurrentQuestion ? pending.targetRoleNames : message.target_role_ids?.length ? message.target_role_ids : textTargets;
  return targets.length ? session.aiRoleIds.filter(id => targets.includes(id)) : session.aiRoleIds;
}
