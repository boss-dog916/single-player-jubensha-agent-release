import { AssemblyCoordinationInputSchema, AssemblyCoordinationOutputSchema, type AssemblyCoordinationInput, type AssemblyIssue } from "@/src/lib/schemas/manualAssemblyCoordinationSchema";
import type { ManualSourceSemantics, SourceSemanticItem } from "@/src/lib/schemas/manualSourceSemanticsSchema";
import { activityTextHash } from "./manualActivityValidation";
import { activitySourceEvidence, type ActivitySourcePack } from "./manualActivitySourcePreparation";
import { validateSourceSemantics } from "./manualSourceSemanticAssembler";

export function assemblyIssueId(pack: ActivitySourcePack, kind: AssemblyIssue["kind"], key: string) {
  return `issue_${activityTextHash(JSON.stringify([pack.sourceFingerprint, kind, key])).slice(0, 24)}`;
}
export function phaseIssueKey(item: SourceSemanticItem) { return item.phaseHint?.sourceLabel ?? item.contextHint ?? "unassigned"; }
export function prepareAssemblyCoordination(input: unknown, pack: ActivitySourcePack): AssemblyCoordinationInput {
  const validated = validateSourceSemantics(input, pack);
  if (!validated.data || validated.errors.length) throw new Error(`Invalid source contract: ${JSON.stringify(validated.errors)}`);
  const data = validated.data;
  const issues: AssemblyIssue[] = [];
  const add = (kind: AssemblyIssue["kind"], key: string, related: SourceSemanticItem[], reason: string, requiredResolution: string,
    severity: AssemblyIssue["severity"] = "assembly_blocker") => issues.push({ id: assemblyIssueId(pack, kind, key), kind,
    sourceRefs: [...new Set(related.flatMap(i => i.sourceBlockIds))], relatedSemanticItemIds: related.map(i => i.localId), reason, requiredResolution, severity });
  const phaseItems = data.items.filter(i => i.phaseHint);
  for (const label of [...new Set(phaseItems.map(i => i.phaseHint!.sourceLabel))]) {
    const related = data.items.filter(i => i.phaseHint?.sourceLabel === label && (["spoken_content", "stage_action", "media_cue", "discussion_instruction", "runtime_choice"].includes(i.semanticKind) ||
      i.semanticKind === "reading_instruction" && i.payload.modeHint !== "public_archive" || i.semanticKind === "phase_marker" && i.payload.markerKind === "next_reading") ||
      i.semanticKind === "external_asset_reference" && !i.phaseHint);
    add("activity_order", label, related, "Document/page order alone does not settle grouping and execution order", "Group source cues and supply an exhaustive activity-anchor order; no hash/localId order");
  }
  for (const i of data.items) {
    if (i.semanticKind === "configuration_option") add("configuration_scope", i.localId, [i], "Setup option may combine independent dimensions", "Map the existing option to grounded dimension facets");
    if (i.semanticKind === "conditional_guidance") {
      const related = data.items.filter(x => x.localId !== i.localId && x.phaseHint?.sourceLabel === i.phaseHint?.sourceLabel && (i.payload.effectKind === "deny_resource"
        ? x.semanticKind === "resource_rule" && ["catalogue", "eligibility"].includes(x.payload.ruleKindHint)
        : x.semanticKind === "required_information" || x.semanticKind === "spoken_content" && x.payload.intentHint === "host_question" || x.semanticKind === "media_cue"));
      add("trigger_scope", i.localId, [i, ...related], "IF/THEN lacks operational binding", "Bind existing point/entry/interaction/resource, or preserve the semantic predicate explicitly");
    }
    if (i.semanticKind === "runtime_choice") {
      add("choice_dispatch", i.localId, [i, ...data.items.filter(x => x.localId !== i.localId && (x.semanticKind === "resource_rule" && ["dispatch", "no_repeat"].includes(x.payload.ruleKindHint) ||
        x.semanticKind === "reading_instruction" && x.payload.modeHint === "public_archive" || x.semanticKind === "identity_statement" && ["persona", "performer"].includes(x.payload.relation) ||
        x.semanticKind === "phase_marker" && x.payload.markerKind === "reference"))],
        "Choice has facts but not a complete dispatch relation", "Bind archive reader, catalogue, assets, persona and commentary/SOLO relation");
    }
    if (i.semanticKind === "identity_statement" && i.payload.relation === "canonical_truth") add("authorization_binding", i.localId,
      [i, ...data.items.filter(x => x.semanticKind === "identity_statement" && x.payload.relation === "belief" || x.semanticKind === "disclosure_rule")],
      "Truth/belief linkage must not create a verified alias or invent disclosure permission", "Relate existing private truth, belief and disclosure facts only");
  }
  const configs = data.items.filter(i => i.semanticKind === "configuration_option");
  if (configs.length) add("configuration_compatibility", "variants", configs, "Do not infer a Cartesian product of setup options", "Only admit explicitly represented composite variants");
  return AssemblyCoordinationInputSchema.parse({ schemaVersion: "manual_assembly_coordination_v1", sourceFingerprint: pack.sourceFingerprint,
    semanticItems: data.items.map(({ localId, semanticKind, sourceBlockIds, payload, phaseHint, contextHint }) => ({ localId, semanticKind, sourceBlockIds, payload,
      ...(phaseHint ? { phaseHint } : {}), ...(contextHint ? { contextHint } : {}) })), sources: pack.blocks.map(({ id, text }) => ({ id, text })),
    candidatePhases: data.items.filter(i => i.semanticKind === "phase_marker" && ["enter", "reference"].includes(i.payload.markerKind))
      .map(i => ({ semanticItemId: i.localId, sourceLabel: i.semanticKind === "phase_marker" ? i.payload.sourceLabel : "" })), issues });
}

export function assemblyCoordinationTask(input: AssemblyCoordinationInput, issueIds: string[]): AssemblyCoordinationInput {
  if (new Set(issueIds).size !== issueIds.length || issueIds.some(id => !input.issues.some(i => i.id === id))) throw new Error("Unknown or duplicate coordination issue");
  const issues = input.issues.filter(i => issueIds.includes(i.id)), relevant = new Set(issues.flatMap(i => i.relatedSemanticItemIds));
  const semanticItems = input.semanticItems.filter(i => relevant.has(i.localId)), phaseLabels = new Set(semanticItems.flatMap(i => i.phaseHint ? [i.phaseHint.sourceLabel] : []));
  const sourceIds = new Set(issues.flatMap(i => i.sourceRefs));
  return { ...input, issues, semanticItems, sources: input.sources.filter(s => sourceIds.has(s.id)),
    candidatePhases: input.candidatePhases.filter(p => relevant.has(p.semanticItemId) || phaseLabels.has(p.sourceLabel)) };
}

export function validateAssemblyCoordination(output: unknown, input: AssemblyCoordinationInput, source: ManualSourceSemantics, pack: ActivitySourcePack) {
  const parsed = AssemblyCoordinationOutputSchema.safeParse(output);
  const errors: string[] = [];
  if (!parsed.success) return { data: null, errors: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) };
  if (input.sourceFingerprint !== pack.sourceFingerprint) errors.push("STALE_SOURCE_FINGERPRINT");
  if (JSON.stringify(input) !== JSON.stringify(prepareAssemblyCoordination(source, pack))) errors.push("FORGED_COORDINATION_INPUT");
  const known = new Set(source.items.map(i => i.localId)), seen = new Set<string>();
  for (const r of parsed.data.resolutions) {
    const issue = input.issues.find(i => i.id === r.issueId);
    if (!issue) errors.push(`UNKNOWN_ISSUE:${r.issueId}`);
    for (const ref of [...r.selectedRefs, ...r.ordering ?? []]) {
      if (!known.has(ref)) errors.push(`NEW_SEMANTIC_ITEM_FORBIDDEN:${ref}`);
      if (issue && !issue.relatedSemanticItemIds.includes(ref)) errors.push(`ISSUE_REFERENCE_FENCE:${ref}`);
    }
    for (const ref of r.sourceRefs) try { activitySourceEvidence(pack, ref); } catch { errors.push(`SOURCE_FENCE:${ref}`); }
    if (r.resolutionKind === "keep_unresolved" ? r.confidence !== "unresolved" || !r.unresolvedReason : r.confidence !== "source_explicit" || !r.selectedRefs.length) errors.push("RESOLUTION_CONFIDENCE");
    if (r.ordering && (new Set(r.ordering).size !== r.ordering.length || r.ordering.some(x => !r.selectedRefs.includes(x)))) errors.push("INVALID_ORDERING");
    if (new Set(r.selectedRefs).size !== r.selectedRefs.length) errors.push("DUPLICATE_SELECTED_REF");
    if (r.scope && new Set(r.scope.map(s => s.dimension)).size !== r.scope.length) errors.push("DUPLICATE_SCOPE_DIMENSION");
    const signature = JSON.stringify([r.issueId, r.resolutionKind, r.selectedRefs, r.binding, r.scope]);
    if (seen.has(signature)) errors.push("DUPLICATE_RESOLUTION"); seen.add(signature);
    if (r.resolutionKind === "scope" && (!issue || issue.kind !== "configuration_scope" || r.selectedRefs.length !== 1 || !r.scope?.length)) errors.push("INVALID_CONFIG_FACET");
    if (issue?.kind === "trigger_scope" && r.resolutionKind === "dispatch" && r.selectedRefs[0] !== issue.relatedSemanticItemIds[0]) errors.push("TRIGGER_TARGET_MISMATCH");
    if (r.binding === "phase_quota" && (!r.quota || r.selectedRefs.filter(ref => source.items.find(s => s.localId === ref)?.semanticKind === "phase_marker").length !== 1)) errors.push("INVALID_QUOTA_BINDING");
    if (r.resolutionKind === "ordering" && !r.ordering?.length) errors.push("MISSING_EXPLICIT_ORDER");
    if (r.resolutionKind === "grouping" && (!r.ordering || r.selectedRefs.length !== r.ordering.length)) errors.push("INCOMPLETE_GROUP_ORDER");
    if (["ordering", "grouping"].includes(r.resolutionKind) && issue?.kind !== "activity_order") errors.push("RELATION_KIND_MISMATCH");
    if (r.resolutionKind === "dispatch" && !r.binding) errors.push("MISSING_DISPATCH_BINDING");
    if (issue?.kind === "trigger_scope" && r.resolutionKind === "dispatch" && !["point_missing_after_entry", "entry_repeat", "semantic_predicate", "optional_interaction", "deny_before_phase"].includes(r.binding!)) errors.push("TRIGGER_BINDING_MISMATCH");
    if (["public_choice_cycle", "public_archive_reader", "relative_gender_dispatch", "archive_emphasis", "phase_quota"].includes(r.binding ?? "") && issue?.kind !== "choice_dispatch") errors.push("CHOICE_BINDING_MISMATCH");
    if (r.binding === "region_media_header" && r.resolutionKind !== "grouping") errors.push("MEDIA_HEADER_REGION_REQUIRED");
    if (r.binding === "identity_belief" && issue?.kind !== "authorization_binding") errors.push("IDENTITY_BINDING_MISMATCH");
    if (r.binding === "explicit_variants_only" && issue?.kind !== "configuration_compatibility") errors.push("COMPATIBILITY_BINDING_MISMATCH");
    if (r.quota !== undefined && r.binding !== "phase_quota") errors.push("QUOTA_NOT_APPLICABLE");
    if (r.binding === "phase_quota") {
      const marker = r.selectedRefs.map(ref => source.items.find(s => s.localId === ref)).find(s => s?.semanticKind === "phase_marker");
      const quotes = r.sourceRefs.map(ref => pack.blocks.find(b => b.id === ref)?.text ?? "").join("\n").replace(/\s/g, "");
      if (marker?.semanticKind !== "phase_marker" || !quotes.includes(`${marker.payload.sourceLabel}${r.quota}个`)) errors.push("QUOTA_NOT_SOURCE_GROUNDED");
    }
    if (r.sourceRefs.some(ref => pack.blocks.find(b => b.id === ref)?.purpose === "archive_cross_reference") && r.binding !== "archive_emphasis") errors.push("CROSS_REFERENCE_SCOPE");
  }
  return { data: parsed.data, errors };
}
