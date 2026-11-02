import { createHash } from "node:crypto";
import { ManualActivityIRSchema, type ManualActivityIR, type ManualActivity, type ActivityContent, type Audience, type ActivityEvidence } from "@/src/lib/schemas/manualActivityIRSchema";
import { emptyObservations, evaluateActivityCondition } from "./manualActivityState";

export type SourceCorpus = Array<{ documentId: string; revision: number; sourceHash: string; locatorVersion: string; text: string;
  layoutFidelity?: "unsupported" | "unresolved" | "verified";
  // Trusted, human-reviewed bindings, outside model-produced IR (same trust boundary as verified aliases).
  verifiedActorBindings?: Array<{ actorRef: string; storyRoleRef: string; personaRef: string | null; sourceSpan: { start: number; end: number } }>;
  blocks: Array<{ id: string; start: number; end: number; normalizedParagraph?: number; ooxmlOrdinal?: number; physicalPage?: number }> }>;
export type ActivityIssue = { code: string; path: string; message: string };
export type ActivitySemanticValidation = { layer: "semantic"; status: "valid" | "valid_with_warnings" | "invalid"; errors: ActivityIssue[]; warnings: ActivityIssue[] };
export const activityTextHash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
export const allActivities = (ir: ManualActivityIR) => ir.phases.flatMap(p => p.activities);

function walk(value: unknown, visitor: (value: Record<string, unknown>, path: string) => void, path = "") {
  if (Array.isArray(value)) { value.forEach((v, i) => walk(v, visitor, `${path}[${i}]`)); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>; visitor(object, path);
  Object.entries(object).forEach(([k, v]) => walk(v, visitor, `${path}.${k}`));
}
export function activityDisplayContentRefs(a: ManualActivity): string[] {
  const refs = [...a.contentRefs];
  switch (a.kind) {
    case "READ": refs.push(a.payload.contentRef); break;
    case "DISCUSS": refs.push(a.payload.goalRef); break;
    case "DM_INTERVENE": case "PERFORM": refs.push(a.payload.scriptRef); break;
    case "PRIVATE_INTERACTION": refs.push(a.payload.purposeRef, a.payload.scriptRef); break;
  }
  return [...new Set(refs)];
}
export function contentChildren(content: ActivityContent): string[] {
  if (content.kind === "bundle") return content.contentRefs;
  if (content.kind === "performance") return content.script.beats.flatMap(b => b.cues.flatMap(c => c.kind === "Spoken" ? [c.textRef] : c.kind === "Stage" ? [c.actionRef] : [c.mediaRef, ...(c.timingRef ? [c.timingRef] : [])]));
  return [];
}
export function contentClosure(ir: ManualActivityIR, refs: string[]): ActivityContent[] {
  const found = new Map<string, ActivityContent>();
  const visit = (ref: string) => { const content = ir.content.find(c => c.id === ref); if (!content || found.has(ref)) return;
    found.set(ref, content); contentChildren(content).forEach(visit); };
  refs.forEach(visit); return [...found.values()];
}
export function audienceIncludes(owner: Audience, target: Audience): boolean {
  if (owner.kind === "public") return true;
  if (owner.kind === "dm_only") return target.kind === "dm_only";
  return target.kind === "selected_roles" && target.roleRefs.every(r => owner.roleRefs.includes(r));
}
export function contentAuthorized(ir: ManualActivityIR, content: ActivityContent, audience: Audience, phaseRef: string): boolean {
  const state = emptyObservations(phaseRef);
  if (content.releaseConstraintRef && evaluateActivityCondition(ir, content.releaseConstraintRef, state) !== true) return false;
  if (audienceIncludes(content.audience, audience)) return true;
  return ir.policies.authorizations.some(a => a.contentRefs.includes(content.id) && audienceIncludes(a.audience, audience) &&
    evaluateActivityCondition(ir, a.conditionRef, state) === true);
}

export function validateManualActivityIR(input: unknown, corpus: SourceCorpus): ActivitySemanticValidation {
  const errors: ActivityIssue[] = [], warnings: ActivityIssue[] = [];
  const fail = (code: string, path: string, message = code) => errors.push({ code, path, message });
  const warn = (code: string, path: string, message = code) => warnings.push({ code, path, message });
  const parsed = ManualActivityIRSchema.safeParse(input);
  if (!parsed.success) return { layer: "semantic", status: "invalid", errors: parsed.error.issues.map(i => ({ code: "SCHEMA", path: i.path.join("."), message: i.message })), warnings };
  const ir = parsed.data, activities = allActivities(ir);
  const documentIds = new Set<string>();
  for (const manifest of ir.sourceManifest) {
    const doc = corpus.find(d => d.documentId === manifest.documentId);
    if (documentIds.has(manifest.documentId) || !doc || manifest.sourceHash !== doc.sourceHash || manifest.revision !== doc.revision || manifest.textHash !== activityTextHash(doc.text) ||
      manifest.locatorVersion !== doc.locatorVersion || manifest.layoutFidelity !== (doc.layoutFidelity ?? "unsupported")) fail("SOURCE_MANIFEST", manifest.documentId);
    documentIds.add(manifest.documentId);
  }
  const ids = new Set<string>();
  walk(ir, (object, path) => {
    if (typeof object.id === "string") { if (ids.has(object.id)) fail("DUPLICATE_ID", path); ids.add(object.id); }
    if (object.sourceSpan && object.sourceQuote) {
      const e = object as unknown as ActivityEvidence, doc = corpus.find(d => d.documentId === e.documentId);
      const manifest = ir.sourceManifest.find(d => d.documentId === e.documentId);
      if (!doc || !manifest || e.sourceHash !== doc.sourceHash || e.revision !== doc.revision || manifest.sourceHash !== doc.sourceHash ||
        manifest.revision !== doc.revision || manifest.locatorVersion !== doc.locatorVersion || e.locator.locatorVersion !== doc.locatorVersion || manifest.textHash !== activityTextHash(doc.text) ||
        manifest.layoutFidelity !== (doc.layoutFidelity ?? "unsupported")) { fail("SOURCE_MANIFEST", path); return; }
      const { start, end } = e.sourceSpan;
      if (start < 0 || end <= start || doc.text.slice(start, end) !== e.sourceQuote) fail("SOURCE_FENCE", path);
      const locator = e.locator;
      const block = doc.blocks.find(b => locator.format === "docx" ? b.normalizedParagraph === locator.normalizedParagraph && b.ooxmlOrdinal === locator.ooxmlOrdinal : b.id === locator.textBlock && b.physicalPage === locator.physicalPage);
      if (!block || start < block.start || end > block.end) fail("SOURCE_LOCATOR", path);
      if (locator.format === "pdf" && locator.layoutFidelity === "verified" && manifest.layoutFidelity !== "verified") fail("FABRICATED_LAYOUT_FIDELITY", path);
    }
  });
  const groups: Record<string, Set<string>> = {
    content: new Set(ir.content.map(c => c.id)), actors: new Set(ir.actors.map(a => a.id)), activities: new Set(activities.map(a => a.id)),
    phases: new Set(ir.phases.map(p => p.id)), conditions: new Set(ir.policies.conditions.map(c => c.id)), points: new Set(ir.policies.requiredPoints.map(p => p.id)),
    interactions: new Set(ir.policies.interactions.map(i => i.id)), authorizations: new Set(ir.policies.authorizations.map(a => a.id)), resources: new Set(ir.resources.map(r => r.id)),
    assets: new Set(ir.externalAssets.map(a => a.id)), discussion: new Set(ir.policies.discussion.map(p => p.id)),
    policies: new Set([...ir.policies.conditional, ...ir.policies.discussion, ...ir.policies.guidance].map(p => p.id))
  };
  const refGroups: Record<string, string> = {
    contentRef: "content", contentRefs: "content", contentBundleRef: "content", goalRef: "content", meaningRef: "content", textRef: "content", scriptRef: "content", purposeRef: "content", actionRef: "content", mediaRef: "content", timingRef: "content", fallbackRef: "content", expectedInfoRefs: "content", labelRef: "content", beliefRef: "content", canonicalTruthRef: "content", exceptions: "content",
    roleRef: "actors", roleRefs: "actors", subjectRoleRefs: "actors", subjectRef: "actors", participants: "actors", confirmationsFrom: "actors", performerRef: "actors", performerRefs: "actors", personaRef: "actors", targetRefs: "actors", counterpartRef: "actors", storyRole: "actors", storyRoleRef: "actors", controllerRef: "actors", speakingPersona: "actors",
    phaseRef: "phases", phaseRefs: "phases", eligiblePhaseRefs: "phases", firstApplicablePhase: "phases", duePhase: "phases", targetPhaseRef: "phases",
    activityRef: "activities", activityRefs: "activities", returnToActivityRef: "activities", choiceRef: "activities",
    conditionRef: "conditions", conditionRefs: "conditions", entryCondition: "conditions", releaseConstraintRef: "conditions", eligibilityRef: "conditions", completionRuleRef: "conditions", waitRuleRef: "conditions", exitRuleRef: "conditions", releaseRuleRefs: "conditions",
    pointRef: "points", pointRefs: "points", deferredFromPointRef: "points", interactionRef: "interactions", interactionRefs: "interactions", authorizationRef: "authorizations", resourceRef: "resources", resourceRefs: "resources", assetRef: "assets", discussionPolicyRef: "discussion", policyRefs: "policies"
  };
  walk(ir, (object, path) => {
    for (const [key, value] of Object.entries(object)) {
      const group = refGroups[key]; if (!group || value == null) continue;
      for (const ref of Array.isArray(value) ? value : [value]) if (typeof ref !== "string" || !groups[group].has(ref)) fail("DANGLING_REFERENCE", `${path}.${key}`, `${group}: ${String(ref)}`);
    }
    if (object.configurationScope) for (const s of object.configurationScope as Array<{ dimension: string; option: string }>) {
      if (!ir.configurations.some(c => c.dimension === s.dimension && c.options.some(o => o.id === s.option))) fail("CONFIG_MEMBERSHIP", path);
    }
  });
  if (errors.length) return { layer: "semantic", status: "invalid", errors, warnings };
  const checkOrder = (items: Array<{ order: number }>, path: string) => { if (items.some((v, i) => i > 0 && v.order <= items[i - 1].order)) fail("ORDER", path); };
  checkOrder(ir.phases, "phases");
  if (new Set(ir.configurations.map(c => c.dimension)).size !== ir.configurations.length) fail("DUPLICATE_CONFIG_DIMENSION", "configurations");
  for (const config of ir.configurations) for (const c of config.compatibilityConstraints) for (const s of [...c.when ?? [], ...c.requires ?? []]) {
    if (!ir.configurations.some(d => d.dimension === s.dimension && d.options.some(o => o.id === s.option))) fail("CONFIG_MEMBERSHIP", config.id);
  }
  for (const c of ir.policies.conditions) {
    if (c.kind === "config_selected" && !ir.configurations.some(d => d.dimension === c.dimension && d.options.some(o => o.id === c.option))) fail("CONFIG_MEMBERSHIP", c.id);
    if (c.kind === "semantic") warn("UNRESOLVED_CONDITION", c.id);
  }
  const cycle = (ref: string, children: (id: string) => string[], path = new Set<string>()): boolean => path.has(ref) || children(ref).some(r => cycle(r, children, new Set(path).add(ref)));
  for (const c of ir.content) if (cycle(c.id, ref => contentChildren(ir.content.find(c => c.id === ref)!))) fail("CONTENT_CYCLE", c.id);
  for (const c of ir.policies.conditions) if (cycle(c.id, ref => { const v = ir.policies.conditions.find(c => c.id === ref)!; return v.kind === "all" || v.kind === "any" ? v.conditionRefs : []; })) fail("CONDITION_CYCLE", c.id);
  const bindingVerified = (actorRef: string, storyRoleRef: string, personaRef: string | null, evidence: ActivityEvidence[]) =>
    evidence.some(e => corpus.find(d => d.documentId === e.documentId)?.verifiedActorBindings?.some(b => b.actorRef === actorRef && b.storyRoleRef === storyRoleRef && b.personaRef === personaRef &&
      b.sourceSpan.start === e.sourceSpan.start && b.sourceSpan.end === e.sourceSpan.end));
  for (const actor of ir.actors) if (actor.storyRole && (actor.storyRole !== actor.id || actor.speakingPersona !== null) &&
    !bindingVerified(actor.id, actor.storyRole, actor.speakingPersona, actor.bindingEvidence)) fail("UNGROUNDED_ACTOR_BINDING", actor.id);
  for (const config of ir.configurations) for (const option of config.options) for (const binding of option.actorBindings) {
    if (binding.resolution === "verified" && !bindingVerified(binding.controllerRef, binding.storyRoleRef, binding.personaRef, binding.sourceEvidence)) fail("UNGROUNDED_ACTOR_BINDING", option.id);
  }
  for (const policy of ir.policies.discussion) {
    for (const ref of [...policy.preferredOrder, ...policy.fallbackOrder].flat()) if (!groups.actors.has(ref)) fail("DANGLING_REFERENCE", policy.id, ref);
    for (const constraint of policy.constraints) if (constraint.kind === "after" && constraint.roleRef === constraint.counterpartRef) fail("DISCUSSION_SELF_ORDER", policy.id);
  }
  for (const p of ir.policies.requiredPoints) {
    const first = ir.phases.find(f => f.id === p.timing.firstApplicablePhase)!, due = ir.phases.find(f => f.id === p.timing.duePhase);
    if (due && due.order < first.order) fail("POINT_TIMING", p.id);
    if (p.onMissing === "defer" && !due) fail("POINT_DEFER_DEADLINE", p.id);
    if ((p.onMissing === "authorized_supply" || p.completionMode === "dm_authorized_supply") && !p.releaseConstraintRef) fail("POINT_SUPPLY_AUTHORIZATION", p.id);
    if (p.timing.deferredFromPointRef === p.id) fail("POINT_SELF_REFERENCE", p.id);
  }
  for (const i of ir.policies.interactions) if ((i.responseMode === "none") !== (i.waitRuleRef === null)) fail("INTERACTION_WAIT", i.id);
  for (const asset of ir.externalAssets) {
    if (asset.status !== "available") warn("MISSING_ASSET", asset.id);
    else if (!asset.verifiedHash) fail("ASSET_UNVERIFIED", asset.id);
  }
  for (const p of ir.phases) {
    if ((p.phaseType === "act") !== (p.actNumber !== null)) fail("PHASE_IDENTITY", p.id);
    if (p.phaseType === "act") {
      const ordinal = (s: string) => {
        if (/^\d+$/.test(s)) return Number(s);
        const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        let total = 0, pending = 0;
        for (const c of s) { if (c === "十" || c === "百") { total += (pending || 1) * (c === "十" ? 10 : 100); pending = 0; } else pending = digits[c] ?? 0; }
        return total + pending;
      };
      const matches = p.sourceEvidence.flatMap(e => Array.from(e.sourceQuote.matchAll(/第\s*(\d+|[零〇一二两三四五六七八九十百]+)\s*幕/g)).map(m => ordinal(m[1])));
      if (!matches.includes(p.actNumber!)) fail("ACT_NUMBER_UNGROUNDED", p.id);
    }
    checkOrder(p.activities, p.id);
    for (const a of p.activities) {
      if (a.kind === "PRIVATE_INTERACTION") {
        const audience = a.audience, target = a.payload.targetSelector;
        if (audience.kind !== "selected_roles" || target.kind !== "roles" || target.roleRefs.some(r => !audience.roleRefs.includes(r)) ||
          audience.roleRefs.some(r => !target.roleRefs.includes(r))) fail("PRIVATE_AUDIENCE", a.id);
      }
      if (a.kind === "PRIVATE_INTERACTION" && !p.activities.some(other => other.id === a.payload.returnToActivityRef && other.activation === "sequence")) fail("PRIVATE_RETURN", a.id);
      if (a.kind === "READ" && a.payload.readingMode === "individual_private" && a.audience.kind === "public") fail("PRIVATE_READING_PUBLIC", a.id);
      if (a.kind === "TRANSITION" && (a.payload.terminal !== (a.payload.targetPhaseRef === null) || a.payload.targetPhaseRef === p.id)) fail("TRANSITION_TARGET", a.id);
      if (a.kind === "PLAYER_CHOICE") {
        if (a.payload.resultBinding === "opened_resource" && (a.payload.optionsSource.kind !== "resources" || !a.payload.quota)) fail("CHOICE_RESOURCE_CONTRACT", a.id);
        const optionIds = a.payload.optionsSource.kind === "resources" ? a.payload.optionsSource.resourceRefs : a.payload.optionsSource.kind === "content" ? a.payload.optionsSource.contentRefs : [];
        if (new Set(a.payload.outcomeRefs.map(o => o.optionRef)).size !== a.payload.outcomeRefs.length || a.payload.outcomeRefs.some(o => !optionIds.includes(o.optionRef)) ||
          optionIds.some(id => !a.payload.outcomeRefs.some(o => o.optionRef === id))) fail("CHOICE_OUTCOME", a.id);
        for (const o of a.payload.outcomeRefs) if (o.activityRefs.some(ref => activities.find(a => a.id === ref)?.activation !== "choice_outcome")) fail("CHOICE_DISPATCH_SCOPE", a.id);
      }
      if (a.kind === "PERFORM" && ir.content.find(c => c.id === a.payload.scriptRef)?.kind !== "performance") fail("PERFORMANCE_PAYLOAD", a.id);
      if (a.kind === "RESOURCE_ACTION") {
        const auth = ir.policies.authorizations.find(r => r.id === a.payload.authorizationRef)!;
        const selector = a.payload.resourceSelector;
        const choice = selector.kind === "choice" ? activities.find(c => c.id === selector.choiceRef) : null;
        const refs = selector.kind === "resource" ? [selector.resourceRef] : choice?.kind === "PLAYER_CHOICE" && choice.payload.optionsSource.kind === "resources" ? choice.payload.optionsSource.resourceRefs : [];
        if (!refs.length || refs.some(ref => !auth.resourceRefs.includes(ref)) || !audienceIncludes(auth.audience, a.audience) || evaluateActivityCondition(ir, auth.conditionRef, emptyObservations(p.id)) !== true) fail("RESOURCE_AUTHORIZATION", a.id);
      }
      for (const content of contentClosure(ir, activityDisplayContentRefs(a))) if (!contentAuthorized(ir, content, a.audience, p.id)) fail("DISCLOSURE", a.id, content.id);
      const interactionRefs = a.kind === "PERFORM" ? a.payload.interactionRefs : a.kind === "DM_INTERVENE" && a.payload.interactionRef ? [a.payload.interactionRef] : [];
      for (const content of contentClosure(ir, activityDisplayContentRefs(a))) if (content.kind === "performance") for (const beat of content.script.beats) if (beat.interactionRef) interactionRefs.push(beat.interactionRef);
      for (const ref of interactionRefs) {
        const interaction = ir.policies.interactions.find(i => i.id === ref)!;
        if (interaction.fallbackRef) for (const content of contentClosure(ir, [interaction.fallbackRef])) if (!contentAuthorized(ir, content, a.audience, p.id)) fail("DISCLOSURE", a.id, content.id);
      }
    }
  }
  for (const identity of ir.identities) if (ir.content.find(c => c.id === identity.canonicalTruthRef)!.releaseConstraintRef !== identity.releaseConstraintRef) fail("IDENTITY_DISCLOSURE", identity.id);
  for (const policy of ir.policies.conditional) {
    const effect = policy.effect;
    if (effect.kind === "private_support") {
      const activity = activities.find(a => a.id === effect.activityRef)!;
      if (activity.kind !== "PRIVATE_INTERACTION" || activity.activation !== "policy") fail("PRIVATE_POLICY_TARGET", policy.id);
      continue;
    }
    const refs = effect.kind === "cue_question" ? [ir.policies.interactions.find(i => i.id === effect.interactionRef)!.fallbackRef].filter((r): r is string => r !== null) : [effect.contentRef];
    const phases = policy.scope.phaseRefs.length ? policy.scope.phaseRefs : ir.phases.map(p => p.id);
    for (const phase of phases) for (const content of contentClosure(ir, refs)) if (!contentAuthorized(ir, content, { kind: "public" }, phase)) fail("POLICY_DISCLOSURE", policy.id, content.id);
    if (effect.kind === "supply_authorized_content" && !ir.policies.authorizations.find(a => a.id === effect.authorizationRef)!.contentRefs.includes(effect.contentRef)) fail("POLICY_AUTHORIZATION", policy.id);
  }
  for (const content of ir.content) if (content.kind === "performance") {
    checkOrder(content.script.beats, content.id);
    for (const b of content.script.beats) for (const cue of b.cues) if (cue.kind === "Spoken" && cue.fidelity === "fixed") {
      const text = ir.content.find(c => c.id === cue.textRef);
      if (text?.kind !== "text" || !text.sourceEvidence.some(e => e.sourceQuote.includes(text.text))) fail("FIXED_NOT_VERBATIM", content.id);
    }
  }
  return { layer: "semantic", status: errors.length ? "invalid" : warnings.length ? "valid_with_warnings" : "valid", errors, warnings };
}
