import { z } from "zod";
import { SourceEvidenceSchema } from "./manualSemanticSchema";

export const MANUAL_V2_VERSIONS = { parser: "whole-manual-2", plannerPrompt: "manual-plan-2", prompt: "manual-extract-2", schema: "semantic_v2", validator: "manual-semantic-2" } as const;
const nullableText = z.string().nullable();
const strings = z.array(z.string());
const confidence = z.number().min(0).max(1);
export const CitationSchema = z.object({
  paragraphStart: z.number().int().nonnegative(), paragraphEnd: z.number().int().nonnegative(),
  sourceStart: z.number().int().nonnegative().nullable(), sourceEnd: z.number().int().nonnegative().nullable(),
  sourceQuote: z.string().min(1)
}).strict();
export const PlanRegionSchema = z.object({
  regionId: z.string().min(1), logicalActId: nullableText, actIndex: z.number().int().positive().nullable(),
  semanticSectionType: z.enum(["opening", "act", "ending", "internal", "unknown"]),
  paragraphStart: z.number().int().nonnegative(), paragraphEnd: z.number().int().nonnegative(),
  sourceHeading: nullableText, interpretation: z.string(), confidence,
  variantGroupId: nullableText, branchId: nullableText,
  boundaryHints: strings, warnings: strings, evidence: CitationSchema
}).strict();
export const VariantPlanSchema = z.object({
  variantGroupId: z.string(), logicalActId: nullableText, selectionBasis: nullableText,
  branches: z.array(z.object({ branchId: z.string(), label: z.string(), regionIds: strings, evidence: CitationSchema }).strict()).min(2),
  commonContinuationRegionIds: strings, resolvedBranchId: z.null(), warnings: strings
}).strict();
export const RosterEntrySchema = z.object({
  canonicalRole: z.string(), aliases: strings, kind: z.enum(["player", "npc", "unknown"]),
  manifestRole: nullableText, evidence: CitationSchema.nullable(), warnings: strings
}).strict();
export const ManualPlanOutputSchema = z.object({
  regions: z.array(PlanRegionSchema).min(1), variants: z.array(VariantPlanSchema), roster: z.array(RosterEntrySchema), warnings: strings
}).strict();
export const PolicyOutputSchema = z.object({
  mode: z.enum(["ordered_share_then_discuss", "free_discussion_after_reading", "hybrid", "unknown"]),
  source: z.literal("manual"), evidence: z.array(CitationSchema), warnings: strings
}).strict();
export const SemanticItemOutputSchema = z.object({
  localId: z.string().min(1), kind: z.enum(["reading", "conversation_window", "spoken_line", "question", "action", "internal_note", "conditional_rule", "variant_group", "transition", "reveal", "clue_release", "performance", "unknown"]),
  channel: z.enum(["spoken", "action", "internal_only", "control"]), instruction: z.string(), confidence,
  evidence: CitationSchema, variantGroupId: nullableText, branchId: nullableText,
  required: z.boolean(), warnings: strings,
  reading: z.object({ actIndex: z.number().int().positive() }).strict().nullable(),
  conversation: z.object({ windowId: z.string(), mode: z.enum(["ordered_sharing", "free_discussion", "hybrid", "unknown"]), goal: z.string(), exitGuidance: nullableText, requiredPoints: strings }).strict().nullable(),
  question: z.object({ targetRoles: strings, targetMode: z.enum(["group", "direct"]), answerRequired: z.boolean(), expectedInformation: strings, requiredPublicPoints: strings, completionSemantics: nullableText, fallbackGuidance: nullableText }).strict().nullable(),
  action: z.object({ actionType: z.string(), parameters: strings, variantSelection: z.array(z.object({ condition: z.string(), parameter: z.string(), value: z.string(), evidence: CitationSchema }).strict()) }).strict().nullable(),
  clue: z.object({ clues: strings, targetRoles: strings, releaseRequired: z.boolean() }).strict().nullable(),
  conditional: z.object({ condition: z.string(), effect: z.string(), modifies: z.enum(["execution", "parameter", "guidance"]), targetLocalId: nullableText }).strict().nullable(),
  transition: z.object({ nextActIndex: z.number().int().positive().nullable(), terminal: z.boolean() }).strict().nullable(),
  authorization: z.object({ authorizedContent: strings, boundary: z.string(), evidence: CitationSchema }).strict().nullable()
}).strict();
export const SemanticChunkOutputSchema = z.object({
  regionId: z.string(), logicalActId: nullableText, actIndex: z.number().int().positive().nullable(),
  conversationPolicy: PolicyOutputSchema.nullable(), items: z.array(SemanticItemOutputSchema), warnings: strings
}).strict();
export type Citation = z.infer<typeof CitationSchema>;
export type PlanRegion = z.infer<typeof PlanRegionSchema> & { sourceStart: number; sourceEnd: number };
export type ManualPlan = Omit<z.infer<typeof ManualPlanOutputSchema>, "regions"> & { regions: PlanRegion[]; manualId: string; format: "semantic_v2"; plannedParagraphEnd: number };
export type SemanticItemOutput = z.infer<typeof SemanticItemOutputSchema>;
export type EvidenceV2 = z.infer<typeof SourceEvidenceSchema> & { paragraphStart: number; paragraphEnd: number; paragraphIndexBasis: string };
export type SemanticItemV2 = Omit<SemanticItemOutput, "evidence"> & { id: string; order: number; evidence: EvidenceV2; resolvedTargetRoles: string[]; unresolvedTargetRoles: string[] };
export type SemanticRegionV2 = {
  region: PlanRegion; conversationPolicy: { mode: z.infer<typeof PolicyOutputSchema>["mode"]; source: "manual"; evidence: EvidenceV2[] } | null;
  items: SemanticItemV2[];
};
export type SemanticManualV2 = { format: "semantic_v2"; manualId: string; regions: SemanticRegionV2[]; variants: ManualPlan["variants"]; roster: ManualPlan["roster"] };
export type SemanticIssue = { code: string; severity: "error" | "warning"; message: string; regionId?: string; itemId?: string; repairCandidate: boolean };
export type SemanticValidation = { validatorVersion: string; validatedAt: string; status: "valid" | "needs_attention"; errors: SemanticIssue[]; warnings: SemanticIssue[]; repairCandidates: SemanticIssue[] };
