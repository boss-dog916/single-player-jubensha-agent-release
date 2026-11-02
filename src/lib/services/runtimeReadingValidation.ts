import { ReadingMetadataSchema } from "./runtimeReadingSources";
import type { ScriptRuntimeDefinitionJson } from "./scriptRuntimeDefinitionService";

export function validateReadingSources(definition: ScriptRuntimeDefinitionJson): string[] {
  const errors: string[] = [], nodes = definition.dmFlow?.actFlows.flatMap(f => f.nodes) ?? [];
  for (const [kind, sources] of [["text", definition.roleBooklets], ["pdf", definition.playerDisplay]] as const) {
    const ids = new Set<string>();
    for (const s of sources) {
      const id = "sourceRoleActBookletId" in s ? s.sourceRoleActBookletId : s.sourceDocumentSectionId;
      if (ids.has(id)) errors.push(`${kind}: duplicate source ${id}`);
      ids.add(id);
      if ([s.bookKey, s.readingOrder, s.required, s.whenChoice].some(v => v !== undefined)) {
        if (!ReadingMetadataSchema.safeParse({ bookKey: s.bookKey, readingOrder: s.readingOrder,
          required: s.required, whenChoice: s.whenChoice, pdfOnly: s.pdfOnly, requiresClueId: s.requiresClueId }).success) errors.push(`${kind}: invalid reading metadata ${id}`);
      }
      if (s.whenChoice) {
        const c = s.whenChoice, choice = nodes.find(n => n.choice?.choiceId === c.choiceId);
        if (!choice?.choice || choice.choice.type === "group_matching" || !choice.actIndex || choice.actIndex >= s.actIndex ||
          !choice.choice.options.some(o => o.optionId === c.optionId) || !definition.roles.some(r => r.roleName === c.roleName) ||
          choice.choice.participants === "targets" && !choice.targetRoleNames.includes(c.roleName))
          errors.push(`${kind}: reading condition must reference an earlier legal individual choice ${id}`);
        // A human-relative participant would change the branch when selecting
        // another role; reading conditions always name the real choice actor.
        if (choice?.choice?.participants === "human") errors.push(`${kind}: conditional reading requires a named choice participant ${id}`);
      }
    }
    for (const role of definition.roles) for (const act of definition.acts) {
      const group = sources.filter(s => s.roleName === role.roleName && s.actIndex === act.actIndex);
      if (group.length > 1 && (group.some(s => !s.bookKey) || new Set(group.map(s => s.bookKey)).size !== group.length))
        errors.push(`${kind}: multiple sources require distinct explicit bookKey (${role.roleName}/${act.actIndex})`);
      for (let i = 0; i < group.length; i++) for (const other of group.slice(i + 1)) {
        const first = group[i], exclusive = first.whenChoice && other.whenChoice &&
          first.whenChoice.choiceId === other.whenChoice.choiceId && first.whenChoice.roleName === other.whenChoice.roleName &&
          first.whenChoice.optionId !== other.whenChoice.optionId;
        if (first.bookKey && first.readingOrder === other.readingOrder && !exclusive)
          errors.push(`${kind}: simultaneously readable books require distinct readingOrder (${role.roleName}/${act.actIndex})`);
      }
      if (group.length && group.every(s => s.whenChoice)) {
        const c = group[0].whenChoice!, choice = nodes.find(n => n.choice?.choiceId === c.choiceId)?.choice;
        if (!choice || group.some(s => s.whenChoice!.choiceId !== c.choiceId || s.whenChoice!.roleName !== c.roleName) ||
          choice.options.some(o => !group.some(s => s.whenChoice!.optionId === o.optionId && s.required !== false)))
          errors.push(`${kind}: incomplete reading branch coverage (${role.roleName}/${act.actIndex})`);
      }
    }
  }
  for (const b of definition.roleBooklets.filter(b => b.bookKey)) {
    const pdf = definition.playerDisplay.find(p => p.roleName === b.roleName && p.actIndex === b.actIndex && p.bookKey === b.bookKey);
    if (!pdf || pdf.readingOrder !== b.readingOrder || (pdf.required !== false) !== (b.required !== false) ||
      (["choiceId", "roleName", "optionId"] as const).some(k => pdf.whenChoice?.[k] !== b.whenChoice?.[k]))
      errors.push(`PDF/text reading metadata mismatch (${b.roleName}/${b.actIndex}/${b.bookKey})`);
  }
  for (const p of definition.playerDisplay.filter(p => p.bookKey)) {
    if (!p.pdfOnly && !definition.roleBooklets.some(b => b.roleName === p.roleName && b.actIndex === p.actIndex && b.bookKey === p.bookKey))
      errors.push(`PDF has no matching text source (${p.roleName}/${p.actIndex}/${p.bookKey})`);
  }
  for (const p of definition.playerDisplay.filter(p => p.pdfOnly || p.requiresClueId)) {
    const clue = definition.clues.find(c => c.clueId === p.requiresClueId);
    if (definition.acts.find(a => a.actIndex === p.actIndex)?.modelPolicy !== "disabled" || !p.pdfOnly || !clue?.pdf ||
      !Number.isInteger(clue.pdf.pageStart) || !Number.isInteger(clue.pdf.pageEnd) || clue.pdf.pageStart < 1 || clue.pdf.pageEnd < clue.pdf.pageStart || clue.assetId !== clue.pdf.uploadedAssetId ||
      clue.visibility !== "private" || !clue.targetRoleNames.includes(p.roleName) || clue.releaseActIndex !== p.actIndex ||
      clue.pdf.sourceDocumentSectionId !== p.sourceDocumentSectionId || clue.pdf.uploadedAssetId !== p.uploadedAssetId ||
      clue.pdf.pageStart !== p.pageStart || clue.pdf.pageEnd !== p.pageEnd) errors.push(`Invalid PDF-only grant source ${p.sourceDocumentSectionId}`);
  }
  return errors;
}
