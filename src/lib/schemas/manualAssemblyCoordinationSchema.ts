import { z } from "zod";
import { SourcePhaseHintSchema } from "./manualSourceSemanticsSchema";

export const ASSEMBLY_COORDINATION_VERSION = "manual_assembly_coordination_v1";
const ref = z.string().min(1), refs = z.array(ref);
export const AssemblyIssueSchema = z.object({
  id: ref,
  kind: z.enum(["configuration_scope", "configuration_compatibility", "shared_content_scope", "activity_order", "trigger_scope",
    "choice_dispatch", "authorization_binding", "actor_binding", "persona_binding", "resource_dispatch", "transition_target", "source_layout_ambiguity"]),
  sourceRefs: refs, relatedSemanticItemIds: refs,
  reason: ref, requiredResolution: ref,
  severity: z.enum(["assembly_blocker", "runtime_blocker", "warning"])
}).strict();
export const AssemblyResolutionSchema = z.object({
  issueId: ref,
  resolutionKind: z.enum(["scope", "grouping", "ordering", "dispatch", "keep_unresolved"]),
  selectedRefs: refs,
  sourceRefs: refs.min(1),
  ordering: refs.optional(),
  scope: z.array(z.object({ dimension: ref, option: ref }).strict()).optional(),
  binding: z.enum(["explicit_variants_only", "point_missing_after_entry", "entry_repeat", "semantic_predicate", "optional_interaction",
    "public_choice_cycle", "public_archive_reader", "relative_gender_dispatch", "archive_emphasis", "identity_belief", "phase_quota", "deny_before_phase", "region_media_header"]).optional(),
  quota: z.number().int().positive().optional(),
  confidence: z.enum(["source_explicit", "unresolved"]),
  unresolvedReason: ref.optional()
}).strict();
export const AssemblyCoordinationOutputSchema = z.object({ resolutions: z.array(AssemblyResolutionSchema) }).strict();
// Payload is a pass-through copy of ALREADY validated frozen source facts, not a new extraction grammar.
export const AssemblyCoordinationInputSchema = z.object({
  schemaVersion: z.literal(ASSEMBLY_COORDINATION_VERSION), sourceFingerprint: ref,
  semanticItems: z.array(z.object({ localId: ref, semanticKind: ref, sourceBlockIds: refs.min(1), payload: z.record(z.unknown()),
    phaseHint: SourcePhaseHintSchema.optional(), contextHint: ref.optional() }).strict()),
  sources: z.array(z.object({ id: ref, text: ref }).strict()),
  candidatePhases: z.array(z.object({ semanticItemId: ref, sourceLabel: ref }).strict()),
  issues: z.array(AssemblyIssueSchema)
}).strict();
export type AssemblyIssue = z.infer<typeof AssemblyIssueSchema>;
export type AssemblyResolution = z.infer<typeof AssemblyResolutionSchema>;
export type AssemblyCoordinationInput = z.infer<typeof AssemblyCoordinationInputSchema>;
export type AssemblyCoordinationOutput = z.infer<typeof AssemblyCoordinationOutputSchema>;

export function assemblyCoordinationGrammar() {
  return `Output={resolutions:Resolution[]}\nResolution={issueId:string,resolutionKind:"scope"|"grouping"|"ordering"|"dispatch"|"keep_unresolved",selectedRefs:string[],sourceRefs:string[]+,ordering?:string[],scope?:{dimension:string,option:string}[],binding?:"explicit_variants_only"|"point_missing_after_entry"|"entry_repeat"|"semantic_predicate"|"optional_interaction"|"public_choice_cycle"|"public_archive_reader"|"relative_gender_dispatch"|"archive_emphasis"|"identity_belief"|"phase_quota"|"deny_before_phase"|"region_media_header",quota?:positive integer,confidence:"source_explicit"|"unresolved",unresolvedReason?:string}\nOnly relate existing supplied semantic IDs. Never output IR, new facts, dialogue, actors or resources. keep_unresolved requires a reason and unresolved confidence. Other resolutions require source_explicit and fenced supporting sources.`;
}

export function assemblyCoordinationInputGrammar() {
  return `Input={schemaVersion:"manual_assembly_coordination_v1",sourceFingerprint:string,semanticItems:ExistingFact[],sources:{id:string,text:string}[],candidatePhases:{semanticItemId:string,sourceLabel:string}[],issues:Issue[]}\nExistingFact={localId:string,semanticKind:string,sourceBlockIds:string[]+,payload:immutable validated SourceSemanticPayload,phaseHint?:{sourceLabel:string,phaseTypeHint:"prologue"|"act"|"ending"|"unknown",actNumberHint:positive integer|null},contextHint?:string}\nIssue={id:string,kind:"configuration_scope"|"configuration_compatibility"|"shared_content_scope"|"activity_order"|"trigger_scope"|"choice_dispatch"|"authorization_binding"|"actor_binding"|"persona_binding"|"resource_dispatch"|"transition_target"|"source_layout_ambiguity",sourceRefs:string[],relatedSemanticItemIds:string[],reason:string,requiredResolution:string,severity:"assembly_blocker"|"runtime_blocker"|"warning"}\nOnly supplied existing facts and fenced source text; do not modify the input.`;
}
