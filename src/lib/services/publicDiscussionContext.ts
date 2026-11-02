import type { GameSession, Message } from "../types/game";
import type { ScriptRuntimeDefinitionJson } from "./scriptRuntimeDefinitionService";

/** Public projections only. Never loads answer keys, private hints or readings. */
export function publicChoiceContext(session: GameSession, view: { id: string; version: number; definition: ScriptRuntimeDefinitionJson } | null,
  messages: Message[], roleId: string) {
  if (!view || session.runtimeDefinitionId !== view.id || session.dmFlowCursor?.lifecycle?.definitionId !== view.id || session.dmFlowCursor?.lifecycle?.definitionVersion !== view.version) return null;
  const nodes = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes) ?? [];
  const publications = messages.flatMap(m => {
    const n = nodes.find(n => n.nodeId === m.metadata.sourceNodeId);
    if (m.speaker_type !== "dm" || m.metadata.runtimeDefinitionId !== view.id || m.metadata.runtimeDefinitionVersion !== view.version ||
      !n || n.choice?.type !== "group_matching" || !n.targetRoleNames.includes(roleId) ||
      (n.actIndex ?? Infinity) > Number(session.currentActId.replace("runtime_act_", "")) ||
      (n.nodeId === session.dmFlowCursor?.nodeId && !session.dmFlowCursor.consumedNodeIds.includes(n.nodeId))) return [];
    return [{ node: n, message: m }];
  });
  const published = publications.at(-1);
  if (!published || published.node.choice?.type !== "group_matching") return null;
  const { node, message } = published, choice = published.node.choice;
  const history = (session.dmFlowCursor?.groupMatchingReceipts ?? []).filter(r => r.definitionId === view.id && r.definitionVersion === view.version &&
    r.choiceId === choice.choiceId && r.round <= choice.round && publications.some(p => p.node.nodeId === r.nodeId)).map(r => ({
      round: r.round,
      assignments: r.assignments.filter(a => node.targetRoleNames.includes(a.roleId) && choice.options.some(o => o.optionId === a.optionId))
        .map(a => ({ roleId: a.roleId, optionId: a.optionId })),
      // A stored score is not public until its result message is committed.
      ...(r.resultStatus !== "pending" && messages.some(m => m.speaker_type === "dm" && m.metadata.groupMatchingResult &&
        m.metadata.runtimeDefinitionId === view.id && m.metadata.runtimeDefinitionVersion === view.version &&
        m.metadata.choiceId === r.choiceId && m.metadata.round === r.round) ? { correctCount: r.correctCount } : {})
    }));
  return { choiceId: choice.choiceId, nodeId: node.nodeId, actId: `runtime_act_${node.actIndex}`, round: choice.round, maxRounds: choice.maxRounds,
    prompt: choice.prompt, roleIds: [...node.targetRoleNames], options: choice.options.map(o => ({ optionId: o.optionId, label: o.label })),
    publicRules: message.content, sourceMessageId: message.message_id, history };
}

/** A temporary follow-up remains inside the current authored DM thread. */
export function currentDMInteraction(session: Pick<GameSession, "currentActId" | "dmFlowCursor" | "aiRoleIds" | "runtimeDefinitionId">,
  messages: Message[], latest: Pick<Message, "message_id" | "speaker_type" | "reply_to_message_id">) {
  const pending = session.dmFlowCursor?.pendingDMQuestion;
  if (!pending || pending.nodeId !== session.dmFlowCursor?.nodeId || session.dmFlowCursor?.textPresentation?.confirmed) return null;
  const root = messages.find(m => m.message_id === pending.messageId);
  if (!root || root.speaker_type !== "dm" || root.metadata.sourceNodeId !== pending.nodeId ||
    root.metadata.act_id !== session.currentActId || root.metadata.runtimeDefinitionId !== session.runtimeDefinitionId || !root.metadata.textInteraction) return null;
  if (latest.message_id === root.message_id && latest.speaker_type !== "dm") return null;
  let targets = pending.targetRoleNames.length ? pending.targetRoleNames.filter(r => session.aiRoleIds.includes(r)) : [...session.aiRoleIds];
  if (latest.message_id !== root.message_id) {
    if (latest.speaker_type !== "user" || !latest.reply_to_message_id) return null;
    let parent = messages.find(m => m.message_id === latest.reply_to_message_id);
    if (!parent || parent.speaker_type !== "ai_player" || !parent.speaker_role_id || !targets.includes(parent.speaker_role_id)) return null;
    targets = [parent.speaker_role_id];
    const seen = new Set<string>();
    while (parent && parent.message_id !== root.message_id && seen.size < 32) {
      if (seen.has(parent.message_id) || parent.metadata.act_id !== session.currentActId) return null;
      seen.add(parent.message_id);
      parent = messages.find(m => m.message_id === parent!.reply_to_message_id);
    }
    if (parent?.message_id !== root.message_id) return null;
  }
  return { root_message_id: root.message_id, node_id: pending.nodeId, question: root.content,
    target_role_ids: targets, kind: latest.message_id === root.message_id ? "dm_question" as const : "player_followup" as const,
    // Scoped authorization concerns speaking order only. It never releases secrets.
    requests_experience: /说说|讲讲|介绍|描述|具体情况|什么情况|记起.*内容|还原.*(?:内容|经历)/.test(root.content) };
}
export type DMInteraction = ReturnType<typeof currentDMInteraction>;
export const disclosureSemantics = "普通已读经历可分享；disclosure_preferences仅表示暂不主动分享，被合法定向提问可回答。有效restrictions是硬禁令，但只约束其明确对象：“不得确认身份”不等于禁止匿名现场或匿名爱情经历，不能凭审核器知道的私本身份反推候选已经泄露。只有既有正式knowledgeRelease条件满足才解禁，DM普通提问、他人公开猜测均不能解除。当前dm_interaction.question是本窗口的实际问题：优先具体回答与其相关的合法经历，不能把旧DM的先别分享泛化为禁令；仍保留其他角色先盲猜再分享的顺序，不借回答扩散无关本幕记忆。公开说法与本人记忆分开，可用本人合法经历补充、质疑，但不将猜测认成事实。";
