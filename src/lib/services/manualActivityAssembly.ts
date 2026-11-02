import type { ManualActivityIR, ManualActivity, ActivityContent, ActivityEvidence, Audience, PerformanceScriptSchema } from "@/src/lib/schemas/manualActivityIRSchema";
import { ManualActivityIRSchema } from "@/src/lib/schemas/manualActivityIRSchema";
import type { ManualSourceSemantics, SourceSemanticItem } from "@/src/lib/schemas/manualSourceSemanticsSchema";
import type { AssemblyIssue, AssemblyResolution } from "@/src/lib/schemas/manualAssemblyCoordinationSchema";
import type { z } from "zod";
import { assembleSourceSemantics, hydrateSpokenSource } from "./manualSourceSemanticAssembler";
import { prepareAssemblyCoordination, validateAssemblyCoordination, assemblyIssueId } from "./manualAssemblyCoordination";
import { activitySourceEvidence, type ActivitySourcePack } from "./manualActivitySourcePreparation";
import { activityTextHash, validateManualActivityIR } from "./manualActivityValidation";
import { hydrateRegionMediaHeader } from "./manualSourceMediaHydration";

type Scope = NonNullable<ManualActivity["configurationScope"]>;
export type TriggerBinding = { policyRef: string; sourceItemId: string; kind: NonNullable<AssemblyResolution["binding"]>;
  activityRef: string | null; pointRef: string | null; configurationScope: Scope | null };
export type DispatchBinding = { resourceRef: string; commentaryRef: string; soloRef: string; relation: "commentary_opposite_solo_same"; controllerStatus: "unresolved";
  segmentAssets: { commentary: string; solo: string } };
export type AssemblyResult = ReturnType<typeof assembleCoordinatedActivities>;

// Offline relation assembler. Source facts and coordinator references are fenced before any graph mutation.
export function assembleCoordinatedActivities(source: ManualSourceSemantics, pack: ActivitySourcePack, output: unknown) {
  const input = prepareAssemblyCoordination(source, pack), coordinated = validateAssemblyCoordination(output, input, source, pack);
  if (!coordinated.data || coordinated.errors.length) throw new Error(`Invalid coordination: ${coordinated.errors.join(", ")}`);
  const base = assembleSourceSemantics(source, pack);
  if (!base.candidate) throw new Error("No grounded source candidate");
  const ir = structuredClone(base.candidate), resolutions = coordinated.data.resolutions;
  const issues: AssemblyIssue[] = [], triggers: TriggerBinding[] = [], dispatch: DispatchBinding[] = [];
  const admittedVariants: Scope[] = [], phaseQuotas: Record<string, number> = {};
  const id = (kind: string, value: unknown) => `assembly_${activityTextHash(JSON.stringify([pack.sourceFingerprint, kind, value])).slice(0, 24)}`;
  const item = (ref: string) => source.items.find(s => s.localId === ref)!;
  const ev = (s: SourceSemanticItem) => s.sourceBlockIds.map(b => activitySourceEvidence(pack, b));
  const evidence = (refs: string[]) => refs.map(b => activitySourceEvidence(pack, b));
  const phase = (s: SourceSemanticItem) => ir.phases.find(p => p.sourceLabel === s.phaseHint?.sourceLabel);
  const addIssue = (kind: AssemblyIssue["kind"], refs: string[], reason: string, severity: AssemblyIssue["severity"] = "assembly_blocker") => {
    issues.push({ id: assemblyIssueId(pack, kind, reason + refs.join()), kind, relatedSemanticItemIds: refs,
      sourceRefs: [...new Set(refs.flatMap(r => item(r).sourceBlockIds))], reason, requiredResolution: reason, severity });
  };
  const pub: Audience = { kind: "public" }, internal: Audience = { kind: "dm_only" };
  const contributions = structuredClone(base.contributions);
  const anchorActivities = new Map<string, string[]>();
  const emit = (ref: string, a: ManualActivity) => { const p = phase(item(ref)); if (!p) { addIssue("transition_target", [ref], "No grounded phase"); return; }
    p.activities.push(a); anchorActivities.set(ref, [...anchorActivities.get(ref) ?? [], a.id]); (contributions[ref] ??= []).push(a.id); };
  const actor = (label: string, s: SourceSemanticItem) => {
    let found = ir.actors.find(a => a.label === label);
    if (!found) { found = { id: id("actor", label), label, storyRole: null, controller: "unresolved", speakingPersona: null, bindingEvidence: [], sourceEvidence: ev(s) }; ir.actors.push(found); }
    return found.id;
  };
  const text = (value: string, e: ActivityEvidence[], audience: Audience = pub, releaseConstraintRef: string | null = null) => {
    const ref = id("template", [e.map(x => [x.documentId, x.revision, x.sourceSpan]), value, audience, releaseConstraintRef]);
    if (!ir.content.some(c => c.id === ref)) ir.content.push({ id: ref, kind: "text", text: value, sourceEvidence: e, audience, configurationScope: null, releaseConstraintRef });
    return ref;
  };
  const activityBase = (key: unknown, e: ActivityEvidence[], scope: Scope | null = null, activation: ManualActivity["activation"] = "sequence") => ({
    id: id("activity", key), sourceEvidence: e, order: 0, participants: [] as string[], audience: pub, configurationScope: scope,
    activation, entryCondition: null, contentRefs: [] as string[], policyRefs: [] as string[] });
  const condition = (key: unknown, e: ActivityEvidence[], fields: Omit<Extract<ManualActivityIR["policies"]["conditions"][number], { kind: "event_flag" }>, "id" | "sourceEvidence">) => {
    const ref = id("condition", key); ir.policies.conditions.push({ id: ref, sourceEvidence: e, ...fields }); return ref;
  };

  // Replace flat setup options with grounded facets; composite variants remain an explicit allowlist.
  const oldConfigs = structuredClone(ir.configurations), configScopes = new Map<string, Scope>();
  ir.configurations = [];
  for (const s of source.items.filter(s => s.semanticKind === "configuration_option")) {
    if (s.semanticKind !== "configuration_option") continue;
    const rs = resolutions.filter(r => r.resolutionKind === "scope" && r.selectedRefs[0] === s.localId);
    if (rs.length !== 1) { addIssue("configuration_scope", [s.localId], "Exactly one facet resolution required"); continue; }
    const scope: Scope = [];
    for (const facet of rs[0].scope!) {
      let c = ir.configurations.find(c => c.dimension === facet.dimension);
      if (!c) { c = { id: id("config", facet.dimension), dimension: facet.dimension, sourceEvidence: ev(s), selectionRequired: true, options: [], compatibilityConstraints: [] }; ir.configurations.push(c); }
      let o = c.options.find(o => o.label === facet.option);
      if (!o) { o = { id: id("option", facet), label: facet.option, sourceEvidence: ev(s), contentRefs: [], capabilityConstraints: [], actorBindings: [] }; c.options.push(o); }
      scope.push({ dimension: c.dimension, option: o.id });
      if (rs[0].scope!.length === 1) {
        const old = oldConfigs.flatMap(c => c.options).find(o => o.label === s.payload.optionLabel)!;
        for (const ref of old.contentRefs) { const t = ir.content.find(c => c.id === ref)!; t.configurationScope = [{ dimension: c.dimension, option: o.id }]; o.contentRefs.push(ref); }
      }
    }
    configScopes.set(s.payload.optionLabel, scope);
    if (scope.length > 1) admittedVariants.push(scope);
  }
  if (admittedVariants.length && !resolutions.some(r => r.binding === "explicit_variants_only" && r.selectedRefs.length === source.items.filter(s => s.semanticKind === "configuration_option").length))
    addIssue("configuration_compatibility", source.items.filter(s => s.semanticKind === "configuration_option").map(s => s.localId), "Composite variants require explicit compatibility coordination");
  for (const c of ir.configurations) for (const o of c.options) {
    const variants = admittedVariants.filter(v => v.some(f => f.dimension === c.dimension && f.option === o.id));
    for (const other of ir.configurations.filter(x => x.dimension !== c.dimension)) {
      const implied = [...new Set(variants.map(v => v.find(f => f.dimension === other.dimension)?.option).filter((x): x is string => Boolean(x)))];
      if (variants.length && implied.length === 1 && variants.every(v => v.some(f => f.dimension === other.dimension)))
        c.compatibilityConstraints.push({ when: [{ dimension: c.dimension, option: o.id }], requires: [{ dimension: other.dimension, option: implied[0] }], sourceEvidence: o.sourceEvidence });
    }
  }
  const resolveScope = (r?: AssemblyResolution): Scope | null => r?.scope?.map(f => {
    const c = ir.configurations.find(c => c.dimension === f.dimension), o = c?.options.find(o => o.label === f.option);
    if (!o) throw new Error(`Unknown configuration facet ${JSON.stringify(f)}`);
    return { dimension: f.dimension, option: o.id };
  }) ?? null;
  const translateScope = (scope: ManualActivity["configurationScope"]) => scope?.flatMap(f => {
    const o = oldConfigs.find(c => c.dimension === f.dimension)?.options.find(o => o.id === f.option);
    return o ? configScopes.get(o.label) ?? [] : [];
  }) ?? null;

  const removed = new Set<string>();
  for (const s of source.items.filter(s => ["spoken_content", "stage_action", "media_cue"].includes(s.semanticKind)))
    for (const ref of base.contributions[s.localId] ?? []) if (ir.content.some(c => c.id === ref && c.kind !== "external")) removed.add(ref);
  ir.content = ir.content.filter(c => !removed.has(c.id) && !(c.configurationScope?.some(f => oldConfigs.some(o => o.dimension === f.dimension)) &&
    !ir.configurations.flatMap(c => c.options).some(o => o.contentRefs.includes(c.id))));
  for (const p of ir.phases) {
    p.activities = p.activities.filter(a => !["PERFORM", "DM_INTERVENE"].includes(a.kind));
    for (const a of p.activities) {
      a.configurationScope = translateScope(a.configurationScope);
      for (const s of source.items) if (base.contributions[s.localId]?.includes(a.id)) anchorActivities.set(s.localId, [a.id]);
    }
  }
  for (const c of ir.content) if (c.configurationScope?.some(f => oldConfigs.some(o => o.dimension === f.dimension)) &&
    !ir.configurations.flatMap(c => c.options).some(o => o.contentRefs.includes(c.id))) c.configurationScope = translateScope(c.configurationScope);

  const consumed = new Set<string>();
  for (const r of resolutions.filter(r => r.resolutionKind === "grouping")) {
    const members = r.ordering!.map(item), scoped = resolveScope(r);
    const p = phase(members[0]);
    if (!p || members.some(s => s.phaseHint && phase(s)?.id !== p.id)) { addIssue("activity_order", r.selectedRefs, "Grouping crossed phases"); continue; }
    const beats: z.infer<typeof PerformanceScriptSchema>["beats"] = [];
    const hydratedHeaders = new Set<string>();
    let intent: "question" | "explain" | null = null;
    for (const s of members) {
      consumed.add(s.localId);
      if (r.binding === "region_media_header") for (const blockId of s.sourceBlockIds) {
        if (hydratedHeaders.has(blockId)) continue;
        hydratedHeaders.add(blockId);
        const header = hydrateRegionMediaHeader(pack, blockId);
        if (header && !members.some(s => s.semanticKind === "media_cue" && s.sourceBlockIds.includes(blockId) && s.payload.label === header.label))
          beats.push({ id: id("header_beat", [r.selectedRefs, blockId]), order: beats.length, interactionRef: null,
            cues: [{ kind: "Media", mediaRef: text(header.label, [header.evidence]), operation: "play", timingRef: null }] });
      }
      const cues: z.infer<typeof PerformanceScriptSchema>["beats"][number]["cues"] = [];
      if (s.semanticKind === "spoken_content") {
        const hydrated = hydrateSpokenSource(s, pack);
        if (hydrated.issues.length) { addIssue("source_layout_ambiguity", [s.localId], hydrated.issues.map(i => i.message).join("; ")); continue; }
        if (s.payload.intentHint?.startsWith("host_")) intent = s.payload.intentHint === "host_question" ? "question" : "explain";
        for (const unit of [...hydrated.units].sort((a, b) => a.evidence.sourceSpan.start - b.evidence.sourceSpan.start)) beats.push({ id: id("beat", [r.selectedRefs, unit.evidence.sourceSpan, s.payload]), order: beats.length, interactionRef: null,
          cues: [{ kind: "Spoken", performerRef: actor(s.payload.speakerHint, s), personaRef: s.payload.personaHint ? actor(s.payload.personaHint, s) : null,
            targetRefs: [], textRef: text(unit.text, [unit.evidence]), fidelity: s.payload.fidelityHint as "fixed" | "reference" }] });
      } else if (s.semanticKind === "stage_action") cues.push({ kind: "Stage", performerRef: actor(s.payload.performerHint, s),
        targetRefs: (s.payload.targetHints ?? []).map(n => actor(n, s)), actionRef: text(s.payload.actionSummary, ev(s)), capabilityRef: s.payload.capabilityHint ?? "physical_stage" });
      else if (s.semanticKind === "media_cue") cues.push({ kind: "Media", mediaRef: text(s.payload.label, ev(s)), operation: s.payload.operation, timingRef: null });
      else if (s.semanticKind === "external_asset_reference" && ["audio", "video"].includes(s.payload.assetTypeHint)) {
        const external = ir.content.find(c => c.kind === "external" && (base.contributions[s.localId] ?? []).includes(c.id))!;
        cues.push({ kind: "Media", mediaRef: external.id, operation: "play", timingRef: null });
      } else addIssue("source_layout_ambiguity", [s.localId], "Non-cue fact in performance grouping");
      if (cues.length) beats.push({ id: id("beat", [r.selectedRefs, s.localId]), order: beats.length, cues, interactionRef: null });
    }
    if (!beats.length) continue;
    const e = evidence(r.sourceRefs), scriptRef = id("script", [r.selectedRefs, scoped]);
    ir.content.push({ id: scriptRef, kind: "performance", sourceEvidence: e, audience: pub, configurationScope: scoped, releaseConstraintRef: null, script: { beats } });
    const a: ManualActivity = intent ? { ...activityBase([r.selectedRefs, scoped], e, scoped), kind: "DM_INTERVENE", completion: "inputs_recorded",
      payload: { intent, scriptRef, targetSelector: { kind: "participants" }, interactionRef: null } }
      : { ...activityBase([r.selectedRefs, scoped], e, scoped), kind: "PERFORM", completion: "performance_finished", payload: { scriptRef, interactionRefs: [] } };
    emit(r.selectedRefs[0], a);
    for (const s of members.slice(1)) (contributions[s.localId] ??= []).push(a.id);
  }
  for (const s of source.items.filter(s => ["spoken_content", "stage_action", "media_cue"].includes(s.semanticKind)))
    if (!consumed.has(s.localId)) addIssue("activity_order", [s.localId], "Cue not covered by explicit region/order");

  // Conditional relations use event bindings, never guessed natural-language parsing.
  const oldInteractions = new Set(ir.policies.interactions.map(i => i.id));
  ir.policies.conditional = []; ir.policies.interactions = [];
  ir.policies.conditions = ir.policies.conditions.filter(c => c.kind !== "answer_submitted" || !oldInteractions.has(c.interactionRef));
  for (const s of source.items.filter(s => s.semanticKind === "conditional_guidance")) {
    if (s.semanticKind !== "conditional_guidance") continue;
    const rs = resolutions.filter(r => r.resolutionKind === "dispatch" && r.selectedRefs[0] === s.localId);
    if (rs.length !== 1) { addIssue("trigger_scope", [s.localId], "Conditional trigger binding unresolved"); continue; }
    const r = rs[0], p = phase(s), e = ev(s), policyRef = id("policy", s.localId);
    if (!p || !r.binding) { addIssue("trigger_scope", [s.localId], "Missing trigger phase/binding"); continue; }
    const trigger = condition(s.localId, e, { kind: "event_flag", eventKey: policyRef });
    const effectText = text(s.payload.contentSummary, e), anchor = r.selectedRefs.slice(1).find(ref => anchorActivities.has(ref));
    const point = r.selectedRefs.slice(1).flatMap(ref => base.contributions[ref] ?? []).find(ref => ir.policies.requiredPoints.some(p => p.id === ref)) ?? null;
    const activityRef = anchor ? anchorActivities.get(anchor)![0] : null;
    let effect: ManualActivityIR["policies"]["conditional"][number]["effect"];
    if (s.payload.effectKind === "deny_resource") {
      const resource = r.selectedRefs.map(item).find(x => x.semanticKind === "resource_rule" && x.payload.ruleKindHint === "catalogue");
      const resourceRef = resource && (base.contributions[resource.localId] ?? []).find(ref => ir.resources.some(x => x.id === ref));
      if (!resourceRef) { addIssue("resource_dispatch", [s.localId], "Deny policy has no resource binding"); continue; }
      effect = { kind: "deny_resource", resourceRef, contentRef: effectText };
    } else if (s.payload.effectKind === "question") {
      const interactionRef = id("interaction", s.localId), wait = id("answer", s.localId);
      if (s.payload.waitForAnswerHint) ir.policies.conditions.push({ id: wait, sourceEvidence: e, kind: "answer_submitted", interactionRef });
      ir.policies.interactions.push({ id: interactionRef, sourceEvidence: e, targetSelector: s.payload.targetHints?.length ? { kind: "roles", roleRefs: s.payload.targetHints.map(n => actor(n, s)) } : { kind: "participants" },
        responseMode: s.payload.waitForAnswerHint ? "free_answer" : "none", expectedInfoRefs: point ? [ir.policies.requiredPoints.find(p => p.id === point)!.meaningRef] : [], waitRuleRef: s.payload.waitForAnswerHint ? wait : null, fallbackRef: effectText });
      effect = { kind: "cue_question", interactionRef };
      if (r.binding === "optional_interaction" && activityRef) {
        const a = ir.phases.flatMap(p => p.activities).find(a => a.id === activityRef);
        if (a?.kind === "PERFORM") a.payload.interactionRefs.push(interactionRef);
      }
    } else if (s.payload.effectKind === "acknowledge" || s.payload.effectKind === "summarize") effect = { kind: s.payload.effectKind, contentRef: effectText };
    else { addIssue("trigger_scope", [s.localId], "Unsupported effect without authorization"); continue; }
    ir.policies.conditional.push({ id: policyRef, sourceEvidence: e, scope: { phaseRefs: [p.id], activityRefs: activityRef ? [activityRef] : [] }, conditionRef: trigger,
      triggerWhen: true, effect, priority: s.payload.strengthHint === "hard" ? 10 : 0, once: false, cooldownMs: 0 });
    triggers.push({ policyRef, sourceItemId: s.localId, kind: r.binding, activityRef, pointRef: point, configurationScope: resolveScope(r) });
  }

  for (const s of source.items.filter(s => s.semanticKind === "runtime_choice")) {
    if (s.semanticKind !== "runtime_choice") continue;
    const r = resolutions.find(r => r.binding === "public_choice_cycle" && r.selectedRefs[0] === s.localId), p = phase(s);
    const reader = resolutions.find(r => r.binding === "public_archive_reader" && r.selectedRefs.includes(s.localId));
    const gender = resolutions.find(r => r.binding === "relative_gender_dispatch" && r.selectedRefs.includes(s.localId));
    if (!r || !reader || !gender || !p) { addIssue("choice_dispatch", [s.localId], "Incomplete choice/reader/relative performer relation"); continue; }
    // Catalogue/asset joins are exact-label deterministic work, not a coordinator-produced answer graph.
    const selected = [...r.selectedRefs.map(item), ...source.items.filter(x => x.semanticKind === "resource_rule" && x.payload.ruleKindHint === "catalogue" && s.payload.optionLabels.includes(x.payload.resourceLabel) ||
      x.semanticKind === "external_asset_reference" && x.contextHint !== undefined && s.payload.optionLabels.includes(x.contextHint))];
    const catalogue = selected.filter(s => s.semanticKind === "resource_rule" && s.payload.ruleKindHint === "catalogue");
    const resources = catalogue.map(c => ir.resources.find(res => base.contributions[c.localId]?.includes(res.id))).filter((r): r is ManualActivityIR["resources"][number] => Boolean(r));
    if (resources.length !== s.payload.optionLabels.length || resources.some(res => !s.payload.optionLabels.includes((ir.content.find(c => c.id === res.labelRef) as Extract<ActivityContent, { kind: "text" }>).text))) {
      addIssue("choice_dispatch", [s.localId], "Choice menu and catalogue not bijective"); continue;
    }
    const e = evidence(r.sourceRefs), choiceRef = id("choice", s.localId), authRef = id("authorization", choiceRef), phaseCondition = id("phase_condition", choiceRef);
    ir.policies.conditions.push({ id: phaseCondition, kind: "current_phase", phaseRef: p.id, sourceEvidence: ev(s) });
    ir.policies.authorizations.push({ id: authRef, sourceEvidence: e, contentRefs: resources.map(r => r.contentBundleRef), resourceRefs: resources.map(r => r.id), audience: pub, conditionRef: phaseCondition });
    const open: ManualActivity = { ...activityBase([choiceRef, "open"], e, null, "choice_outcome"), kind: "RESOURCE_ACTION", completion: "resource_committed",
      payload: { operation: "open", resourceSelector: { kind: "choice", choiceRef }, recipientsSelector: { kind: "choice_reader", choiceRef }, authorizationRef: authRef, onceKey: id("open_once", choiceRef) } };
    p.activities.push(open);
    const choice: Extract<ManualActivity, { kind: "PLAYER_CHOICE" }> = { ...activityBase(choiceRef, ev(s)), id: choiceRef, kind: "PLAYER_CHOICE", completion: "inputs_recorded",
      payload: { inputMode: "single_option", chooserSelector: { kind: "roles", roleRefs: (s.payload.chooserHints ?? []).map(n => actor(n, s)) },
        optionsSource: { kind: "resources", resourceRefs: resources.map(r => r.id) }, eligibilityRef: phaseCondition, quota: s.payload.quotaHint ?? null, resultBinding: "opened_resource", outcomeRefs: [] } };
    emit(s.localId, choice); phaseQuotas[p.id] = s.payload.quotaHint ?? 0;
    const reading = reader.selectedRefs.map(item).find(s => s.semanticKind === "reading_instruction" && s.payload.modeHint === "public_archive");
    const relative = gender.selectedRefs.map(item).find(s => s.semanticKind === "resource_rule" && s.payload.ruleKindHint === "dispatch");
    const personaFact = selected.find(s => s.semanticKind === "identity_statement" && s.payload.relation === "persona");
    if (!reading || !relative || !personaFact || personaFact.semanticKind !== "identity_statement") { addIssue("persona_binding", [s.localId], "Reader/persona relation not grounded"); continue; }
    const persona = actor(personaFact.payload.subjectText, personaFact);
    for (const res of resources) {
      const catalogueItem = catalogue.find(c => base.contributions[c.localId]?.includes(res.id))!;
      if (catalogueItem.semanticKind !== "resource_rule") continue;
      const matching = selected.filter((x): x is Extract<SourceSemanticItem, { semanticKind: "external_asset_reference" }> => x.semanticKind === "external_asset_reference" && x.contextHint === catalogueItem.payload.resourceLabel);
      const archive = matching.find(x => x.payload.assetTypeHint === "archive"), script = matching.find(x => x.payload.assetTypeHint === "script");
      const external = (x?: SourceSemanticItem) => x && ir.content.find(c => c.kind === "external" && base.contributions[x.localId]?.includes(c.id));
      const archiveContent = external(archive), scriptContent = external(script);
      if (!archiveContent || !scriptContent) { addIssue("resource_dispatch", [catalogueItem.localId], "Missing explicitly associated archive/SOLO references"); continue; }
      const read: ManualActivity = { ...activityBase([res.id, "archive"], ev(reading), null, "choice_outcome"), kind: "READ", completion: "reading_confirmed",
        payload: { contentRef: archiveContent.id, readingMode: "public_read_aloud", readerSelector: { kind: "choice_reader", choiceRef }, confirmationsFrom: [] } };
      p.activities.push(read);
      const performers = [actor(`unresolved:commentary:${res.id}`, relative), actor(`unresolved:solo:${res.id}`, relative)];
      const refs: string[] = [];
      const segmentAssets = { commentary: "", solo: "" };
      for (const [segment, performer] of (["commentary", "solo"] as const).map((segment, i) => [segment, performers[i]] as const)) {
        // Two unresolved segment dependencies, not two plays of the whole combined attachment.
        const asset = ir.externalAssets.find(a => scriptContent.kind === "external" && a.id === scriptContent.assetRef)!;
        const segmentAsset = id("segment_asset", [asset.id, segment]), segmentContent = id("segment_content", segmentAsset);
        segmentAssets[segment] = segmentAsset;
        ir.externalAssets.push({ ...asset, id: segmentAsset, label: `${asset.label} [${segment}]`, status: "missing", verifiedHash: null });
        ir.content.push({ id: segmentContent, kind: "external", assetRef: segmentAsset, sourceEvidence: asset.sourceEvidence, audience: pub, configurationScope: null, releaseConstraintRef: null });
        const scriptRef = id("dispatch_script", [res.id, segment]);
        ir.content.push({ id: scriptRef, kind: "performance", sourceEvidence: ev(relative), audience: pub, configurationScope: null, releaseConstraintRef: null,
          script: { beats: [{ id: id("dispatch_beat", [res.id, segment]), order: 0, interactionRef: null,
            cues: [{ kind: "Spoken", performerRef: performer, personaRef: segment === "commentary" ? persona : (catalogueItem.payload.subjectHints ?? []).map(n => actor(n, catalogueItem))[0] ?? null,
              textRef: segmentContent, targetRefs: [], fidelity: "reference" }] }] } });
        const perf: ManualActivity = { ...activityBase([res.id, segment], ev(relative), null, "choice_outcome"), kind: "PERFORM", completion: "performance_finished", payload: { scriptRef, interactionRefs: [] } };
        p.activities.push(perf); refs.push(perf.id);
      }
      res.performerRefs = performers; res.personaRef = persona;
      choice.payload.outcomeRefs.push({ optionRef: res.id, activityRefs: [open.id, read.id, ...refs], contentBundleRef: res.contentBundleRef });
      dispatch.push({ resourceRef: res.id, commentaryRef: refs[0], soloRef: refs[1], relation: "commentary_opposite_solo_same", controllerStatus: "unresolved", segmentAssets });
    }
    const emphasis = resolutions.find(r => r.binding === "archive_emphasis" && r.selectedRefs.includes(s.localId));
    if (emphasis) {
      const fact = emphasis.selectedRefs.map(item).find(x => x.semanticKind === "resource_rule" && x.sourceBlockIds.some(b => pack.blocks.find(x => x.id === b)?.purpose === "archive_cross_reference"));
      if (fact?.semanticKind === "resource_rule") ir.policies.guidance.push({ id: id("emphasis", s.localId), sourceEvidence: ev(fact), kind: "best_practice", textRef: text(fact.payload.summary, ev(fact), internal),
        scope: { phaseRefs: [p.id], activityRefs: choice.payload.outcomeRefs.flatMap(o => o.activityRefs.slice(1, 2)) }, priority: 5, exceptions: [] });
    } else addIssue("resource_dispatch", [s.localId], "Selected archive emphasis not bound");
    addIssue("actor_binding", [relative.localId], "Relative gender relation retained; actual role genders and board/controller binding remain unverified", "runtime_blocker");
  }
  for (const r of resolutions.filter(r => r.binding === "phase_quota")) {
    const markers = r.selectedRefs.map(item).filter(s => s.semanticKind === "phase_marker" && s.payload.markerKind === "reference");
    if (markers.length !== 1 || !r.quota) throw new Error("Quota resolution must identify one phase");
    const m = markers[0]; if (m.semanticKind === "phase_marker") {
      const p = ir.phases.find(p => p.sourceLabel === m.payload.sourceLabel); if (p) phaseQuotas[p.id] = r.quota;
    }
  }

  for (const r of resolutions.filter(r => r.binding === "identity_belief")) {
    const selected = r.selectedRefs.map(item), truth = selected.find(s => s.semanticKind === "identity_statement" && s.payload.relation === "canonical_truth"), belief = selected.find(s => s.semanticKind === "identity_statement" && s.payload.relation === "belief"), disclosure = selected.find(s => s.semanticKind === "disclosure_rule");
    if (!truth || truth.semanticKind !== "identity_statement" || !belief || belief.semanticKind !== "identity_statement" || !disclosure) continue;
    const release = condition([truth.localId, "deny_default"], ev(disclosure), { kind: "event_flag", eventKey: id("unproven_authorization", disclosure.localId) });
    const canonicalTruthRef = text(`${truth.payload.subjectText}: ${truth.payload.objectText}`, ev(truth), internal, release), beliefRef = text(`${belief.payload.subjectText}: ${belief.payload.objectText}`, ev(belief), internal);
    ir.identities.push({ id: id("identity", truth.localId), sourceEvidence: evidence(r.sourceRefs), subjectRef: actor(truth.payload.subjectText, truth), canonicalTruthRef, beliefRef, releaseConstraintRef: release });
  }
  // A not-before boundary never grants public authorization, including at the named future phase.
  for (const s of source.items.filter(s => s.semanticKind === "disclosure_rule")) {
    if (s.semanticKind !== "disclosure_rule") continue;
    const protectedRefs = base.contributions[s.localId] ?? [];
    for (const c of ir.content.filter(c => protectedRefs.includes(c.id) && c.releaseConstraintRef)) {
      const old = ir.policies.conditions.find(x => x.id === c.releaseConstraintRef)!;
      if (old.kind !== "semantic") ir.policies.conditions.splice(ir.policies.conditions.indexOf(old), 1, { id: old.id, sourceEvidence: ev(s), kind: "semantic",
        textRef: text(`Public authorization unresolved; not before ${s.payload.notBeforeHint}`, ev(s), internal), operationalStatus: "unresolved" });
    }
    addIssue("authorization_binding", [s.localId], "Not-before is not positive authorization; protected facts remain DM-only", "runtime_blocker");
  }

  for (const p of ir.phases) {
    const orders = resolutions.filter(r => r.resolutionKind === "ordering" && input.issues.find(i => i.id === r.issueId)?.kind === "activity_order" && r.selectedRefs.some(ref => phase(item(ref))?.id === p.id));
    const sequence = p.activities.filter(a => a.activation === "sequence");
    if (!sequence.length) continue;
    if (orders.length !== 1) { addIssue("activity_order", source.items.filter(s => phase(s)?.id === p.id).map(s => s.localId), "Exactly one exhaustive phase order required"); continue; }
    const orderedIds = orders[0].ordering!.flatMap(ref => anchorActivities.get(ref) ?? []);
    if (new Set(orderedIds).size !== orderedIds.length || sequence.some(a => !orderedIds.includes(a.id)) || orderedIds.some(ref => !sequence.some(a => a.id === ref))) {
      addIssue("activity_order", orders[0].selectedRefs, "Phase order does not cover each sequence activity exactly once"); continue;
    }
    p.activities = [...orderedIds.map(ref => sequence.find(a => a.id === ref)!), ...p.activities.filter(a => a.activation !== "sequence")];
    p.activities.forEach((a, order) => { a.order = order; });
  }
  for (const r of resolutions.filter(r => r.resolutionKind === "keep_unresolved")) {
    const issue = input.issues.find(i => i.id === r.issueId)!;
    issues.push({ ...issue, reason: r.unresolvedReason! });
  }
  for (const p of ir.phases) for (const a of p.activities) if (a.kind === "DISCUSS" && ir.policies.requiredPoints.some(point => point.timing.firstApplicablePhase === p.id && point.onMissing === "cue"))
    ir.policies.discussion.find(policy => policy.id === a.payload.discussionPolicyRef)!.dmParticipation = "prompt_missing";
  const candidate = ManualActivityIRSchema.parse(ir), validation = validateManualActivityIR(candidate, pack.corpus);
  for (const error of validation.errors) issues.push({ id: id("validation", error), kind: "source_layout_ambiguity", sourceRefs: [], relatedSemanticItemIds: [], reason: `${error.code}:${error.path}:${error.message}`, requiredResolution: "Fix assembly without weakening validator", severity: "assembly_blocker" });
  return { candidate, validation, issues, contributions, triggers, dispatch, admittedVariants, phaseQuotas,
    assemblyStatus: issues.some(i => i.severity === "assembly_blocker") ? "incomplete" as const : "complete" as const,
    runtimeStatus: "not_evaluated" as const, prototypeOnly: true as const, sourceFingerprint: pack.sourceFingerprint };
}
