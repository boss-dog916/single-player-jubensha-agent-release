import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import { RuntimeClueActionSchema } from "@/src/lib/schemas/runtimeClueSchema";
import { SourceEvidenceSchema } from "@/src/lib/schemas/manualSemanticSchema";
import type { ScriptRuntimeDefinitionJson } from "./scriptRuntimeDefinitionService";

export function clueNodeErrors(definition: ScriptRuntimeDefinitionJson, nodes: DMFlowNode[], node: DMFlowNode, roleNames?: string[]) {
  if (node.type !== "clue_release" && !node.clueAction) return [];
  const parsed = RuntimeClueActionSchema.safeParse(node.clueAction);
  if (!parsed.success) return ["clue_release必须显式绑定稳定clueId与grant/allow_share动作；旧解析结果不能直接执行。"];
  const errors: string[] = [];
  if (!["clue_release", "reading_start"].includes(node.type) || node.type === "reading_start" && (parsed.data.action !== "grant" || definition.acts.find(a => a.actIndex === node.actIndex)?.modelPolicy !== "disabled") || !node.actIndex || !SourceEvidenceSchema.safeParse(node.sourceEvidence).success || node.choice || node.choiceRecap || node.whenChoice || node.textExecution || node.discussionExit ||
    new Set(parsed.data.clueIds).size !== parsed.data.clueIds.length) errors.push("线索动作的节点类型、来源或配置冲突。");
  for (const clueId of parsed.data.clueIds) {
    const matches = definition.clues.filter(c => c.clueId === clueId), clue = matches[0];
    if (matches.length !== 1 || !(clue?.rawText?.trim() || clue?.pdf && clue.visibility === "private" && definition.acts.find(a => a.actIndex === node.actIndex)?.modelPolicy === "disabled" && definition.playerDisplay.some(p => p.pdfOnly && p.requiresClueId === clueId && p.sourceDocumentSectionId === clue.pdf!.sourceDocumentSectionId)) || clue.releaseMode !== "fixed_at_node" || !["public", "private"].includes(clue.visibility)) {
      errors.push(`${clueId}: 缺少唯一、完整、可执行的线索定义。`); continue;
    }
    if (clue.visibility === "public" ? clue.targetRoleNames.length > 0 : !clue.targetRoleNames.length || new Set(clue.targetRoleNames).size !== clue.targetRoleNames.length ||
      clue.targetRoleNames.some(r => !definition.roles.some(x => x.roleName === r) || roleNames && !roleNames.includes(r))) errors.push(`${clueId}: 受众不合法或不在运行范围。`);
    if (clue.pdf && (parsed.data.action !== "grant" || clue.assetId !== clue.pdf.uploadedAssetId || !Number.isInteger(clue.pdf.pageStart) || !Number.isInteger(clue.pdf.pageEnd) ||
      clue.pdf.pageStart < 1 || clue.pdf.pageEnd < clue.pdf.pageStart || !definition.playerDisplay.some(p => p.requiresClueId === clueId && p.uploadedAssetId === clue.assetId &&
        p.pageStart === clue.pdf!.pageStart && p.pageEnd === clue.pdf!.pageEnd))) errors.push(`${clueId}: PDF发放必须绑定合法原始页面，不能作为文字公开。`);
    const earlier = nodes.slice(0, nodes.indexOf(node)).filter(n => n.clueAction?.action === "grant" && n.clueAction.clueIds.includes(clueId));
    if (parsed.data.action === "grant") {
      if (clue.releaseActIndex !== node.actIndex || earlier.length) errors.push(`${clueId}: 发放幕或重复发放定义不合法。`);
    } else if (clue.visibility !== "private" || earlier.length !== 1) errors.push(`${clueId}: 公开授权必须引用范围内先前的私密发放节点。`);
  }
  return errors;
}
