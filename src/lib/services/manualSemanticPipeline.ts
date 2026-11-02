import { createHash } from "node:crypto";
import type { ExtractedDocumentBlock } from "@/src/lib/ingestion/documentTextExtractor";
import { MANUAL_V2_VERSIONS as V, type Citation, type EvidenceV2, type ManualPlan, type PlanRegion, type SemanticItemV2, type SemanticManualV2, type SemanticRegionV2, type SemanticValidation, type SemanticIssue, type SemanticItemOutput } from "@/src/lib/schemas/manualSemanticV2Schema";
import { ManualPlanOutputSchema, SemanticChunkOutputSchema } from "@/src/lib/schemas/manualSemanticV2Schema";
import type { ManualRoleIdentity } from "./manualRoleIdentity";

export type ManualSource = {
  documentId: string; documentRevision: number; sectionSetRevision: number; title: string; text: string;
  blocks: ExtractedDocumentBlock[]; knownRoles: Array<{ name: string; aliases: string[] }>;
  roleIdentity?: ManualRoleIdentity;
  sections: Array<{ id: string; start: number; end: number }>;
};
export type ManualParagraph = { index: number; originalIndex: number | null; text: string; start: number; end: number; style: string | null; headingLevel: number | null; headingCandidate: boolean };
export type ManualContext = { source: ManualSource; manualId: string; paragraphs: ManualParagraph[]; limitations: string[] };
export type SemanticChunk = { id: string; region: PlanRegion; index: number; count: number; start: number; end: number; paragraphStart: number; paragraphEnd: number; text: string; nextBoundaryHint: string };
export type ChunkRecord = { chunk: SemanticChunk; output: unknown; rawText?: string; model?: string; latencyMs?: number; messages?: unknown; error?: string;
  requestConfig?: import("@/src/lib/llm/llmTypes").TaskModelProfile; finishReason?: string | null; reasoningChars?: number;
  usage?: unknown; retryCount?: number; startedAt?: string; completedAt?: string; trace?: import("@/src/lib/llm/llmTypes").LlmTraceEvent[] };

export function buildManualContext(source: ManualSource): ManualContext {
  let cursor = 0;
  const paragraphs: ManualParagraph[] = [];
  const blocks: ExtractedDocumentBlock[] = source.blocks.length ? source.blocks : source.text.split("\n").map((text, orderIndex) => ({ type: "paragraph" as const, text, orderIndex }));
  for (const block of blocks) {
    if (!block.text.trim()) continue;
    const start = source.text.indexOf(block.text, cursor);
    if (start < 0) throw new Error(`Paragraph ${block.orderIndex} cannot be mapped to source text`);
    const end = start + block.text.length;
    // Heading candidates are generic layout hints, not script-specific act classification.
    paragraphs.push({ index: paragraphs.length, originalIndex: block.sourceParagraphIndex ?? null, text: block.text, start, end,
      style: block.style ?? null, headingLevel: block.headingLevel ?? null,
      headingCandidate: block.headingLevel != null || /heading|标题/i.test(block.style ?? "") || block.text.length <= 90 && /^(?:【[^】]+】|第.{1,8}[幕章节]|[A-Z\d]+[.、])/i.test(block.text) });
    cursor = end;
  }
  if (!paragraphs.length) throw new Error("Manual source is empty");
  const limitations = ["Table cell hierarchy, images, embedded audio and inherited OOXML style levels are not available; no page numbers are inferred."];
  if (paragraphs.some(p => p.originalIndex === null)) limitations.push("Paragraph indices refer to stored nonempty blocks, not original OOXML paragraph ordinals.");
  return { source, paragraphs, limitations, manualId: `manual_${createHash("sha256").update(`${source.documentId}:${source.documentRevision}:${source.sectionSetRevision}:${source.text}`).digest("hex").slice(0, 20)}` };
}

export function resolveCitation(context: ManualContext, citation: Citation, bounds?: { start: number; end: number }): EvidenceV2 {
  const first = context.paragraphs[citation.paragraphStart], last = context.paragraphs[citation.paragraphEnd];
  if (!first || !last || citation.paragraphEnd < citation.paragraphStart) throw new Error("Invalid paragraph evidence range");
  const low = Math.max(first.start, bounds?.start ?? first.start), high = Math.min(last.end, bounds?.end ?? last.end);
  const quote = citation.sourceQuote;
  let start: number;
  if (citation.sourceStart !== null || citation.sourceEnd !== null) {
    if (citation.sourceStart === null || citation.sourceEnd === null || citation.sourceEnd !== citation.sourceStart + quote.length) throw new Error("Invalid explicit UTF-16 evidence span");
    start = citation.sourceStart;
  } else {
    const slice = context.source.text.slice(low, high), offset = slice.indexOf(quote);
    if (offset < 0 || slice.indexOf(quote, offset + 1) >= 0) throw new Error("Quote missing or non-unique in cited paragraphs");
    start = low + offset;
  }
  const end = start + quote.length;
  if (start < low || end > high || context.source.text.slice(start, end) !== quote) throw new Error("Evidence quote does not exactly match original source");
  const section = context.source.sections.find(s => start >= s.start && end <= s.end);
  return { sourceDocumentId: context.source.documentId, sourceRevision: context.source.documentRevision,
    sectionSetRevision: context.source.sectionSetRevision, sourceSectionId: section?.id ?? `whole_manual:${context.manualId}`,
    sourceSpan: { start, end }, sourceQuote: quote, parserVersion: V.parser, promptVersion: V.prompt, schemaVersion: V.schema,
    paragraphStart: citation.paragraphStart, paragraphEnd: citation.paragraphEnd,
    ooxmlParagraphStart: first.originalIndex, ooxmlParagraphEnd: last.originalIndex,
    paragraphIndexBasis: first.originalIndex === null ? "stored_block_index" : "mapped_block_index; original OOXML index recorded in manifest" };
}

export function hydrateManualPlan(context: ManualContext, output: unknown, plannedParagraphEnd = context.paragraphs.length - 1): ManualPlan {
  const parsed = ManualPlanOutputSchema.parse(output);
  return { ...parsed, manualId: context.manualId, format: "semantic_v2", plannedParagraphEnd, regions: parsed.regions.map(region => {
    const first = context.paragraphs[region.paragraphStart], last = context.paragraphs[region.paragraphEnd];
    if (!first || !last || region.paragraphStart > region.paragraphEnd || region.paragraphEnd > plannedParagraphEnd) throw new Error(`Invalid region bounds: ${region.regionId}`);
    return { ...region, sourceStart: first.start, sourceEnd: last.end };
  }) };
}

export function makeValidation(issues: SemanticIssue[]): SemanticValidation {
  return { validatorVersion: V.validator, validatedAt: new Date().toISOString(), status: issues.some(i => i.severity === "error") ? "needs_attention" : "valid",
    errors: issues.filter(i => i.severity === "error"), warnings: issues.filter(i => i.severity === "warning"), repairCandidates: issues.filter(i => i.repairCandidate) };
}
export function validateManualPlan(context: ManualContext, plan: ManualPlan): SemanticValidation {
  const issues: SemanticIssue[] = [];
  const add = (code: string, message: string, regionId?: string) => issues.push({ code, message, regionId, severity: "error", repairCandidate: true });
  const ids = new Set<string>();
  const ordered = [...plan.regions].sort((a, b) => a.sourceStart - b.sourceStart);
  for (const region of ordered) {
    if (ids.has(region.regionId)) add("DUPLICATE_REGION", region.regionId, region.regionId);
    ids.add(region.regionId);
    try { resolveCitation(context, region.evidence, { start: region.sourceStart, end: region.sourceEnd }); } catch (e) { add("PLAN_EVIDENCE", String(e), region.regionId); }
    if (region.semanticSectionType === "act" && (!region.logicalActId || !region.actIndex)) add("AMBIGUOUS_ACT_BOUNDARY", "Act identity is unresolved", region.regionId);
    if (region.semanticSectionType === "unknown" || region.confidence < .6) add("UNCERTAIN_BOUNDARY", region.interpretation, region.regionId);
    if ((region.variantGroupId === null) !== (region.branchId === null)) add("BRANCH_IDENTITY", "Branch and variant group must be paired", region.regionId);
    if (region.branchId && !plan.variants.some(v => v.variantGroupId === region.variantGroupId && v.logicalActId === region.logicalActId && v.branches.some(b => b.branchId === region.branchId && b.regionIds.includes(region.regionId)))) add("BRANCH_IDENTITY", "Region branch is absent from variant plan or belongs to another logical act", region.regionId);
  }
  for (let p = 0; p <= plan.plannedParagraphEnd; p++) {
    const count = ordered.filter(r => p >= r.paragraphStart && p <= r.paragraphEnd).length;
    if (count !== 1) add(count ? "OVERLAPPING_PLAN_REGIONS" : "PLAN_COVERAGE_GAP", `Paragraph ${p}: ${count} regions`);
  }
  if (plan.plannedParagraphEnd !== context.paragraphs.length - 1) add("PARTIAL_PLANNING", `Only paragraphs 0..${plan.plannedParagraphEnd} of ${context.paragraphs.length} were planned; never a full playable definition`);
  for (const variant of plan.variants) {
    add("UNRESOLVED_VARIANT", `${variant.variantGroupId}: preserve mutually exclusive branches; no automatic selection`);
    if (new Set(variant.branches.map(b => b.branchId)).size !== variant.branches.length) add("BRANCH_IDENTITY", variant.variantGroupId);
    const members = variant.branches.flatMap(b => b.regionIds);
    if (new Set(members).size !== members.length || variant.commonContinuationRegionIds.some(id => members.includes(id))) add("BRANCH_OVERLAP", variant.variantGroupId);
    for (const branch of variant.branches) {
      try { resolveCitation(context, branch.evidence); } catch (e) { add("VARIANT_EVIDENCE", String(e)); }
      for (const id of branch.regionIds) if (!ids.has(id)) add("UNKNOWN_BRANCH_REGION", id);
    }
    for (const id of variant.commonContinuationRegionIds) if (!ids.has(id) || ordered.find(r => r.regionId === id)?.branchId) add("INVALID_COMMON_CONTINUATION", id);
  }
  for (const role of plan.roster) {
    if (role.evidence) try { resolveCitation(context, role.evidence); } catch (e) { add("ROSTER_EVIDENCE", String(e)); }
    if (role.kind === "player" && !context.source.knownRoles.some(r => r.name === role.canonicalRole || r.name === role.manifestRole)) issues.push({ code: "ROSTER_NOT_IN_MANIFEST", severity: "warning", message: role.canonicalRole, repairCandidate: true });
    if (role.manifestRole && !context.source.knownRoles.some(r => r.name === role.manifestRole)) add("ROSTER_MANIFEST_REFERENCE", `Unknown manifest role: ${role.manifestRole}`);
    if (!role.evidence && !context.source.knownRoles.some(r => r.name === role.canonicalRole)) add("ROSTER_EVIDENCE_MISSING", role.canonicalRole);
    for (const alias of [role.canonicalRole, ...role.aliases]) if (new Set(plan.roster.filter(r => r.canonicalRole === alias || r.aliases.includes(alias)).map(r => r.canonicalRole)).size > 1) issues.push({ code: "ROSTER_ALIAS_AMBIGUITY", severity: "warning", message: alias, repairCandidate: true });
  }
  for (const message of [...context.limitations, ...plan.warnings]) issues.push({ code: "PLAN_WARNING", severity: "warning", message, repairCandidate: false });
  return makeValidation(issues);
}

export function chunkManualPlan(context: ManualContext, plan: ManualPlan, limit = 4000): SemanticChunk[] {
  if (limit < 128) throw new Error("Chunk limit is too small");
  const all: SemanticChunk[] = [];
  for (const region of [...plan.regions].sort((a, b) => a.sourceStart - b.sourceStart)) {
    const parts: Array<{ start: number; end: number }> = [];
    let start = region.sourceStart;
    while (start < region.sourceEnd) {
      let end = Math.min(start + limit, region.sourceEnd);
      if (end < region.sourceEnd) {
        const boundary = context.paragraphs.filter(p => p.end > start && p.end <= end).at(-1)?.end;
        if (boundary) end = boundary;
      }
      parts.push({ start, end }); start = end;
    }
    // Rebalance a small tail within its own region; never borrow from the next act/branch.
    if (parts.length > 1 && parts.at(-1)!.end - parts.at(-1)!.start < limit / 5) {
      const previous = parts.at(-2)!, tail = parts.at(-1)!;
      const middle = Math.floor((previous.start + tail.end) / 2);
      previous.end = middle; tail.start = middle;
    }
    const next = plan.regions.find(r => r.sourceStart > region.sourceEnd);
    parts.forEach((part, index) => all.push({ id: `${context.manualId}:${region.regionId}:chunk:${index}`, region,
      index, count: parts.length, ...part, paragraphStart: context.paragraphs.find(p => p.end > part.start)!.index,
      paragraphEnd: context.paragraphs.findLast(p => p.start < part.end)!.index, text: context.source.text.slice(part.start, part.end),
      nextBoundaryHint: next ? `${next.regionId}: ${next.sourceHeading ?? ""} / ${next.semanticSectionType}` : "end of manual" }));
  }
  return all;
}

function resolveTargets(context: ManualContext, plan: ManualPlan, references: string[]) {
  const resolved: string[] = [], unresolved: string[] = [];
  for (const ref of references) {
    const matches = new Set(context.source.knownRoles.filter(r => r.name === ref || r.aliases.includes(ref)).map(r => r.name));
    for (const role of plan.roster.filter(r => r.canonicalRole === ref || r.aliases.includes(ref))) if (role.kind === "player") matches.add(role.manifestRole ?? role.canonicalRole);
    if (matches.size === 1) resolved.push([...matches][0]); else unresolved.push(ref);
  }
  return { resolved, unresolved };
}

export function combineSemanticChunks(context: ManualContext, plan: ManualPlan, records: ChunkRecord[]): { semantic: SemanticManualV2; validation: SemanticValidation } {
  const planValidation = validateManualPlan(context, plan);
  const issues = [...planValidation.errors, ...planValidation.warnings];
  const regions: SemanticRegionV2[] = [];
  const add = (code: string, message: string, regionId?: string, itemId?: string) => issues.push({ code, severity: "error", message, regionId, itemId, repairCandidate: true });
  for (const region of plan.regions) {
    const chunks = records.filter(r => r.chunk.region.regionId === region.regionId).sort((a, b) => a.chunk.start - b.chunk.start);
    if (!chunks.length) { add("REGION_NOT_EXTRACTED", "Planned source region was not extracted", region.regionId); continue; }
    if (chunks[0].chunk.start !== region.sourceStart || chunks.at(-1)!.chunk.end !== region.sourceEnd) add("INCOMPLETE_REGION_EXTRACTION", "Only part of the planned source region was extracted", region.regionId);
    const output: SemanticRegionV2 = { region, items: [], conversationPolicy: null };
    const dedup = new Set<string>();
    for (let c = 0; c < chunks.length; c++) {
      const record = chunks[c], chunk = record.chunk;
      if (chunk.start < region.sourceStart || chunk.end > region.sourceEnd || c > 0 && chunk.start !== chunks[c - 1].chunk.end) add("CHUNK_SOURCE_ORDER", "Chunks overlap or leave a gap", region.regionId);
      const parsed = SemanticChunkOutputSchema.safeParse(record.output);
      if (!parsed.success) { add("EXTRACTION_SCHEMA", record.error ?? parsed.error.message, region.regionId); continue; }
      const raw = parsed.data;
      if (raw.regionId !== region.regionId || raw.logicalActId !== region.logicalActId || raw.actIndex !== region.actIndex) { add("CHUNK_IDENTITY", "Model changed planner act identity", region.regionId); continue; }
      if (raw.conversationPolicy) {
        try {
          const evidence = raw.conversationPolicy.evidence.map(e => resolveCitation(context, e, chunk));
          if (!evidence.length) add("POLICY_EVIDENCE", "Policy has no source evidence", region.regionId);
          if (output.conversationPolicy && output.conversationPolicy.mode !== raw.conversationPolicy.mode) add("POLICY_CONFLICT", "Chunks disagree on conversation policy", region.regionId);
          else output.conversationPolicy = { mode: raw.conversationPolicy.mode, source: "manual", evidence: [...(output.conversationPolicy?.evidence ?? []), ...evidence] };
        } catch (e) { add("POLICY_EVIDENCE", String(e), region.regionId); }
      }
      const localIds = new Set<string>();
      let previousStart = chunk.start;
      for (const item of raw.items) {
        const id = `${context.manualId}:${region.logicalActId ?? region.regionId}:${region.variantGroupId ?? "common"}:${region.branchId ?? "common"}:${chunk.index}:${item.localId}`;
        if (localIds.has(item.localId)) { add("DUPLICATE_ITEM_ID", id, region.regionId); continue; }
        localIds.add(item.localId);
        if (item.variantGroupId !== region.variantGroupId || item.branchId !== region.branchId) { add("BRANCH_IDENTITY", "Item must inherit the planned region branch; splitting needs a new plan", region.regionId, id); continue; }
        try {
          const evidence = resolveCitation(context, item.evidence, chunk);
          if (evidence.sourceSpan.start < previousStart) add("ITEM_SOURCE_ORDER", "Item order contradicts source sequence", region.regionId, id);
          previousStart = evidence.sourceSpan.start;
          for (const selection of item.action?.variantSelection ?? []) resolveCitation(context, selection.evidence, chunk);
          if (item.authorization) resolveCitation(context, item.authorization.evidence, chunk);
          const key = JSON.stringify({ ...item, localId: undefined, evidence: evidence.sourceSpan });
          if (dedup.has(key)) continue;
          dedup.add(key);
          const targets = resolveTargets(context, plan, item.question?.targetRoles ?? item.clue?.targetRoles ?? []);
          output.items.push({ ...item, id, evidence, order: output.items.length, resolvedTargetRoles: targets.resolved, unresolvedTargetRoles: targets.unresolved });
        } catch (e) { add("ITEM_EVIDENCE", String(e), region.regionId, id); }
      }
      for (const message of raw.warnings) issues.push({ code: "EXTRACTION_WARNING", severity: "warning", message, regionId: region.regionId, repairCandidate: true });
    }
    regions.push(output);
  }
  // A transition is a hard semantic boundary even if the model emits more control items afterwards.
  const semantic: SemanticManualV2 = { format: "semantic_v2", manualId: context.manualId, regions, variants: plan.variants, roster: plan.roster };
  return { semantic, validation: validateSemanticManual(context, semantic, issues) };
}

export function validateSemanticManual(context: ManualContext, semantic: SemanticManualV2, inherited: SemanticIssue[] = []): SemanticValidation {
  const issues = [...inherited];
  const add = (code: string, message: string, regionId: string, itemId?: string) => issues.push({ code, severity: "error", message, regionId, itemId, repairCandidate: true });
  const acts = new Map<string, SemanticRegionV2[]>();
  for (const region of semantic.regions) {
    const r = region.region;
    if (r.logicalActId && r.semanticSectionType === "act") acts.set(r.logicalActId, [...(acts.get(r.logicalActId) ?? []), region]);
    if (!region.items.length) add("SEMANTIC_COVERAGE_GAP", "No semantic items in extracted region", r.regionId);
    for (const p of context.paragraphs.filter(p => p.index >= r.paragraphStart && p.index <= r.paragraphEnd)) {
      if (!region.items.some(i => i.evidence.sourceSpan.start < p.end && i.evidence.sourceSpan.end > p.start)) issues.push({ code: "PARAGRAPH_NOT_EVIDENCED", severity: "warning", message: `Paragraph ${p.index} is not directly cited`, regionId: r.regionId, repairCandidate: true });
    }
    let transitioned = false;
    for (const item of region.items) {
      try {
        if (item.evidence.sourceDocumentId !== context.source.documentId || item.evidence.sourceRevision !== context.source.documentRevision || item.evidence.sectionSetRevision !== context.source.sectionSetRevision) throw new Error("Evidence revision differs from manual manifest");
        resolveCitation(context, { paragraphStart: item.evidence.paragraphStart, paragraphEnd: item.evidence.paragraphEnd,
          sourceStart: item.evidence.sourceSpan.start, sourceEnd: item.evidence.sourceSpan.end, sourceQuote: item.evidence.sourceQuote }, { start: r.sourceStart, end: r.sourceEnd });
      } catch (e) { add("ITEM_EVIDENCE", String(e), r.regionId, item.id); }
      const expected = item.kind === "spoken_line" || item.kind === "question" ? "spoken" : ["action", "performance", "clue_release"].includes(item.kind) ? "action" : ["reading", "conversation_window", "transition", "reveal", "variant_group"].includes(item.kind) ? "control" : "internal_only";
      if (item.channel !== expected) add("CHANNEL_CONFLICT", `${item.kind} cannot use ${item.channel}`, r.regionId, item.id);
      if (item.channel === "spoken" && (item.action || item.clue || item.conditional)) add("MIXED_SPOKEN_OPERATION", "Split spoken and operation payloads into distinct items", r.regionId, item.id);
      if (item.kind === "spoken_line" && (!item.instruction.trim() || !item.evidence.sourceQuote.includes(item.instruction))) add("SPOKEN_NOT_VERBATIM", "Spoken line is not contained verbatim in its source quote", r.regionId, item.id);
      if (item.confidence < .6 || item.kind === "unknown") add("UNKNOWN_SEMANTIC", item.instruction, r.regionId, item.id);
      if (item.unresolvedTargetRoles.length) add("ROLE_ALIAS_AMBIGUITY", item.unresolvedTargetRoles.join(", "), r.regionId, item.id);
      for (const target of item.resolvedTargetRoles) if (!context.source.knownRoles.some(role => role.name === target)) add("ROLE_DEPENDENCY_MISSING", `Required referenced role is not in manifest: ${target}`, r.regionId, item.id);
      if (item.kind === "reading" && (!item.reading || item.reading.actIndex !== r.actIndex)) add("READING_TARGET", "Reading act differs from logical act; cross-act reading must be a transition", r.regionId, item.id);
      if (item.kind === "question" && !item.question || item.kind === "conversation_window" && !item.conversation || item.kind === "clue_release" && (!item.clue || !item.action) || ["action", "performance"].includes(item.kind) && !item.action) add("MISSING_SEMANTIC_PAYLOAD", item.kind, r.regionId, item.id);
      if (item.kind === "reveal" && !item.authorization) add("REVEAL_AUTHORIZATION", "Reveal requires explicit authorization evidence", r.regionId, item.id);
      if (item.kind === "transition" && (!item.transition || (item.transition.terminal !== (item.transition.nextActIndex === null)))) add("TRANSITION_TARGET_EVIDENCE", "Transition target/end must be explicit", r.regionId, item.id);
      if (item.kind === "transition" && item.transition?.nextActIndex !== null && item.transition?.nextActIndex === r.actIndex) add("TRANSITION_SELF_LOOP", "Cross-act transition cannot silently loop to the same act", r.regionId, item.id);
      if (transitioned && ["reading", "conversation_window", "transition"].includes(item.kind)) add("CROSS_TRANSITION_SEQUENCE", "Control continues after act transition", r.regionId, item.id);
      transitioned ||= item.kind === "transition";
      if (item.kind === "conditional_rule" && (!item.conditional || item.conditional.targetLocalId && !region.items.some(i => i.localId === item.conditional!.targetLocalId))) add("CONDITIONAL_REFERENCE", "Unresolved condition target", r.regionId, item.id);
      const peers = region.items.filter(i => i.id !== item.id && i.evidence.sourceSpan.start === item.evidence.sourceSpan.start && i.evidence.sourceSpan.end === item.evidence.sourceSpan.end && i.kind === item.kind && i.instruction !== item.instruction);
      if (peers.length) add("CONTRADICTORY_OVERLAP", "Same source/kind has conflicting interpretation", r.regionId, item.id);
    }
  }
  for (const [id, fragments] of acts) {
    const common = fragments.filter(r => !r.region.branchId), policies = common.flatMap(r => r.conversationPolicy ? [r.conversationPolicy] : []);
    const modes = new Set(policies.map(p => p.mode));
    if (!policies.length || modes.size !== 1 || modes.has("unknown") || modes.has("hybrid") || policies.some(p => !p.evidence.length)) add("CONVERSATION_POLICY_UNRESOLVED", id, common[0]?.region.regionId ?? id);
    const items = common.flatMap(r => r.items);
    let exited = false;
    for (const item of items) {
      if (exited && !["internal_note", "conditional_rule"].includes(item.kind)) add("CROSS_TRANSITION_SEQUENCE", "Common act sequence continues after transition", common[0]?.region.regionId ?? id, item.id);
      exited ||= item.kind === "transition";
    }
    if (!items.some(i => i.kind === "reading")) add("READING_EVIDENCE_MISSING", id, common[0]?.region.regionId ?? id);
    const windows = items.filter(i => i.kind === "conversation_window");
    if (!windows.length || new Set(windows.map(i => i.conversation?.windowId)).size !== windows.length) add("DISCUSSION_WINDOW_IDENTITY", id, common[0]?.region.regionId ?? id);
    if (modes.has("free_discussion_after_reading") && windows.some(i => i.conversation?.mode === "ordered_sharing")) add("FAKE_ORDERED_SHARING", id, common[0]?.region.regionId ?? id);
    if (modes.has("ordered_share_then_discuss") && !windows.some(i => i.conversation?.mode === "ordered_sharing")) add("ORDERED_SHARE_EVIDENCE_MISSING", id, common[0]?.region.regionId ?? id);
  }
  return makeValidation(issues);
}

export function compactChunkContext(record: ChunkRecord): string {
  const raw = SemanticChunkOutputSchema.safeParse(record.output);
  return raw.success ? JSON.stringify({ regionId: raw.data.regionId, policy: raw.data.conversationPolicy?.mode, items: raw.data.items.map(i => ({ kind: i.kind, instruction: i.instruction.slice(0, 100), branchId: i.branchId, nextAct: i.transition?.nextActIndex })).slice(-6) }) : "Previous extraction failed; do not fabricate missing content.";
}

export function emptySemanticItem(kind: SemanticItemOutput["kind"], citation: Citation): SemanticItemOutput {
  return { localId: "item", kind, channel: "internal_only", instruction: citation.sourceQuote, confidence: 1, evidence: citation,
    variantGroupId: null, branchId: null, required: false, warnings: [], reading: null, conversation: null, question: null,
    action: null, clue: null, conditional: null, transition: null, authorization: null };
}
