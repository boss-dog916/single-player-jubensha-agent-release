import type { ManualActivity, ManualActivityIR } from "@/src/lib/schemas/manualActivityIRSchema";
import type { AssemblyResult } from "./manualActivityAssembly";
import { commitResourceChoice, emptyChoiceState, type ChoiceRequest, type ChoiceState, type ObservationContext } from "./manualActivityState";
import { assembleActivityContent, configScopeMatches, projectManualActivities, type ProjectedActivityPlan } from "./manualActivityProjection";
import { activityTextHash, contentClosure, activityDisplayContentRefs, type SourceCorpus } from "./manualActivityValidation";

export function projectAssembly(result: AssemblyResult, config: Record<string, string>, capabilities: string[], corpus: SourceCorpus) {
  const plan = projectManualActivities(result.candidate, config, capabilities, corpus);
  const dimensions = [...new Set(result.admittedVariants.flatMap(v => v.map(f => f.dimension)))];
  if (dimensions.length && !result.admittedVariants.some(v => dimensions.every(d => v.find(f => f.dimension === d)?.option === config[d]))) {
    plan.validation.errors.push({ code: "UNPROVEN_CONFIG_COMBINATION", path: "config", message: "Not one of the source-proven variants" });
    plan.phases = []; plan.content = [];
  }
  for (const binding of result.dispatch) plan.blockedCapabilities.push({ code: "CAST_BINDING_UNVERIFIED", path: binding.resourceRef, message: "Relative gender relation known, concrete controllers unresolved" });
  for (const issue of result.issues.filter(i => i.severity === "assembly_blocker")) plan.validation.errors.push({ code: "ASSEMBLY_INCOMPLETE", path: issue.id, message: issue.reason });
  plan.validation.status = plan.validation.errors.length || plan.blockedCapabilities.length ? "blocked" : "ready";
  return plan;
}

export type TriggerObservations = ObservationContext & { completedActivityIds: string[]; justCompletedActivityIds: string[];
  semanticPredicates: Record<string, boolean | null>; firedPolicyIds: string[] };
export function assemblyTriggeredPolicies(result: AssemblyResult, state: TriggerObservations) {
  return result.triggers.flatMap(t => {
    const p = result.candidate.policies.conditional.find(p => p.id === t.policyRef)!;
    if (!p.scope.phaseRefs.includes(state.phaseRef) || !configScopeMatches(t.configurationScope, state.selectedConfig) || p.once && state.firedPolicyIds.includes(p.id)) return [];
    const just = t.activityRef !== null && state.justCompletedActivityIds.includes(t.activityRef);
    const completed = t.activityRef !== null && state.completedActivityIds.includes(t.activityRef);
    let match: boolean | null = null;
    if (t.kind === "point_missing_after_entry") match = just && t.pointRef !== null && !state.observedPointIds.includes(t.pointRef);
    else if (t.kind === "entry_repeat") match = just; // Previous public observation must NOT suppress this entry event.
    else if (t.kind === "semantic_predicate") match = completed ? state.semanticPredicates[t.sourceItemId] ?? null : false;
    else if (t.kind === "optional_interaction") match = just ? state.semanticPredicates[t.sourceItemId] ?? null : false;
    else if (t.kind === "deny_before_phase" && p.effect.kind === "deny_resource") match = !result.candidate.resources.find(r => p.effect.kind === "deny_resource" && r.id === p.effect.resourceRef)!.eligiblePhaseRefs.includes(state.phaseRef) && state.semanticPredicates[t.sourceItemId] === true;
    return match === p.triggerWhen ? [p] : [];
  });
}

export type PrototypeChoiceState = ChoiceState & { currentPhaseRef: string; phaseQuotaUsed: Record<string, number>; committedChoiceIds: string[]; readerByRequest: Record<string, string> };
export const emptyAssemblyChoiceState = (phaseRef: string): PrototypeChoiceState => ({ ...emptyChoiceState(), currentPhaseRef: phaseRef, phaseQuotaUsed: {}, committedChoiceIds: [], readerByRequest: {} });
export function enterAssemblyPhase(result: AssemblyResult, state: PrototypeChoiceState, phaseRef: string) {
  const current = result.candidate.phases.find(p => p.id === state.currentPhaseRef), next = result.candidate.phases.find(p => p.id === phaseRef);
  if (!next || !current || next.order < current.order) throw new Error("Invalid phase advance");
  return { ...state, currentPhaseRef: phaseRef }; // Per-phase quota starts at zero; opened set and receipts persist.
}

// Reusable choice template for quota tests across referenced phases, NOT a full future-act parser.
export function instantiateChoiceTemplate(result: AssemblyResult, phaseRef: string): ManualActivityIR {
  const ir = structuredClone(result.candidate), phase = ir.phases.find(p => p.id === phaseRef);
  if (!phase) throw new Error("Unknown phase");
  if (phase.activities.some(a => a.kind === "PLAYER_CHOICE")) return ir;
  const original = ir.phases.flatMap(p => p.activities).find((a): a is Extract<ManualActivity, { kind: "PLAYER_CHOICE" }> => a.kind === "PLAYER_CHOICE");
  if (!original || !result.phaseQuotas[phaseRef]) throw new Error("No source-grounded repeat choice quota");
  const oldPhase = ir.phases.find(p => p.activities.includes(original))!, refs = [original.id, ...new Set(original.payload.outcomeRefs.flatMap(o => o.activityRefs))];
  const remap = (ref: string) => `repeat_${activityTextHash(`${phaseRef}:${ref}`).slice(0, 24)}`;
  const c = structuredClone(original); c.id = remap(c.id); c.payload.quota = result.phaseQuotas[phaseRef];
  const conditionRef = remap(original.payload.eligibilityRef);
  ir.policies.conditions.push({ id: conditionRef, kind: "current_phase", phaseRef, sourceEvidence: original.sourceEvidence });
  c.payload.eligibilityRef = conditionRef;
  c.payload.outcomeRefs = c.payload.outcomeRefs.map(o => ({ ...o, activityRefs: o.activityRefs.map(remap) }));
  phase.activities.push(c);
  for (const ref of refs.filter(ref => ref !== original.id)) {
    const a = structuredClone(oldPhase.activities.find(a => a.id === ref)!); a.id = remap(a.id);
    if (a.kind === "RESOURCE_ACTION") {
      a.payload.resourceSelector = { kind: "choice", choiceRef: c.id }; a.payload.recipientsSelector = { kind: "choice_reader", choiceRef: c.id }; a.payload.onceKey = remap(a.payload.onceKey);
      const auth = structuredClone(ir.policies.authorizations.find(auth => auth.id === a.payload.authorizationRef)!);
      auth.id = remap(auth.id); auth.conditionRef = conditionRef; ir.policies.authorizations.push(auth); a.payload.authorizationRef = auth.id;
    }
    if (a.kind === "READ") a.payload.readerSelector = { kind: "choice_reader", choiceRef: c.id };
    phase.activities.push(a);
  }
  return ir;
}

export function commitAssemblyChoice(result: AssemblyResult, state: PrototypeChoiceState, request: ChoiceRequest & { readerRef: string }) {
  const reject = (reason: string) => ({ accepted: false, duplicate: false, reason, state, activityRefs: [] as string[] });
  if (request.phaseRef !== state.currentPhaseRef) return reject("stale_phase");
  if (!result.candidate.phases.some(p => p.id === request.phaseRef) || !result.phaseQuotas[request.phaseRef]) return reject("choice_unavailable");
  const ir = instantiateChoiceTemplate(result, request.phaseRef);
  const choice = ir.phases.find(p => p.id === request.phaseRef)?.activities.find(a => a.id === request.choiceRef && a.kind === "PLAYER_CHOICE");
  const role = ir.actors.find(a => a.id === request.readerRef);
  if (!role?.storyRole || choice?.kind !== "PLAYER_CHOICE" || choice.payload.chooserSelector.kind === "roles" && !choice.payload.chooserSelector.roleRefs.includes(request.readerRef)) return reject("reader_not_player_role");
  if (Object.hasOwn(state.readerByRequest, request.requestId) && state.readerByRequest[request.requestId] !== request.readerRef) return reject("idempotency_reader_conflict");
  const used = Object.values(state.receipts).filter(r => r.phaseRef === request.phaseRef).length;
  if ((state.phaseQuotaUsed[request.phaseRef] ?? 0) !== used || state.committedChoiceIds.length !== Object.keys(state.receipts).length || new Set(state.committedChoiceIds).size !== state.committedChoiceIds.length || state.committedChoiceIds.some(id => !Object.hasOwn(state.receipts, id))) return reject("inconsistent_choice_state");
  if (!Object.hasOwn(state.receipts, request.requestId) && choice?.kind === "PLAYER_CHOICE" && used >= (choice.payload.quota ?? 0)) return reject("quota_exhausted");
  const committed = commitResourceChoice(ir, state, request);
  if (!committed.accepted || committed.duplicate) return { ...committed, state };
  return { ...committed, state: { ...state, ...committed.state, phaseQuotaUsed: { ...state.phaseQuotaUsed, [request.phaseRef]: used + 1 },
    committedChoiceIds: [...state.committedChoiceIds, request.requestId], readerByRequest: { ...state.readerByRequest, [request.requestId]: request.readerRef } } };
}

export function eligibleAssemblyResources(result: AssemblyResult, state: PrototypeChoiceState) {
  if (!result.phaseQuotas[state.currentPhaseRef]) return [];
  const ir = instantiateChoiceTemplate(result, state.currentPhaseRef), choice = ir.phases.find(p => p.id === state.currentPhaseRef)!.activities.find(a => a.kind === "PLAYER_CHOICE");
  if (choice?.kind !== "PLAYER_CHOICE" || choice.payload.optionsSource.kind !== "resources") return [];
  const used = Object.values(state.receipts).filter(r => r.phaseRef === state.currentPhaseRef).length;
  if (used !== (state.phaseQuotaUsed[state.currentPhaseRef] ?? 0) || used >= (choice.payload.quota ?? 0)) return [];
  return ir.resources.filter(r => choice.payload.optionsSource.kind === "resources" && choice.payload.optionsSource.resourceRefs.includes(r.id) && r.eligiblePhaseRefs.includes(state.currentPhaseRef) && !state.openedResourceIds.includes(r.id));
}

export function choiceContentAuthorized(ir: ManualActivityIR, state: PrototypeChoiceState, phaseRef: string, activityRef: string) {
  if (phaseRef !== state.currentPhaseRef) return false;
  const receipts = Object.entries(state.receipts).filter(([, r]) => r.phaseRef === phaseRef), phase = ir.phases.find(p => p.id === phaseRef);
  if (!phase || (state.phaseQuotaUsed[phaseRef] ?? 0) !== receipts.length || state.committedChoiceIds.length !== Object.keys(state.receipts).length || new Set(state.committedChoiceIds).size !== state.committedChoiceIds.length) return false;
  return receipts.some(([requestId, r]) => {
    const choice = phase.activities.find(a => a.kind === "PLAYER_CHOICE" && a.id === r.choiceRef), resource = ir.resources.find(res => res.id === r.resourceRef);
    if (choice?.kind !== "PLAYER_CHOICE" || !resource || !resource.eligiblePhaseRefs.includes(phaseRef) || !state.openedResourceIds.includes(resource.id) || !state.committedChoiceIds.includes(requestId) || !ir.actors.some(a => a.id === state.readerByRequest[requestId] && a.storyRole)) return false;
    if (choice.payload.chooserSelector.kind === "roles" && !choice.payload.chooserSelector.roleRefs.includes(state.readerByRequest[requestId])) return false;
    const outcome = choice.payload.outcomeRefs.find(o => o.optionRef === resource.id), open = phase.activities.find(a => a.id === outcome?.activityRefs[0]);
    const auth = open?.kind === "RESOURCE_ACTION" && ir.policies.authorizations.find(a => a.id === open.payload.authorizationRef);
    return Boolean(outcome && receipts.length <= (choice.payload.quota ?? 0) && choice.payload.optionsSource.kind === "resources" && choice.payload.optionsSource.resourceRefs.includes(resource.id) &&
      auth && auth.audience.kind === "public" && auth.resourceRefs.includes(resource.id) && auth.contentRefs.includes(resource.contentBundleRef) &&
      ir.policies.conditions.some(c => c.id === auth.conditionRef && c.kind === "current_phase" && c.phaseRef === phaseRef) &&
      r.contentBundleRef === resource.contentBundleRef && JSON.stringify(r.activityRefs) === JSON.stringify(outcome.activityRefs) && outcome.activityRefs.includes(activityRef));
  });
}

export function assembleCommittedChoiceContent(ir: ManualActivityIR, plan: ProjectedActivityPlan, state: PrototypeChoiceState, phaseRef: string, activityRef: string) {
  if (!choiceContentAuthorized(ir, state, phaseRef, activityRef)) return [];
  const a = ir.phases.find(p => p.id === phaseRef)!.activities.find(a => a.id === activityRef)!;
  if (contentClosure(ir, activityDisplayContentRefs(a)).some(c => c.kind === "external" && ir.externalAssets.find(asset => asset.id === c.assetRef)?.status !== "available")) return [];
  return assembleActivityContent(ir, plan, { phaseRef, activityRef, audience: { kind: "public" }, purpose: "public_context", choiceState: state });
}
