import type { ManualActivityIR, ManualActivity } from "@/src/lib/schemas/manualActivityIRSchema";

export type ObservationContext = {
  phaseRef: string; selectedConfig: Record<string, string>; openedResourceIds: string[];
  answeredInteractionIds: string[]; observedPointIds: string[]; discussionCheckpoints: string[]; eventFlags: string[];
};
export const emptyObservations = (phaseRef: string): ObservationContext => ({ phaseRef, selectedConfig: {}, openedResourceIds: [],
  answeredInteractionIds: [], observedPointIds: [], discussionCheckpoints: [], eventFlags: [] });

// Three-valued evaluation: an unresolved semantic condition never silently authorizes a release.
export function evaluateActivityCondition(ir: ManualActivityIR, ref: string, state: ObservationContext, seen = new Set<string>()): boolean | null {
  if (seen.has(ref)) return null;
  const c = ir.policies.conditions.find(c => c.id === ref);
  if (!c) return null;
  const next = new Set(seen).add(ref);
  switch (c.kind) {
    case "config_selected": return state.selectedConfig[c.dimension] === undefined ? null : state.selectedConfig[c.dimension] === c.option;
    case "current_phase": return state.phaseRef === c.phaseRef;
    case "resource_eligible": return ir.resources.find(r => r.id === c.resourceRef)?.eligiblePhaseRefs.includes(state.phaseRef) === true && !state.openedResourceIds.includes(c.resourceRef);
    case "resource_opened": return state.openedResourceIds.includes(c.resourceRef);
    case "answer_submitted": return state.answeredInteractionIds.includes(c.interactionRef);
    case "point_observed": return state.observedPointIds.includes(c.pointRef);
    case "discussion_checkpoint": return state.discussionCheckpoints.includes(c.activityRef);
    case "event_flag": return state.eventFlags.includes(c.eventKey);
    case "semantic": return null;
    case "all": case "any": {
      const values = c.conditionRefs.map(r => evaluateActivityCondition(ir, r, state, next));
      return c.kind === "all" ? values.includes(false) ? false : values.includes(null) ? null : true
        : values.includes(true) ? true : values.includes(null) ? null : false;
    }
  }
}

export function missingPointDisposition(ir: ManualActivityIR, pointId: string, state: ObservationContext) {
  const point = ir.policies.requiredPoints.find(p => p.id === pointId);
  if (!point) throw new Error("Unknown point");
  const order = (ref: string) => ir.phases.find(p => p.id === ref)!.order;
  const applicable = order(state.phaseRef) >= order(point.timing.firstApplicablePhase);
  const observed = state.observedPointIds.includes(pointId);
  const deferred = applicable && !observed && point.onMissing === "defer" && point.timing.duePhase !== null && order(state.phaseRef) < order(point.timing.duePhase);
  return { status: !applicable ? "not_applicable" : observed ? "observed" : deferred ? "deferred" : "unobserved",
    blocks: applicable && !observed && !deferred && point.importance === "hard",
    action: observed || !applicable ? null : deferred ? "defer" : point.onMissing === "defer" ? "cue" : point.onMissing };
}

export function triggeredActivityPolicies(ir: ManualActivityIR, state: ObservationContext) {
  return ir.policies.conditional.filter(p => (!p.scope.phaseRefs.length || p.scope.phaseRefs.includes(state.phaseRef)) &&
    evaluateActivityCondition(ir, p.conditionRef, state) === p.triggerWhen);
}

export type ChoiceState = {
  openedResourceIds: string[];
  receipts: Record<string, { phaseRef: string; choiceRef: string; resourceRef: string; activityRefs: string[]; contentBundleRef: string | null }>;
};
export const emptyChoiceState = (): ChoiceState => ({ openedResourceIds: [], receipts: {} });
export type ChoiceRequest = { phaseRef: string; choiceRef: string; resourceRef: string; requestId: string };

// Offline reducer only: returns a new state and dispatch intent, never executes an activity or writes a DB.
export function commitResourceChoice(ir: ManualActivityIR, state: ChoiceState, input: ChoiceRequest) {
  const reject = (reason: string) => ({ accepted: false, duplicate: false, reason, state, activityRefs: [] as string[], contentBundleRef: null as string | null, quotaExhausted: false });
  const receipt = Object.hasOwn(state.receipts, input.requestId) ? state.receipts[input.requestId] : null;
  const phase = ir.phases.find(p => p.id === input.phaseRef);
  const choice = phase?.activities.find((a): a is Extract<ManualActivity, { kind: "PLAYER_CHOICE" }> => a.id === input.choiceRef && a.kind === "PLAYER_CHOICE");
  const used = Object.values(state.receipts).filter(r => r.phaseRef === input.phaseRef && r.choiceRef === input.choiceRef).length;
  if (receipt) {
    if (receipt.phaseRef !== input.phaseRef || receipt.choiceRef !== input.choiceRef || receipt.resourceRef !== input.resourceRef) return reject("idempotency_conflict");
    return { accepted: true, duplicate: true, reason: "already_committed", state, activityRefs: [] as string[], contentBundleRef: receipt.contentBundleRef, quotaExhausted: used >= (choice?.payload.quota ?? 0) };
  }
  if (!choice || choice.payload.resultBinding !== "opened_resource" || choice.payload.optionsSource.kind !== "resources") return reject("unsupported_choice");
  if (!input.requestId) return reject("missing_request_id");
  const resource = ir.resources.find(r => r.id === input.resourceRef);
  if (!choice.payload.optionsSource.resourceRefs.includes(input.resourceRef) || !resource?.eligiblePhaseRefs.includes(input.phaseRef)) return reject("ineligible_resource");
  if (used >= (choice.payload.quota ?? 0)) return reject("quota_exhausted");
  if (state.openedResourceIds.includes(input.resourceRef)) return reject("already_opened");
  const observations = { ...emptyObservations(input.phaseRef), openedResourceIds: state.openedResourceIds };
  if (evaluateActivityCondition(ir, choice.payload.eligibilityRef, observations) !== true) return reject("eligibility_not_proven");
  const outcome = choice.payload.outcomeRefs.find(o => o.optionRef === input.resourceRef);
  if (!outcome || !outcome.activityRefs.length) return reject("unresolved_outcome");
  if (choice.configurationScope?.length || choice.entryCondition && evaluateActivityCondition(ir, choice.entryCondition, observations) !== true) return reject("entry_not_proven");
  const dispatch = outcome.activityRefs.map(ref => phase!.activities.find(a => a.id === ref));
  if (dispatch.some(a => !a || a.activation !== "choice_outcome" || a.configurationScope?.length)) return reject("invalid_dispatch");
  const actions = dispatch.filter((a): a is Extract<ManualActivity, { kind: "RESOURCE_ACTION" }> => a?.kind === "RESOURCE_ACTION");
  if (actions.length !== 1) return reject("invalid_resource_action");
  const action = actions[0], auth = ir.policies.authorizations.find(a => a.id === action.payload.authorizationRef);
  if (!auth?.resourceRefs.includes(input.resourceRef) || auth.audience.kind !== "public" || action.audience.kind !== "public" || evaluateActivityCondition(ir, auth.conditionRef, observations) !== true ||
    action.payload.resourceSelector.kind !== "choice" || action.payload.resourceSelector.choiceRef !== choice.id) return reject("authorization_not_proven");
  if (dispatch[0]?.id !== action.id || outcome.contentBundleRef !== resource.contentBundleRef) return reject("invalid_dispatch_order");
  const committed = { ...input, activityRefs: [...outcome.activityRefs], contentBundleRef: outcome.contentBundleRef };
  const next: ChoiceState = { openedResourceIds: [...state.openedResourceIds, input.resourceRef], receipts: { ...state.receipts, [input.requestId]: committed } };
  return { accepted: true, duplicate: false, reason: "committed_dispatch_intent", state: next,
    activityRefs: [...outcome.activityRefs], contentBundleRef: outcome.contentBundleRef, quotaExhausted: used + 1 === choice.payload.quota };
}
