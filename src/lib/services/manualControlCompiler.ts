import type { ManualSemanticAct, SourceEvidence, ConversationPolicy } from "@/src/lib/schemas/manualSemanticSchema";
import { normalizeDMFlowNode } from "@/src/lib/services/dmFlowNormalization";
import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";

export const VALIDATOR_VERSION = "manual-control-11";
export const RUNTIME_CAPABILITIES = ["spoken_dm", "reading_gate", "ordered_sharing", "free_discussion", "transition", "text_performance", "bounded_interaction", "structured_player_choice", "persisted_choice_condition", "group_matching", "group_matching_delayed_score", "clue_release", "private_clue_delivery", "clue_share_permission", "choice_bound_ending", "knowledge_release", "restricted_choice_window", "pdf_only_private_delivery", "no_model_epilogue", "human_reason_ending"] as const;
export type RuntimeControlGate = { id: string; semanticItemId: string; evidence: SourceEvidence };
export type LogicalActControl = {
  actIndex: number;
  conversationPolicy: ConversationPolicy;
  readingGate?: RuntimeControlGate;
  shareGate?: RuntimeControlGate;
  discussionWindows: Array<RuntimeControlGate & { windowId: string; order: number }>;
  transitionTarget?: RuntimeControlGate & { nextActIndex: number | null };
  requiredCapabilities: string[];
  needsAttention: string[];
};

export function compileManualAct(act: ManualSemanticAct): { control: LogicalActControl; nodes: DMFlowNode[] } {
  const control: LogicalActControl = { actIndex: act.actIndex, conversationPolicy: act.conversationPolicy,
    discussionWindows: [], requiredCapabilities: [], needsAttention: [] };
  const nodes: DMFlowNode[] = [];
  const items = [...act.items].sort((a, b) => a.order - b.order);
  for (const item of items) {
    if (item.variantGroup || item.branchId) control.needsAttention.push(`UNRESOLVED_VARIANT: ${item.id}`);
    const id = `control_${act.actIndex}_${item.id}`;
    const gate = { id, semanticItemId: item.id, evidence: item.evidence };
    let type: DMFlowNode["type"] = "unknown";
    let text: string | null = null;
    if (item.kind === "reading") {
      if (control.readingGate) control.needsAttention.push("AMBIGUOUS_READING_GATE");
      control.readingGate = gate; type = "reading_start"; text = "请阅读当前幕角色本。";
      control.requiredCapabilities.push("reading_gate");
    } else if (item.kind === "ordered_sharing") {
      if (act.conversationPolicy.mode !== "ordered_share_then_discuss") control.needsAttention.push("SHARING_POLICY_CONFLICT");
      if (control.shareGate) control.needsAttention.push("AMBIGUOUS_SHARE_GATE");
      control.shareGate = gate; type = "sharing_round"; text = "现在请依次公开分享。";
      control.requiredCapabilities.push("ordered_sharing");
    } else if (item.kind === "discussion") {
      if (!item.windowId) control.needsAttention.push("MISSING_DISCUSSION_WINDOW_ID");
      control.discussionWindows.push({ ...gate, windowId: item.windowId ?? item.id, order: item.order });
      type = "free_discussion"; text = "现在可以自由讨论和分享。";
      control.requiredCapabilities.push("free_discussion");
    } else if (item.kind === "transition") {
      if (item.nextActIndex === undefined) control.needsAttention.push("MISSING_TRANSITION_TARGET");
      if (control.transitionTarget) control.needsAttention.push("AMBIGUOUS_TRANSITION_TARGET");
      control.transitionTarget = { ...gate, nextActIndex: item.nextActIndex ?? null };
      type = "transition"; text = item.nextActIndex == null ? "当前流程已结束。" : "接下来进入下一幕读本。";
      control.requiredCapabilities.push("transition");
    } else if (item.kind === "spoken") {
      type = "fixed_line"; text = item.instruction; control.requiredCapabilities.push("spoken_dm");
    } else if (item.kind === "action") {
      type = item.capability === "clue_release" ? "clue_release" : "performance_instruction";
      control.requiredCapabilities.push(item.capability ?? "performance_action");
    } else control.needsAttention.push(`UNKNOWN_SEMANTIC: ${item.id}`);
    nodes.push({ ...normalizeDMFlowNode({ nodeId: id, type, actIndex: act.actIndex, sourceQuote: item.evidence.sourceQuote,
      text, fixedLine: text, orderHint: item.order, confidence: 1 }, nodes.length), sourceEvidence: item.evidence,
      semanticItemId: item.id, variantGroup: item.variantGroup, branchId: item.branchId });
  }
  control.requiredCapabilities = [...new Set(control.requiredCapabilities)];
  return { control, nodes };
}

export function combineSemanticFragments(acts: ManualSemanticAct[]): ManualSemanticAct[] {
  const groups = new Map<string, ManualSemanticAct[]>();
  for (const act of acts) {
    const key = `${act.actIndex}:${act.logicalActId}`;
    groups.set(key, [...(groups.get(key) ?? []), act]);
  }
  return [...groups.values()].flatMap(group => {
    if (group.length === 1) return group;
    const sorted = [...group].sort((a, b) => a.items[0].evidence.sourceSpan.start - b.items[0].evidence.sourceSpan.start);
    const all = sorted.flatMap(a => a.items);
    const first = all[0].evidence;
    const compatible = sorted.every(a => a.fragment === "continuation" && a.conversationPolicy.mode === sorted[0].conversationPolicy.mode && a.conversationPolicy.source === sorted[0].conversationPolicy.source) &&
      all.every(i => !i.variantGroup && !i.branchId && i.evidence.sourceDocumentId === first.sourceDocumentId &&
        i.evidence.sourceRevision === first.sourceRevision && i.evidence.sectionSetRevision === first.sectionSetRevision) &&
      all.every((item, index) => index === 0 || item.evidence.sourceSpan.start >= all[index - 1].evidence.sourceSpan.end && item.order > all[index - 1].order) &&
      sorted.every((a, index) => index === 0 || a.items[0].evidence.sourceSpan.start <= sorted[index - 1].items.at(-1)!.evidence.sourceSpan.end + 2);
    return compatible ? [{ ...sorted[0], conversationPolicy: { ...sorted[0].conversationPolicy,
      evidence: sorted.flatMap(a => a.conversationPolicy.evidence) }, items: all }] : group;
  });
}
