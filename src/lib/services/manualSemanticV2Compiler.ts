import type { ManualSemanticAct } from "@/src/lib/schemas/manualSemanticSchema";
import type { SemanticItemV2, SemanticManualV2, SemanticValidation } from "@/src/lib/schemas/manualSemanticV2Schema";
import { compileManualAct, type LogicalActControl } from "./manualControlCompiler";
import { normalizeDMFlowNode } from "./dmFlowNormalization";
import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";

export type CompiledManualCandidate = {
  acts: Array<{ actIndex: number; title?: string; control?: LogicalActControl }>;
  dmFlow: { openingNodes: DMFlowNode[]; actFlows: Array<{ actIndex: number; nodes: DMFlowNode[] }>; endingNodes: DMFlowNode[] };
  needsAttention: string[]; omittedInternalItemIds: string[]; preservedBranchItemIds: string[];
};

export function compileSemanticManualV2(semantic: SemanticManualV2, validation: SemanticValidation): CompiledManualCandidate {
  const result: CompiledManualCandidate = { acts: [], dmFlow: { openingNodes: [], actFlows: [], endingNodes: [] },
    needsAttention: validation.errors.map(e => `${e.code}: ${e.message}`), omittedInternalItemIds: [], preservedBranchItemIds: [] };
  const convert = (items: SemanticItemV2[], actIndex: number): ManualSemanticAct["items"] => {
    const output: ManualSemanticAct["items"] = [];
    for (const item of items) {
      if (item.branchId || item.variantGroupId) { result.preservedBranchItemIds.push(item.id); continue; }
      if (item.kind === "internal_note") { result.omittedInternalItemIds.push(item.id); continue; }
      let kind: ManualSemanticAct["items"][number]["kind"] = "unknown";
      if (item.kind === "reading") kind = "reading";
      if (item.kind === "conversation_window") kind = item.conversation?.mode === "ordered_sharing" ? "ordered_sharing" : item.conversation?.mode === "free_discussion" ? "discussion" : "unknown";
      if (item.kind === "spoken_line" && item.channel === "spoken") kind = "spoken";
      if (item.kind === "transition") kind = "transition";
      if (["action", "performance", "clue_release"].includes(item.kind)) kind = "action";
      if (["question", "conditional_rule", "reveal", "variant_group", "unknown"].includes(item.kind)) result.needsAttention.push(`UNIMPLEMENTED_SEMANTIC_RUNTIME: ${item.kind} ${item.id}`);
      if (item.kind === "reading" && item.reading?.actIndex !== actIndex) kind = "unknown";
      if (item.channel !== "spoken" && kind === "spoken") kind = "unknown";
      output.push({ id: item.id, order: output.length, kind, instruction: item.instruction, evidence: item.evidence,
        windowId: item.conversation?.windowId, nextActIndex: item.transition?.nextActIndex,
        capability: kind === "action" ? item.kind === "clue_release" ? "clue_release" : "performance_action" : undefined });
    }
    return output;
  };
  const groups = new Map<string, typeof semantic.regions>();
  for (const region of [...semantic.regions].sort((a, b) => a.region.sourceStart - b.region.sourceStart)) {
    if (region.region.semanticSectionType === "act" && region.region.logicalActId && region.region.actIndex) {
      const key = `${region.region.logicalActId}:${region.region.actIndex}`;
      groups.set(key, [...(groups.get(key) ?? []), region]);
    } else {
      for (const item of region.items) {
        if (item.branchId || item.variantGroupId) { result.preservedBranchItemIds.push(item.id); continue; }
        if (item.kind === "internal_note") { result.omittedInternalItemIds.push(item.id); continue; }
        const spoken = item.kind === "spoken_line" && item.channel === "spoken";
        const action = ["action", "performance", "clue_release"].includes(item.kind) && item.channel === "action";
        const type = spoken ? "fixed_line" : action ? item.kind === "clue_release" ? "clue_release" : "performance_instruction" : "unknown";
        if (type === "unknown") result.needsAttention.push(`UNIMPLEMENTED_SEMANTIC_RUNTIME: ${item.kind} ${item.id}`);
        const node = { ...normalizeDMFlowNode({ nodeId: item.id, type, text: spoken ? item.instruction : null, fixedLine: spoken ? item.instruction : null,
          sourceQuote: item.evidence.sourceQuote, confidence: item.confidence }, 0), sourceEvidence: item.evidence, semanticItemId: item.id };
        if (region.region.semanticSectionType === "opening") result.dmFlow.openingNodes.push(node);
        else if (region.region.semanticSectionType === "ending") result.dmFlow.endingNodes.push(node);
        else result.needsAttention.push(`UNRESOLVED_REGION: ${region.region.regionId}`);
      }
    }
  }
  for (const regions of groups.values()) {
    const actIndex = regions[0].region.actIndex!;
    const policies = regions.flatMap(r => !r.region.branchId && r.conversationPolicy ? [r.conversationPolicy] : []);
    const valid = policies.length && new Set(policies.map(p => p.mode)).size === 1 && policies.every(p => p.mode === "ordered_share_then_discuss" || p.mode === "free_discussion_after_reading");
    const allItems = regions.flatMap(r => r.items);
    if (!valid) {
      result.needsAttention.push(`CONVERSATION_POLICY_UNRESOLVED: act ${actIndex}`);
      result.acts.push({ actIndex });
      // No fake default policy: retain a blocked placeholder, not a runnable fallback flow.
      result.dmFlow.actFlows.push({ actIndex, nodes: [normalizeDMFlowNode({ nodeId: `${semantic.manualId}:blocked:${actIndex}`, type: "unknown", text: null }, 0)] });
      result.preservedBranchItemIds.push(...allItems.filter(i => i.branchId).map(i => i.id));
      continue;
    }
    const adapted: ManualSemanticAct = { contractVersion: 1, actIndex, logicalActId: regions[0].region.logicalActId!, fragment: "complete",
      conversationPolicy: { mode: policies[0].mode as ManualSemanticAct["conversationPolicy"]["mode"], source: "manual", evidence: policies.flatMap(p => p.evidence) },
      items: convert(allItems, actIndex) };
    const compiled = compileManualAct(adapted);
    for (const variant of semantic.variants.filter(v => v.logicalActId === adapted.logicalActId)) compiled.control.needsAttention.push(`UNRESOLVED_VARIANT: ${variant.variantGroupId}`);
    compiled.control.needsAttention.push(...result.needsAttention);
    // Keep full v2 payload on nodes for auditing; unsupported action execution is still blocked.
    compiled.nodes = compiled.nodes.map(n => {
      const item = allItems.find(i => i.id === n.semanticItemId);
      if (!item) return n;
      const enriched = normalizeDMFlowNode({ ...n, clueRefs: item.clue?.clues.map(title => ({ title, rawText: item.instruction, targetRoleNames: item.resolvedTargetRoles })),
        performance: item.action ? { kind: "other", instruction: item.instruction, rawText: JSON.stringify(item.action) } : null,
        targetRoleNames: item.resolvedTargetRoles }, 0);
      return { ...enriched, sourceEvidence: item.evidence, semanticItemId: item.id };
    });
    result.acts.push({ actIndex, control: compiled.control });
    result.dmFlow.actFlows.push({ actIndex, nodes: compiled.nodes });
  }
  return result;
}
