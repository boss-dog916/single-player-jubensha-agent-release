import type { ManualActivityIR, ManualActivity, Audience, ActivityContent } from "@/src/lib/schemas/manualActivityIRSchema";
import { validateManualActivityIR, activityDisplayContentRefs, contentClosure, contentAuthorized, type ActivityIssue, type SourceCorpus, type ActivitySemanticValidation } from "./manualActivityValidation";
import type { ChoiceState } from "./manualActivityState";

export type ProjectedActivityPlan = {
  format: "manual_activity_projection_v1"; prototypeOnly: true;
  phases: ManualActivityIR["phases"]; content: ActivityContent[]; resolvedConfig: Record<string, string>;
  unresolvedRuntimeChoices: string[]; blockedCapabilities: ActivityIssue[]; warnings: ActivityIssue[];
  semanticValidation: ActivitySemanticValidation;
  validation: { layer: "runtime_projection"; status: "ready" | "blocked"; errors: ActivityIssue[] };
};
export function configScopeMatches(scope: ManualActivity["configurationScope"], config: Record<string, string>) {
  return !scope || scope.every(s => config[s.dimension] === s.option);
}

// A pure prototype, not a publisher or a GameSession/DMFlow adapter.
export function projectManualActivities(ir: ManualActivityIR, selectedConfig: Record<string, string>, runtimeCapabilities: string[], corpus: SourceCorpus): ProjectedActivityPlan {
  const semantic = validateManualActivityIR(ir, corpus), errors: ActivityIssue[] = [], blockedCapabilities: ActivityIssue[] = [], warnings = [...semantic.warnings];
  const fail = (code: string, path: string, message = code) => errors.push({ code, path, message });
  const block = (code: string, path: string, message = code) => blockedCapabilities.push({ code, path, message });
  if (semantic.status === "invalid") fail("SEMANTIC_VALIDATION_REQUIRED", "semanticValidation", "Inspect the separate semantic report; no projection is produced");
  for (const [dimension, option] of Object.entries(selectedConfig)) if (!ir.configurations.some(c => c.dimension === dimension && c.options.some(o => o.id === option))) fail("INVALID_CONFIG_SELECTION", dimension);
  for (const config of ir.configurations) {
    if (config.selectionRequired && !selectedConfig[config.dimension]) fail("MISSING_CONFIG_SELECTION", config.dimension);
    const option = config.options.find(o => o.id === selectedConfig[config.dimension]);
    for (const binding of option?.actorBindings ?? []) if (binding.resolution !== "verified") block("CAST_BINDING_UNVERIFIED", config.dimension);
    for (const capability of option?.capabilityConstraints ?? []) if (!runtimeCapabilities.includes(capability)) block("CONFIG_CAPABILITY", config.dimension, capability);
    for (const rule of config.compatibilityConstraints) if (configScopeMatches(rule.when, selectedConfig) && !configScopeMatches(rule.requires, selectedConfig)) fail("INCOMPATIBLE_CONFIG", config.dimension);
  }
  const phases = semantic.status === "invalid" || errors.length ? [] : ir.phases.map(p => ({ ...p, activities: p.activities.filter(a => configScopeMatches(a.configurationScope, selectedConfig)) }));
  const selected = phases.flatMap(p => p.activities), selectedIds = new Set(selected.map(a => a.id));
  const selectedContent = ir.content.filter(c => configScopeMatches(c.configurationScope, selectedConfig));
  const accessibleIR = { ...ir, content: selectedContent };
  const referenced = new Set<string>();
  const onceKeys = new Set<string>();
  for (const config of ir.configurations) for (const ref of config.options.find(o => o.id === selectedConfig[config.dimension])?.contentRefs ?? []) referenced.add(ref);
  const unresolved = (ref: string, seen = new Set<string>()): boolean => {
    if (seen.has(ref)) return true;
    const c = ir.policies.conditions.find(c => c.id === ref);
    return !c || c.kind === "semantic" || ((c.kind === "all" || c.kind === "any") && c.conditionRefs.some(r => unresolved(r, new Set(seen).add(ref))));
  };
  for (const a of selected) {
    if (a.kind === "RESOURCE_ACTION") {
      if (onceKeys.has(a.payload.onceKey)) fail("DUPLICATE_ONCE_KEY", a.id);
      onceKeys.add(a.payload.onceKey);
    }
    if (!runtimeCapabilities.includes(a.kind)) block("UNSUPPORTED_ACTIVITY", a.id, a.kind);
    if (a.entryCondition && unresolved(a.entryCondition)) block("UNRESOLVED_ENTRY", a.id);
    for (const ref of activityDisplayContentRefs(a)) referenced.add(ref);
    if (a.kind === "PRIVATE_INTERACTION") block("PRIVATE_RUNTIME_NOT_IMPLEMENTED", a.id, "Preserved only; no session/access-control service is connected");
    if (a.kind === "PLAYER_CHOICE") for (const outcome of a.payload.outcomeRefs) {
      if (outcome.activityRefs.some(r => !selectedIds.has(r))) fail("CHOICE_OUTCOME_FILTERED", a.id);
      if (outcome.contentBundleRef) referenced.add(outcome.contentBundleRef);
    }
  }
  const content = contentClosure(accessibleIR, [...referenced]);
  for (const ref of referenced) if (!selectedContent.some(c => c.id === ref)) fail("CONFIG_CONTENT_FILTERED", ref);
  for (const c of content) {
    if (c.kind === "bundle") for (const ref of c.contentRefs) if (!selectedContent.some(c => c.id === ref)) fail("CONFIG_CONTENT_FILTERED", c.id, ref);
    if (c.kind === "external") {
      const asset = ir.externalAssets.find(a => a.id === c.assetRef)!;
      if (asset.status !== "available") block(asset.required ? "REQUIRED_ASSET_MISSING" : "PRESERVED_NOT_EXECUTABLE", c.id, asset.label);
      else if (!runtimeCapabilities.includes(asset.capabilityRef)) block("PRESERVED_NOT_EXECUTABLE", c.id, asset.capabilityRef);
    }
    if (c.kind === "performance") for (const beat of c.script.beats) for (const cue of beat.cues) {
      if (cue.kind === "Stage" && !runtimeCapabilities.includes(cue.capabilityRef)) block("PRESERVED_NOT_EXECUTABLE", c.id, cue.capabilityRef);
      if (cue.kind === "Media" && !runtimeCapabilities.includes("media")) block("PRESERVED_NOT_EXECUTABLE", c.id, "media");
      const refs = cue.kind === "Spoken" ? [cue.textRef] : cue.kind === "Stage" ? [cue.actionRef] : [cue.mediaRef];
      if (refs.some(ref => !selectedContent.some(c => c.id === ref))) fail("CONFIG_CONTENT_FILTERED", c.id);
    }
  }
  for (const phase of phases) {
    if (!phase.activities.length) block("REFERENCE_ONLY_PHASE", phase.id, "Phase referenced by the excerpt; full phase is not included");
    const sequence = phase.activities.filter(a => a.activation === "sequence");
    const entries = sequence.filter(a => a.kind === "READ" && a.payload.readingMode === "individual_private");
    if (entries.length > 1) fail("DUPLICATE_PHASE_ENTRY", phase.id);
    const transitions = sequence.filter(a => a.kind === "TRANSITION");
    if (transitions.length > 1 || transitions.some(a => a !== sequence.at(-1))) fail("TRANSITION_SEQUENCE", phase.id);
    for (const transition of transitions) if (transition.kind === "TRANSITION" && transition.payload.targetPhaseRef) {
      const target = phases.find(p => p.id === transition.payload.targetPhaseRef);
      if (!target || target.order <= phase.order) fail("UNREACHABLE_TRANSITION", transition.id);
    }
    for (const a of phase.activities.filter(a => a.activation !== "sequence")) {
      const reached = selected.some(parent => parent.kind === "PLAYER_CHOICE" && parent.payload.outcomeRefs.some(o => o.activityRefs.includes(a.id))) ||
        ir.policies.conditional.some(p => p.effect.kind === "private_support" && p.effect.activityRef === a.id);
      if (!reached) fail("UNREACHABLE_DISPATCH", a.id);
    }
  }
  return { format: "manual_activity_projection_v1", prototypeOnly: true, phases, content, resolvedConfig: { ...selectedConfig },
    unresolvedRuntimeChoices: selected.filter(a => a.kind === "PLAYER_CHOICE").map(a => a.id), blockedCapabilities, warnings, semanticValidation: semantic,
    validation: { layer: "runtime_projection", status: errors.length || blockedCapabilities.length ? "blocked" : "ready", errors } };
}

export type AssemblyPurpose = "public_context" | "storyboard" | "ai_context" | "export";
// Administrative projection is NOT a public DTO. Every consumer must assemble a scoped view.
type ScopedContent<T = ActivityContent> = T extends ActivityContent ? Omit<T, "sourceEvidence"> : never;
export function assembleActivityContent(ir: ManualActivityIR, plan: ProjectedActivityPlan, input: { activityRef: string; phaseRef: string; audience: Audience; purpose: AssemblyPurpose; choiceState?: ChoiceState }): ScopedContent[] {
  const phase = plan.phases.find(p => p.id === input.phaseRef), activity = phase?.activities.find(a => a.id === input.activityRef);
  if (!activity || plan.validation.errors.length || (input.purpose === "public_context" || input.purpose === "storyboard") && input.audience.kind !== "public") return [];
  if (activity.activation === "choice_outcome" && !Object.values(input.choiceState?.receipts ?? {}).some(receipt => receipt.phaseRef === input.phaseRef && receipt.activityRefs.includes(activity.id) &&
    input.choiceState!.openedResourceIds.includes(receipt.resourceRef) && ir.resources.find(r => r.id === receipt.resourceRef)?.eligiblePhaseRefs.includes(input.phaseRef))) return [];
  const owner = activity.audience;
  if (owner.kind !== "public" && (owner.kind === "dm_only" ? input.audience.kind !== "dm_only" :
    input.audience.kind !== "selected_roles" || input.audience.roleRefs.some(r => !owner.roleRefs.includes(r)))) return [];
  const scoped = { ...ir, content: plan.content };
  const closure = contentClosure(scoped, activityDisplayContentRefs(activity));
  if (closure.some(c => !contentAuthorized(ir, c, input.audience, input.phaseRef))) return [];
  // A whole-page evidence quote can contain secrets even when the cited line is public.
  return closure.map(({ sourceEvidence: _evidence, ...content }) => content);
}
