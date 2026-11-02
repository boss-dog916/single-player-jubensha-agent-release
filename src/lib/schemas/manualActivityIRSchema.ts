import { z } from "zod";

// Independent, offline candidate contract. Never adapted through semantic_v2/DMFlow.
export const MANUAL_ACTIVITY_VERSION = "manual_activity_v1" as const;
const id = z.string().min(1);
const refs = z.array(id);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ActivityEvidenceSchema = z.object({
  documentId: id, revision: z.number().int().positive(), sourceHash: hash,
  sourceSpan: z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict(),
  sourceQuote: z.string().min(1),
  locator: z.discriminatedUnion("format", [
    z.object({ format: z.literal("docx"), normalizedParagraph: z.number().int().nonnegative(), ooxmlOrdinal: z.number().int().nonnegative(), locatorVersion: id }).strict(),
    z.object({ format: z.literal("pdf"), physicalPage: z.number().int().positive(), textBlock: id, locatorVersion: id,
      layoutFidelity: z.enum(["unsupported", "unresolved", "verified"]) }).strict()
  ])
}).strict();
const evidence = z.array(ActivityEvidenceSchema).min(1);
export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("public") }).strict(), z.object({ kind: z.literal("dm_only") }).strict(),
  z.object({ kind: z.literal("selected_roles"), roleRefs: refs.min(1) }).strict()
]);
const scope = z.array(z.object({ dimension: id, option: id }).strict()).nullable();
export const ActorSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("roles"), roleRefs: refs.min(1) }).strict(),
  z.object({ kind: z.literal("participants") }).strict(),
  z.object({ kind: z.literal("choice_reader"), choiceRef: id }).strict()
]);
const entity = { id, sourceEvidence: evidence };
const scoped = { ...entity, configurationScope: scope };
export const ConfigSpecSchema = z.object({
  ...entity, dimension: id, selectionRequired: z.boolean(),
  options: z.array(z.object({ ...entity, label: id, capabilityConstraints: refs, contentRefs: refs,
    actorBindings: z.array(z.object({ controllerRef: id, storyRoleRef: id, personaRef: id.nullable(),
      resolution: z.enum(["verified", "unresolved"]), sourceEvidence: evidence }).strict()) }).strict()).min(1),
  compatibilityConstraints: z.array(z.object({ when: scope, requires: scope, sourceEvidence: evidence }).strict())
}).strict();
export const ConditionSchema = z.discriminatedUnion("kind", [
  z.object({ ...entity, kind: z.literal("config_selected"), dimension: id, option: id }).strict(),
  z.object({ ...entity, kind: z.literal("current_phase"), phaseRef: id }).strict(),
  z.object({ ...entity, kind: z.literal("resource_eligible"), resourceRef: id }).strict(),
  z.object({ ...entity, kind: z.literal("resource_opened"), resourceRef: id }).strict(),
  z.object({ ...entity, kind: z.literal("answer_submitted"), interactionRef: id }).strict(),
  z.object({ ...entity, kind: z.literal("point_observed"), pointRef: id }).strict(),
  z.object({ ...entity, kind: z.literal("discussion_checkpoint"), activityRef: id }).strict(),
  z.object({ ...entity, kind: z.literal("event_flag"), eventKey: id }).strict(),
  z.object({ ...entity, kind: z.literal("all"), conditionRefs: refs.min(1) }).strict(),
  z.object({ ...entity, kind: z.literal("any"), conditionRefs: refs.min(1) }).strict(),
  z.object({ ...entity, kind: z.literal("semantic"), textRef: id, operationalStatus: z.literal("unresolved") }).strict()
]);
export const RequiredPointSchema = z.object({
  ...entity, subjectRoleRefs: refs.min(1), meaningRef: id, importance: z.enum(["hard", "soft", "optional"]),
  timing: z.object({ firstApplicablePhase: id, duePhase: id.nullable(), deferredFromPointRef: id.nullable() }).strict(),
  completionMode: z.enum(["public_observed", "dm_authorized_supply", "question_attempted"]),
  onMissing: z.enum(["cue", "authorized_supply", "defer", "mark_unresolved"]),
  releaseConstraintRef: id.nullable(), fallbackRef: id.nullable()
}).strict();
export const DiscussionPolicySchema = z.object({
  ...entity, mode: z.enum(["free", "facilitated", "ordered"]),
  preferredOrder: z.array(refs.min(1)), fallbackOrder: z.array(refs.min(1)),
  constraints: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("first"), roleRef: id, strength: z.enum(["hard", "soft"]), sourceEvidence: evidence }).strict(),
    z.object({ kind: z.literal("last"), roleRef: id, strength: z.enum(["hard", "soft"]), sourceEvidence: evidence }).strict(),
    z.object({ kind: z.literal("after"), roleRef: id, counterpartRef: id, strength: z.enum(["hard", "soft"]), sourceEvidence: evidence }).strict()
  ])), dmParticipation: z.enum(["observe", "prompt_missing", "participate_after_counterpart"])
}).strict();
export const InteractionSchema = z.object({
  ...entity, targetSelector: ActorSelectorSchema, responseMode: z.enum(["none", "free_answer", "choice"]),
  expectedInfoRefs: refs, waitRuleRef: id.nullable(), fallbackRef: id.nullable()
}).strict();
export const GuidanceSchema = z.object({
  ...entity, kind: z.enum(["optional_guidance", "best_practice", "fallback_strategy", "style_hint"]),
  textRef: id, scope: z.object({ phaseRefs: refs, activityRefs: refs }).strict(), priority: z.number().int(), exceptions: refs
}).strict();
export const ConditionalPolicySchema = z.object({
  ...entity, scope: z.object({ phaseRefs: refs, activityRefs: refs }).strict(), conditionRef: id,
  triggerWhen: z.boolean(), effect: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cue_question"), interactionRef: id }).strict(),
    z.object({ kind: z.literal("acknowledge"), contentRef: id }).strict(),
    z.object({ kind: z.literal("summarize"), contentRef: id }).strict(),
    z.object({ kind: z.literal("private_support"), activityRef: id }).strict(),
    z.object({ kind: z.literal("deny_resource"), resourceRef: id, contentRef: id }).strict(),
    z.object({ kind: z.literal("supply_authorized_content"), contentRef: id, authorizationRef: id }).strict()
  ]), priority: z.number().int(), once: z.boolean(), cooldownMs: z.number().int().nonnegative()
}).strict();
export const PerformanceCueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Spoken"), performerRef: id, personaRef: id.nullable(), targetRefs: refs, textRef: id,
    fidelity: z.enum(["fixed", "reference"]) }).strict(),
  z.object({ kind: z.literal("Stage"), performerRef: id, targetRefs: refs, actionRef: id, capabilityRef: id }).strict(),
  z.object({ kind: z.literal("Media"), mediaRef: id, operation: z.enum(["play", "stop", "change", "volume"]), timingRef: id.nullable() }).strict()
]);
export const PerformanceScriptSchema = z.object({
  beats: z.array(z.object({ id, order: z.number().int().nonnegative(), cues: z.array(PerformanceCueSchema), interactionRef: id.nullable() }).strict()).min(1)
}).strict();
const contentBase = { ...scoped, audience: AudienceSchema, releaseConstraintRef: id.nullable() };
export const ActivityContentSchema = z.discriminatedUnion("kind", [
  z.object({ ...contentBase, kind: z.literal("text"), text: z.string().min(1) }).strict(),
  z.object({ ...contentBase, kind: z.literal("performance"), script: PerformanceScriptSchema }).strict(),
  z.object({ ...contentBase, kind: z.literal("bundle"), contentRefs: refs.min(1) }).strict(),
  z.object({ ...contentBase, kind: z.literal("external"), assetRef: id }).strict()
]);
export const ExternalAssetRefSchema = z.object({ ...entity, label: id, status: z.enum(["available", "missing", "unresolved"]),
  verifiedHash: hash.nullable(), required: z.boolean(), capabilityRef: id }).strict();
const activityBase = { ...scoped, order: z.number().int().nonnegative(), participants: refs, audience: AudienceSchema,
  activation: z.enum(["sequence", "choice_outcome", "policy"]),
  entryCondition: id.nullable(), contentRefs: refs, policyRefs: refs };
export const ActivitySchema = z.discriminatedUnion("kind", [
  z.object({ ...activityBase, kind: z.literal("READ"), completion: z.literal("reading_confirmed"), payload: z.object({
    contentRef: id, readingMode: z.enum(["individual_private", "public_read_aloud"]), readerSelector: ActorSelectorSchema, confirmationsFrom: refs }).strict() }).strict(),
  z.object({ ...activityBase, kind: z.literal("DISCUSS"), completion: z.literal("discussion_checkpoint"), payload: z.object({
    goalRef: id, pointRefs: refs, discussionPolicyRef: id, exitRuleRef: id }).strict() }).strict(),
  z.object({ ...activityBase, kind: z.literal("DM_INTERVENE"), completion: z.literal("inputs_recorded"), payload: z.object({
    intent: z.enum(["explain", "cue", "question", "summarize"]), scriptRef: id, targetSelector: ActorSelectorSchema, interactionRef: id.nullable() }).strict() }).strict(),
  z.object({ ...activityBase, kind: z.literal("PERFORM"), completion: z.literal("performance_finished"), payload: z.object({
    scriptRef: id, interactionRefs: refs }).strict() }).strict(),
  z.object({ ...activityBase, kind: z.literal("PRIVATE_INTERACTION"), completion: z.literal("private_finished"), payload: z.object({
    targetSelector: ActorSelectorSchema, purposeRef: id, scriptRef: id, completionRuleRef: id, returnToActivityRef: id }).strict() }).strict(),
  z.object({ ...activityBase, kind: z.literal("PLAYER_CHOICE"), completion: z.literal("inputs_recorded"), payload: z.object({
    inputMode: z.enum(["single_option", "assignment", "free_answer"]), chooserSelector: ActorSelectorSchema,
    optionsSource: z.discriminatedUnion("kind", [z.object({ kind: z.literal("resources"), resourceRefs: refs.min(1) }).strict(),
      z.object({ kind: z.literal("content"), contentRefs: refs.min(1) }).strict(), z.object({ kind: z.literal("free_answer") }).strict()]),
    eligibilityRef: id, quota: z.number().int().positive().nullable(), resultBinding: z.enum(["opened_resource", "record_answer"]),
    outcomeRefs: z.array(z.object({ optionRef: id, activityRefs: refs, contentBundleRef: id.nullable() }).strict()) }).strict() }).strict(),
  z.object({ ...activityBase, kind: z.literal("RESOURCE_ACTION"), completion: z.literal("resource_committed"), payload: z.object({
    operation: z.enum(["deliver", "open", "release"]), resourceSelector: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("resource"), resourceRef: id }).strict(), z.object({ kind: z.literal("choice"), choiceRef: id }).strict()]),
    recipientsSelector: ActorSelectorSchema, authorizationRef: id, onceKey: id }).strict() }).strict(),
  z.object({ ...activityBase, kind: z.literal("TRANSITION"), completion: z.literal("transitioned"), payload: z.object({
    targetPhaseRef: id.nullable(), terminal: z.boolean(), releaseRuleRefs: refs }).strict() }).strict()
]);
export const PhaseSchema = z.object({ ...entity, phaseType: z.enum(["prologue", "act", "ending"]), sourceLabel: id,
  actNumber: z.number().int().positive().nullable(), order: z.number().int().nonnegative(), activities: z.array(ActivitySchema) }).strict();
export const ManualActivityIRSchema = z.object({
  schemaVersion: z.literal(MANUAL_ACTIVITY_VERSION),
  sourceManifest: z.array(z.object({ documentId: id, revision: z.number().int().positive(), sourceHash: hash, textHash: hash,
    locatorVersion: id, layoutFidelity: z.enum(["unsupported", "unresolved", "verified"]) }).strict()).min(1),
  actors: z.array(z.object({ ...entity, label: id, storyRole: id.nullable(), controller: z.enum(["human", "ai", "dm", "media", "unresolved"]),
    speakingPersona: id.nullable(), bindingEvidence: z.array(ActivityEvidenceSchema) }).strict()),
  configurations: z.array(ConfigSpecSchema), content: z.array(ActivityContentSchema),
  policies: z.object({ conditions: z.array(ConditionSchema), requiredPoints: z.array(RequiredPointSchema), discussion: z.array(DiscussionPolicySchema),
    interactions: z.array(InteractionSchema), conditional: z.array(ConditionalPolicySchema), guidance: z.array(GuidanceSchema),
    authorizations: z.array(z.object({ ...entity, contentRefs: refs, resourceRefs: refs, audience: AudienceSchema, conditionRef: id }).strict()) }).strict(),
  resources: z.array(z.object({ ...entity, labelRef: id, contentBundleRef: id, eligiblePhaseRefs: refs.min(1),
    performerRefs: refs, personaRef: id.nullable() }).strict()),
  externalAssets: z.array(ExternalAssetRefSchema),
  identities: z.array(z.object({ ...entity, subjectRef: id, canonicalTruthRef: id, beliefRef: id, releaseConstraintRef: id }).strict()),
  phases: z.array(PhaseSchema).min(1)
}).strict();

export type ManualActivityIR = z.infer<typeof ManualActivityIRSchema>;
export type ManualActivity = z.infer<typeof ActivitySchema>;
export type ActivityEvidence = z.infer<typeof ActivityEvidenceSchema>;
export type ActivityContent = z.infer<typeof ActivityContentSchema>;
export type Audience = z.infer<typeof AudienceSchema>;
export type ActivityCondition = z.infer<typeof ConditionSchema>;
