import { ManualSourceSemanticsSchema, type SourceSemanticItem } from "@/src/lib/schemas/manualSourceSemanticsSchema";
import { ManualActivityIRSchema, type ManualActivityIR, type ManualActivity, type ActivityEvidence, type Audience, type PerformanceScriptSchema } from "@/src/lib/schemas/manualActivityIRSchema";
import type { z } from "zod";
import { activitySourceEvidence, type ActivitySourcePack } from "./manualActivitySourcePreparation";
import { activityTextHash, validateManualActivityIR } from "./manualActivityValidation";

export const SOURCE_ASSEMBLER_VERSION = "manual-source-assembler-prototype-1";
export type SourceAssemblyIssue = { code: string; localId: string | null; sourceBlockIds: string[]; message: string };
type Spoken = Extract<SourceSemanticItem, { semanticKind: "spoken_content" }>;
export function validateSourceSemantics(input: unknown, pack: ActivitySourcePack) {
  const parsed = ManualSourceSemanticsSchema.safeParse(input);
  const errors: SourceAssemblyIssue[] = [];
  if (!parsed.success) return { data: null, errors: parsed.error.issues.map(i => ({ code: "SOURCE_SCHEMA", localId: null, sourceBlockIds: [], message: `${i.path.join(".")}: ${i.message}` })) };
  const ids = new Set<string>();
  for (const item of parsed.data.items) {
    if (ids.has(item.localId)) errors.push({ code: "DUPLICATE_LOCAL_ID", localId: item.localId, sourceBlockIds: item.sourceBlockIds, message: "No merging/repair" });
    ids.add(item.localId);
    const refs = [...item.sourceBlockIds, ...(item.semanticKind === "configuration_option" ? item.payload.appliesToSourceBlocks : [])];
    for (const ref of refs) try { activitySourceEvidence(pack, ref); } catch {
      errors.push({ code: "SOURCE_FENCE", localId: item.localId, sourceBlockIds: [ref], message: "Block not in supplied source corpus" });
    }
    if (item.sourceBlockIds.some(id => pack.blocks.find(b => b.id === id)?.purpose === "archive_cross_reference") &&
      !["required_information", "resource_rule", "guidance"].includes(item.semanticKind)) errors.push({ code: "CROSS_REFERENCE_SCOPE", localId: item.localId, sourceBlockIds: item.sourceBlockIds, message: "Supplemental archive pages cannot establish main structure/casting" });
  }
  for (const u of parsed.data.unresolved) for (const ref of u.sourceBlockIds) try { activitySourceEvidence(pack, ref); } catch {
    errors.push({ code: "SOURCE_FENCE", localId: null, sourceBlockIds: [ref], message: "Unresolved evidence is still fenced" });
  }
  return { data: parsed.data, errors };
}

export function hydrateSpokenSource(item: Spoken, pack: ActivitySourcePack) {
  const units: Array<{ text: string; evidence: ActivityEvidence }> = [], issues: SourceAssemblyIssue[] = [];
  const fail = (message: string) => issues.push({ code: "requires_semantic_assembly", localId: item.localId, sourceBlockIds: item.sourceBlockIds, message });
  if (item.payload.fidelityHint === "unresolved") { fail("Spoken fidelity is unresolved; not silently fixed/reference"); return { units, issues }; }
  if ((item.payload.excerpt || item.payload.boundaries) && item.sourceBlockIds.length !== 1) { fail("Short selection must identify one block, not merge paragraphs"); return { units, issues }; }
  if (item.payload.excerpt && item.payload.boundaries) { fail("Two competing text selections"); return { units, issues }; }
  for (const blockId of item.sourceBlockIds) {
    const e = activitySourceEvidence(pack, blockId), raw = e.sourceQuote;
    let start = 0, end = raw.length;
    const uniqueIndex = (text: string) => { const i = raw.indexOf(text); return i >= 0 && raw.indexOf(text, i + 1) < 0 ? i : -1; };
    if (item.payload.boundaries) {
      const a = uniqueIndex(item.payload.boundaries.start), b = uniqueIndex(item.payload.boundaries.end);
      if (a < 0 || b <= a) { fail(`Nonunique/reversed boundaries in ${blockId}`); continue; }
      start = a; end = b;
    } else if (item.payload.excerpt) {
      const at = uniqueIndex(item.payload.excerpt);
      if (at < 0) { fail(`Excerpt is not a unique exact source substring in ${blockId}`); continue; }
      start = at; end = at + item.payload.excerpt.length;
    } else if (e.locator.format === "pdf") { fail(`Page-sized speech needs boundaries/excerpt: ${blockId}`); continue; }
    else start = raw.match(/^(?:(?:固定话术|参考话术)\s*[:：]\s*|[男女](?:生)?\s*[:：]\s*)/)?.[0].length ?? 0;
    const text = raw.slice(start, end);
    const speakers = new Set(Array.from(text.matchAll(/([男女])(?:生)?(?:\s*[（(][^）)\n]{0,30}[）)])?\s*[:：]/g)).map(m => m[1]));
    const sourceSpeaker = !item.payload.excerpt && !item.payload.boundaries ? raw.match(/^([男女])(?:生)?\s*[:：]/)?.[1] : undefined;
    if (sourceSpeaker) speakers.add(sourceSpeaker);
    if (speakers.size > 1 || /男\s*[&/]\s*女\s*[:：]/.test(text) || [...speakers].some(s => !item.payload.speakerHint.includes(s))) { fail(`Mixed/unconfirmed speakers in ${blockId}`); continue; }
    if (!text.trim()) { fail(`Empty selected speech in ${blockId}`); continue; }
    units.push({ text, evidence: { ...e, sourceSpan: { start: e.sourceSpan.start + start, end: e.sourceSpan.start + end }, sourceQuote: text } });
  }
  // Never partially publish a unit whose other supplied paragraphs failed.
  return { units: issues.length ? [] : units, issues };
}

export function assembleSourceSemantics(input: unknown, pack: ActivitySourcePack) {
  const checked = validateSourceSemantics(input, pack);
  const issues = [...checked.errors];
  const retained = checked.data;
  const contributions: Record<string, string[]> = {};
  if (!retained || checked.errors.length) return { candidate: null, retained, issues, contributions, validation: null, assemblyStatus: "invalid_source" as const, prototypeOnly: true as const };
  const ir: ManualActivityIR = { schemaVersion: "manual_activity_v1", sourceManifest: pack.corpus.map(d => ({ documentId: d.documentId, revision: d.revision,
    sourceHash: d.sourceHash, textHash: activityTextHash(d.text), locatorVersion: d.locatorVersion, layoutFidelity: d.layoutFidelity ?? "unsupported" })),
    actors: [], configurations: [], content: [], policies: { conditions: [], requiredPoints: [], discussion: [], interactions: [], conditional: [], guidance: [], authorizations: [] },
    resources: [], externalAssets: [], identities: [], phases: [] };
  const prefix = `source_${pack.sourceFingerprint.slice(0, 12)}_`;
  const stable = (kind: string, value: unknown) => prefix + activityTextHash(JSON.stringify([kind, value])).slice(0, 24);
  const evidence = (item: SourceSemanticItem) => item.sourceBlockIds.map(id => activitySourceEvidence(pack, id));
  const origin = (item: SourceSemanticItem) => Math.min(...evidence(item).map(e => e.sourceSpan.start));
  const semanticKey = (item: SourceSemanticItem) => activityTextHash(JSON.stringify([item.semanticKind, item.sourceBlockIds, item.payload, item.phaseHint, item.contextHint]));
  const sorted = [...retained.items].sort((a, b) => origin(a) - origin(b) || semanticKey(a).localeCompare(semanticKey(b)));
  const addIssue = (item: SourceSemanticItem, message: string) => issues.push({ code: "requires_semantic_assembly", localId: item.localId, sourceBlockIds: item.sourceBlockIds, message });
  const emit = (item: SourceSemanticItem, id: string) => { (contributions[item.localId] ??= []).push(id); return id; };
  const publicAudience: Audience = { kind: "public" }, internal: Audience = { kind: "dm_only" };
  const actor = (name: string, item: SourceSemanticItem, storyRole = false, controller: ManualActivityIR["actors"][number]["controller"] = "unresolved") => {
    let a = ir.actors.find(a => a.label === name);
    if (!a) { const id = stable("actor", name); a = { id, label: name, storyRole: storyRole ? id : null, controller, speakingPersona: null, bindingEvidence: [], sourceEvidence: evidence(item) }; ir.actors.push(a); }
    else { if (storyRole) a.storyRole = a.id; if (controller !== "unresolved") a.controller = controller; }
    return a.id;
  };
  const text = (item: SourceSemanticItem, value: string, suffix: string, audience: Audience = internal, release: string | null = null, ev = evidence(item)) => {
    const id = stable("text", [item.semanticKind, item.sourceBlockIds, value, suffix]);
    if (!ir.content.some(c => c.id === id)) ir.content.push({ id, kind: "text", text: value, audience, configurationScope: null, releaseConstraintRef: release, sourceEvidence: ev });
    return emit(item, id);
  };
  const phaseByLabel = new Map<string, ManualActivityIR["phases"][number]>();
  const phaseForMarker = new Map<string, ManualActivityIR["phases"][number]>();
  for (const item of sorted) if (item.semanticKind === "phase_marker" && ["enter", "reference"].includes(item.payload.markerKind)) {
    const p = item.payload;
    if (p.phaseTypeHint === "unknown" || p.phaseTypeHint === "act" && !p.actNumberHint || p.phaseTypeHint !== "act" && p.actNumberHint !== null) { addIssue(item, "Unresolved/inconsistent phase hint, no invented phase"); continue; }
    let phase = phaseByLabel.get(p.sourceLabel);
    if (phase && (phase.phaseType !== p.phaseTypeHint || phase.actNumber !== p.actNumberHint)) { addIssue(item, "Conflicting phase labels"); continue; }
    if (!phase) {
      phase = { id: stable("phase", [p.phaseTypeHint, p.actNumberHint, p.sourceLabel]), sourceEvidence: evidence(item), sourceLabel: p.sourceLabel,
        phaseType: p.phaseTypeHint, actNumber: p.actNumberHint, order: p.phaseTypeHint === "prologue" ? 0 : p.actNumberHint ?? 1000, activities: [] };
      ir.phases.push(phase); phaseByLabel.set(p.sourceLabel, phase);
    } else phase.sourceEvidence.push(...evidence(item));
    phaseForMarker.set(item.localId, phase); emit(item, phase.id);
  }
  ir.phases.sort((a, b) => a.order - b.order);
  const phaseOf = (item: SourceSemanticItem) => {
    if (item.phaseHint) {
      const p = phaseByLabel.get(item.phaseHint.sourceLabel);
      if (!p || p.actNumber !== item.phaseHint.actNumberHint || p.phaseType !== item.phaseHint.phaseTypeHint) { addIssue(item, "phaseHint needs grounded phase-marker assembly"); return undefined; }
      return p;
    }
    const candidates = sorted.filter((x): x is Extract<SourceSemanticItem, { semanticKind: "phase_marker" }> => x.semanticKind === "phase_marker" && x.payload.markerKind === "enter" && origin(x) <= origin(item));
    const last = candidates.at(-1); return last ? phaseForMarker.get(last.localId) : undefined;
  };
  for (const item of sorted) if (item.semanticKind === "identity_statement") {
    const p = item.payload;
    if (["story_role", "performer", "persona"].includes(p.relation)) {
      const controller = p.relation === "performer" && ["dm", "human", "media"].includes(p.objectText) ? p.objectText as "dm" | "human" | "media" : "unresolved";
      emit(item, actor(p.subjectText, item, p.relation === "story_role", controller));
    } else { text(item, `${p.subjectText}: ${p.objectText}`, "identity_fact"); addIssue(item, "Identity claim/belief preserved internally; canonical/alias resolution requires trusted evidence and release coordination"); }
  }
  for (const item of sorted) if (item.semanticKind === "configuration_option") {
    const p = item.payload;
    let config = ir.configurations.find(c => c.dimension === p.dimensionHint);
    if (!config) { config = { id: stable("config", p.dimensionHint), dimension: p.dimensionHint, selectionRequired: true, options: [], compatibilityConstraints: [], sourceEvidence: evidence(item) }; ir.configurations.push(config); }
    if (config.options.some(o => o.label === p.optionLabel)) { addIssue(item, "Repeated config option needs evidence reconciliation"); continue; }
    const id = stable("option", [p.dimensionHint, p.optionLabel]);
    config.options.push({ id, label: p.optionLabel, capabilityConstraints: [], actorBindings: [], contentRefs: [], sourceEvidence: evidence(item) }); emit(item, id);
    const option = config.options.at(-1)!;
    for (const block of p.appliesToSourceBlocks) {
      const e = activitySourceEvidence(pack, block), contentRef = text(item, e.sourceQuote, `config_${id}_${block}`, internal, null, [e]);
      ir.content.find(c => c.id === contentRef)!.configurationScope = [{ dimension: p.dimensionHint, option: id }];
      option.contentRefs.push(contentRef);
    }
  }
  const scopeFor = (item: SourceSemanticItem) => {
    const options = sorted.filter((x): x is Extract<SourceSemanticItem, { semanticKind: "configuration_option" }> => x.semanticKind === "configuration_option");
    const explicit = options.filter(x => x.payload.optionLabel === item.contextHint);
    const matches = explicit.length ? explicit : options.filter(x => item.sourceBlockIds.every(b => x.payload.appliesToSourceBlocks.includes(b)));
    const scope = matches.map(m => ({ dimension: m.payload.dimensionHint, option: stable("option", [m.payload.dimensionHint, m.payload.optionLabel]) }));
    if (new Set(scope.map(s => s.dimension)).size !== scope.length) { addIssue(item, "Multiple options in one source scope; not guessing shared/selected ownership"); return undefined; }
    return scope.length ? scope : null;
  };
  const scheduled: Array<{ phase: ManualActivityIR["phases"][number]; item: SourceSemanticItem; activity: ManualActivity }> = [];
  const base = (item: SourceSemanticItem, suffix: string, audience: Audience = publicAudience) => ({ id: stable("activity", [item.semanticKind, item.sourceBlockIds, item.contextHint, item.payload, suffix]),
    order: 0, sourceEvidence: evidence(item), participants: [] as string[], audience, configurationScope: scopeFor(item) ?? null,
    activation: "sequence" as const, entryCondition: null, contentRefs: [] as string[], policyRefs: [] as string[] });
  const schedule = (item: SourceSemanticItem, a: ManualActivity) => {
    const phase = phaseOf(item);
    if (!phase) { addIssue(item, "Activity needs a grounded phase"); return; }
    if (scopeFor(item) === undefined) return;
    scheduled.push({ phase, item, activity: a }); emit(item, a.id);
  };
  // This offline prototype is supplied an empty asset bundle, not runtime storage.
  const assetContent = new Map<string, string[]>();
  for (const item of sorted) if (item.semanticKind === "external_asset_reference") {
    const p = item.payload, id = stable("asset", [p.label, p.assetTypeHint]), contentId = stable("external", id);
    if (!ir.externalAssets.some(a => a.id === id)) ir.externalAssets.push({ id, label: p.label, status: "missing", verifiedHash: null,
      required: p.requiredHint, capabilityRef: p.assetTypeHint === "script" || p.assetTypeHint === "archive" ? "external_text" : p.assetTypeHint, sourceEvidence: evidence(item) });
    if (!ir.content.some(c => c.id === contentId)) ir.content.push({ id: contentId, kind: "external", assetRef: id, sourceEvidence: evidence(item), audience: publicAudience, configurationScope: null, releaseConstraintRef: null });
    if (item.contextHint) assetContent.set(item.contextHint, [...assetContent.get(item.contextHint) ?? [], contentId]);
    emit(item, id); emit(item, contentId);
  }
  for (const item of sorted) if (item.semanticKind === "resource_rule" && item.payload.ruleKindHint === "catalogue") {
    const p = item.payload;
    const eligibility = sorted.filter((x): x is Extract<SourceSemanticItem, { semanticKind: "resource_rule" }> =>
      x.semanticKind === "resource_rule" && x.payload.resourceLabel === p.resourceLabel && x.payload.ruleKindHint === "eligibility");
    const refs = [...new Set(assetContent.get(p.resourceLabel) ?? [])];
    if (eligibility.length !== 1 || !eligibility[0].payload.notBeforeActHint || !refs.length) { addIssue(item, "Resource needs one grounded eligibility fact and explicitly associated asset references"); continue; }
    const minimum = eligibility[0].payload.notBeforeActHint;
    const phases = ir.phases.filter(phase => phase.phaseType === "act" && phase.actNumber! >= minimum);
    if (!phases.length) { addIssue(item, "Resource eligibility points outside grounded phases"); continue; }
    const bundle = stable("resource_bundle", [p.resourceLabel, refs]), id = stable("resource", p.resourceLabel);
    ir.content.push({ id: bundle, kind: "bundle", contentRefs: refs, audience: publicAudience, configurationScope: null, releaseConstraintRef: null, sourceEvidence: evidence(item) });
    ir.resources.push({ id, labelRef: text(item, p.resourceLabel, "resource_menu", publicAudience), contentBundleRef: bundle,
      eligiblePhaseRefs: phases.map(phase => phase.id), performerRefs: [], personaRef: null, sourceEvidence: [...evidence(item), ...evidence(eligibility[0])] });
    emit(item, id); emit(item, bundle);
    addIssue(item, "Catalogue/eligibility/assets assembled only; performer/persona, no-repeat state and dispatch authorization are not established");
  }
  const groups = new Map<string, { items: SourceSemanticItem[]; beats: z.infer<typeof PerformanceScriptSchema>["beats"]; phase: ManualActivityIR["phases"][number]; hostIntent: "question" | "explain" | null }>();
  for (const item of sorted) if (["spoken_content", "stage_action", "media_cue"].includes(item.semanticKind)) {
    const phase = phaseOf(item); if (!phase) { addIssue(item, "Cue cannot be grouped without a phase"); continue; }
    const scope = scopeFor(item); if (scope === undefined) continue;
    const key = JSON.stringify([phase.id, item.contextHint ?? [item.semanticKind, item.sourceBlockIds, item.payload], scope]);
    let group = groups.get(key);
    if (!group) { group = { items: [], beats: [], phase, hostIntent: null }; groups.set(key, group); }
    const cues: z.infer<typeof PerformanceScriptSchema>["beats"][number]["cues"] = [];
    if (item.semanticKind === "spoken_content") {
      const hydrated = hydrateSpokenSource(item, pack); issues.push(...hydrated.issues); if (hydrated.issues.length) continue;
      const p = item.payload;
      if (p.intentHint?.startsWith("host_")) group.hostIntent = p.intentHint === "host_question" ? "question" : "explain";
      for (const [i, unit] of hydrated.units.entries()) {
        const textRef = text(item, unit.text, `spoken_${i}`, publicAudience, null, [unit.evidence]);
        group.beats.push({ id: stable("beat", [key, unit.evidence.sourceSpan, item.payload, i]), order: group.beats.length, interactionRef: null,
          cues: [{ kind: "Spoken", performerRef: actor(p.speakerHint, item), personaRef: p.personaHint ? actor(p.personaHint, item) : null,
            targetRefs: [], textRef, fidelity: p.fidelityHint as "fixed" | "reference" }] });
      }
    } else if (item.semanticKind === "stage_action") cues.push({ kind: "Stage", performerRef: actor(item.payload.performerHint, item),
      targetRefs: (item.payload.targetHints ?? []).map(n => actor(n, item)), actionRef: text(item, item.payload.actionSummary, "stage", publicAudience), capabilityRef: item.payload.capabilityHint ?? "physical_stage" });
    else if (item.semanticKind === "media_cue") cues.push({ kind: "Media", mediaRef: text(item, item.payload.label, "media", publicAudience), operation: item.payload.operation, timingRef: null });
    if (cues.length) group.beats.push({ id: stable("beat", [key, item.semanticKind, item.sourceBlockIds, item.payload]), order: group.beats.length, cues, interactionRef: null });
    group.items.push(item);
  }
  for (const group of groups.values()) {
    if (!group.beats.length || !group.items.length) continue;
    const pdfBlocks = group.items.filter(i => evidence(i).some(e => e.locator.format === "pdf")).flatMap(i => i.sourceBlockIds);
    if (new Set(pdfBlocks).size !== pdfBlocks.length) addIssue(group.items[0], "Several cues share a PDF page; page order alone cannot prove intra-page performance order");
    const representative = group.items[0], scriptId = stable("performance", group.items.map(i => [i.semanticKind, i.sourceBlockIds, i.contextHint, i.payload]));
    ir.content.push({ id: scriptId, kind: "performance", script: { beats: group.beats }, audience: publicAudience, configurationScope: scopeFor(representative) ?? null,
      releaseConstraintRef: null, sourceEvidence: group.items.flatMap(evidence) });
    group.items.forEach(item => emit(item, scriptId));
    const a: ManualActivity = group.hostIntent ? { ...base(representative, scriptId), kind: "DM_INTERVENE", completion: "inputs_recorded",
      payload: { intent: group.hostIntent, scriptRef: scriptId, targetSelector: { kind: "participants" }, interactionRef: null } }
      : { ...base(representative, scriptId), kind: "PERFORM", completion: "performance_finished", payload: { scriptRef: scriptId, interactionRefs: [] } };
    schedule(representative, a);
  }
  for (const item of sorted) {
    switch (item.semanticKind) {
      case "phase_marker": {
        if (item.payload.markerKind === "chapter") { text(item, item.payload.sourceLabel, "chapter"); break; }
        if (item.payload.markerKind !== "next_reading") break;
        const target = phaseByLabel.get(item.payload.sourceLabel);
        if (!target) { addIssue(item, "Next-reading target is not independently grounded; do not invent an act or terminal ending"); break; }
        schedule(item, { ...base(item, "transition"), kind: "TRANSITION", completion: "transitioned", payload: { targetPhaseRef: target.id, terminal: false, releaseRuleRefs: [] } }); break;
      }
      case "reading_instruction": {
        const p = item.payload;
        if (p.modeHint === "public_archive") { addIssue(item, "Public archive READ needs selection-dependent dispatch binding; retained as source fact"); break; }
        if (!p.subjectHints?.length) { addIssue(item, "Private reading audience not identified"); break; }
        const roles = p.subjectHints.map(n => actor(n, item, true)), audience: Audience = { kind: "selected_roles", roleRefs: roles };
        const contentRef = text(item, p.objectHint, "reading_scope", audience);
        schedule(item, { ...base(item, "read", audience), participants: roles, kind: "READ", completion: "reading_confirmed",
          payload: { contentRef, readingMode: "individual_private", readerSelector: { kind: "roles", roleRefs: roles }, confirmationsFrom: roles } }); break;
      }
      case "discussion_instruction": {
        const p = item.payload, a = base(item, "discuss"), policyId = stable("discussion", a.id), conditionId = stable("checkpoint", a.id);
        ir.policies.discussion.push({ id: policyId, sourceEvidence: evidence(item), mode: p.modeHint, preferredOrder: [], fallbackOrder: [], constraints: [], dmParticipation: "observe" });
        ir.policies.conditions.push({ id: conditionId, kind: "discussion_checkpoint", activityRef: a.id, sourceEvidence: evidence(item) });
        schedule(item, { ...a, kind: "DISCUSS", completion: "discussion_checkpoint", payload: { goalRef: text(item, p.summary, "goal", publicAudience), pointRefs: [], discussionPolicyRef: policyId, exitRuleRef: conditionId } }); break;
      }
      case "required_information": {
        const p = item.payload, first = phaseByLabel.get(p.timingHint.firstPhaseLabel), due = p.timingHint.duePhaseLabel ? phaseByLabel.get(p.timingHint.duePhaseLabel) : undefined;
        if (!first || p.missingBehaviorHint === "defer" && !due) { addIssue(item, "Point timing/defer deadline needs explicit source-grounded phase"); text(item, p.meaning, "point_unresolved"); break; }
        const id = stable("point", [item.sourceBlockIds, p.subjectHints, p.meaning]);
        ir.policies.requiredPoints.push({ id, sourceEvidence: evidence(item), subjectRoleRefs: p.subjectHints.map(n => actor(n, item, true)), meaningRef: text(item, p.meaning, "point_meaning"), importance: p.importanceHint,
          timing: { firstApplicablePhase: first.id, duePhase: due?.id ?? null, deferredFromPointRef: null }, completionMode: "public_observed",
          onMissing: p.missingBehaviorHint === "unknown" ? "mark_unresolved" : p.missingBehaviorHint, releaseConstraintRef: null, fallbackRef: null }); emit(item, id); break;
      }
      case "conditional_guidance": {
        const p = item.payload, phase = phaseOf(item);
        if (!phase || !["question", "acknowledge", "summarize"].includes(p.effectKind)) { addIssue(item, "Conditional effect requires additional binding/authorization/private assembly"); text(item, `${p.conditionText} → ${p.contentSummary}`, "conditional_unresolved"); break; }
        const conditionId = stable("semantic_condition", [item.sourceBlockIds, p.conditionText]), conditionText = text(item, p.conditionText, "condition");
        ir.policies.conditions.push({ id: conditionId, kind: "semantic", textRef: conditionText, operationalStatus: "unresolved", sourceEvidence: evidence(item) });
        const effectText = text(item, p.contentSummary, "conditional_effect", publicAudience);
        let effect: ManualActivityIR["policies"]["conditional"][number]["effect"];
        if (p.effectKind === "question") {
          const interactionId = stable("interaction", [conditionId, p.contentSummary]), waitId = stable("answer_wait", interactionId);
          if (p.waitForAnswerHint) ir.policies.conditions.push({ id: waitId, kind: "answer_submitted", interactionRef: interactionId, sourceEvidence: evidence(item) });
          ir.policies.interactions.push({ id: interactionId, sourceEvidence: evidence(item), targetSelector: p.targetHints ? { kind: "roles", roleRefs: p.targetHints.map(n => actor(n, item)) } : { kind: "participants" },
            responseMode: p.waitForAnswerHint ? "free_answer" : "none", waitRuleRef: p.waitForAnswerHint ? waitId : null, expectedInfoRefs: [], fallbackRef: effectText });
          effect = { kind: "cue_question", interactionRef: interactionId };
        } else if (p.effectKind === "acknowledge" || p.effectKind === "summarize") effect = { kind: p.effectKind, contentRef: effectText };
        else break;
        const id = stable("conditional_policy", conditionId);
        ir.policies.conditional.push({ id, sourceEvidence: evidence(item), scope: { phaseRefs: [phase.id], activityRefs: [] }, conditionRef: conditionId,
          triggerWhen: true, effect, priority: 0, once: false, cooldownMs: 0 }); emit(item, id);
        addIssue(item, "Natural-language IF retained as unresolved semantic condition, not falsely converted to a finite evaluator"); break;
      }
      case "guidance": {
        const phase = phaseOf(item), id = stable("guidance", [item.sourceBlockIds, item.payload.summary]);
        ir.policies.guidance.push({ id, kind: item.payload.guidanceKindHint, sourceEvidence: evidence(item), textRef: text(item, item.payload.summary, "guidance"),
          scope: { phaseRefs: phase ? [phase.id] : [], activityRefs: [] }, priority: 0, exceptions: [] }); emit(item, id); break;
      }
      case "disclosure_rule": {
        const p = item.payload, phase = phaseByLabel.get(p.notBeforeHint), conditionId = stable("disclosure_condition", [item.sourceBlockIds, p.protectedContentDescription]);
        if (phase) ir.policies.conditions.push({ id: conditionId, kind: "current_phase", phaseRef: phase.id, sourceEvidence: evidence(item) });
        else { const ruleText = text(item, `不得早于${p.notBeforeHint}：${p.protectedContentDescription}`, "release_rule");
          ir.policies.conditions.push({ id: conditionId, kind: "semantic", textRef: ruleText, operationalStatus: "unresolved", sourceEvidence: evidence(item) }); addIssue(item, "Disclosure release phase unresolved; retain deny-by-default"); }
        const audience: Audience = p.audienceHint === "selected_roles" && p.targetHints?.length ? { kind: "selected_roles", roleRefs: p.targetHints.map(n => actor(n, item, true)) } : internal;
        text(item, p.protectedContentDescription, "protected", audience, conditionId);
        // 'Not before X' is not permission to publish at X: no invented public authorization.
        break;
      }
      case "resource_rule": text(item, `${item.payload.resourceLabel}: ${item.payload.summary}`, "resource_rule"); addIssue(item, "Resource eligibility/dispatch/actor allocation needs assembly contract; raw facts kept, no invented graph"); break;
      case "runtime_choice": addIssue(item, "Runtime choice retained, never setup-resolved; complete resource/dispatch/authorization bindings are not yet mechanically established"); break;
    }
  }
  for (const s of scheduled.sort((a, b) => origin(a.item) - origin(b.item) || a.activity.id.localeCompare(b.activity.id))) {
    s.activity.order = s.phase.activities.length; s.phase.activities.push(s.activity);
  }
  for (const s of scheduled) if (scheduled.some(other => other !== s && other.phase.id === s.phase.id && origin(other.item) === origin(s.item))) {
    addIssue(s.item, "Tied source positions do not establish execution order; stored ordinals are candidate serialization only");
  }
  for (const p of ir.phases) for (const a of p.activities) if (a.kind === "DISCUSS") a.payload.pointRefs = ir.policies.requiredPoints.filter(x => x.timing.firstApplicablePhase === p.id).map(x => x.id);
  for (const u of retained.unresolved) issues.push({ code: "requires_semantic_assembly", localId: null, sourceBlockIds: u.sourceBlockIds, message: u.description });
  if (!ir.phases.length) return { candidate: null, retained, issues, contributions, validation: null, assemblyStatus: "incomplete" as const, prototypeOnly: true as const };
  const candidate = ManualActivityIRSchema.parse(ir), validation = validateManualActivityIR(candidate, pack.corpus);
  for (const error of validation.errors) issues.push({ code: error.code, localId: null, sourceBlockIds: [], message: `${error.path}: ${error.message}` });
  return { candidate, retained, issues, contributions, validation, assemblyStatus: validation.status === "invalid" ? "invalid_candidate" as const : issues.length ? "incomplete" as const : "assembled" as const, prototypeOnly: true as const };
}
