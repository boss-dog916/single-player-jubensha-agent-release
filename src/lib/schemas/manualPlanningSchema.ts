import { z } from "zod";

// Legacy planning contract frozen. Activity IR experiments must not extend this contract.
export const PLANNING_VERSIONS = { planner: "hierarchical-6", localPrompt: "local-structure-6", globalPrompt: "global-relations-2", schema: "planning-5" } as const;
const strings = z.array(z.string());
export const StructureTypeSchema = z.enum(["opening", "act", "ending", "internal", "unknown"]);
const shortQuote = z.string().min(1).max(180);
export const StageBoundarySchema = z.object({
  stage: z.enum(["reading", "reading_complete", "discussion", "sharing", "dm_entry", "act_start", "act_end", "ending", "transition"]),
  paragraph: z.number().int().nonnegative(), quote: shortQuote,
  boundaryScope: z.enum(["global", "variant_group", "branch", "unresolved"]),
  variantGroupCandidateId: z.string().min(1).nullable(), branchId: z.string().min(1).nullable(),
  scopeEvidence: z.object({ paragraph: z.number().int().nonnegative(), quote: shortQuote }).strict().nullable()
}).strict();
export const RoleReferenceSchema = z.object({
  id: z.string(), name: z.string().min(1), referenceType: z.enum(["player", "npc", "staff", "performance_role", "unknown"]),
  canonicalRoleId: z.string().min(1).nullable(), aliasOf: z.string().min(1).nullable(),
  resolutionStatus: z.enum(["resolved", "unresolved", "ambiguous"]),
  identityEvidence: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual_source"), paragraph: z.number().int().nonnegative(), quote: shortQuote }).strict(),
    z.object({ kind: z.literal("verified_manifest"), verifiedAliasId: z.string().min(1) }).strict()
  ]).nullable(),
  paragraph: z.number().int().nonnegative(), quote: shortQuote, quoteOccurrence: z.number().int().nonnegative().nullable()
}).strict();
export const LocalStructureSchema = z.object({
  candidates: z.array(z.object({
    id: z.string(), paragraphStart: z.number().int().nonnegative(), paragraphEnd: z.number().int().nonnegative(),
    type: StructureTypeSchema, actIndex: z.number().int().positive().nullable(), actLabel: z.string().nullable(),
    sourceHeading: z.string().nullable(), sourceHeadingOrdinal: z.string().nullable(),
    actEvidence: z.object({ paragraph: z.number().int().nonnegative(), quote: shortQuote,
      evidenceSource: z.enum(["owned_source", "previous_verified_candidate"]), previousCandidateId: z.string().min(1).nullable()
    }).strict().nullable(),
    needsGlobalResolution: z.boolean(), actBoundaryHint: z.string().nullable(),
    stageBoundary: StageBoundarySchema.nullable(),
    quoteParagraph: z.number().int().nonnegative(), quote: shortQuote,
    variantGroupCandidateId: z.string().min(1).nullable(), branchId: z.string().min(1).nullable(),
    relation: z.enum(["branch", "common", "none", "ambiguous"]), variantAmbiguity: z.string().min(1).nullable(),
    commonPosition: z.enum(["prefix", "continuation"]).nullable(),
    branchPosition: z.enum(["body", "continuation", "boundary"]).nullable(),
    branchLabel: z.string().nullable(), variantHint: z.string().nullable(), continuationHint: z.string().nullable(),
    boundaryHints: strings, confidence: z.number().min(0).max(1), warnings: strings
  }).strict().superRefine((c, ctx) => {
    const fail = (field: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    if (c.type === "opening" && c.actIndex !== null) fail("actIndex", "opening is not Act 0 or Act 1; actIndex must be null");
    if (c.actIndex !== null && !c.actEvidence) fail("actEvidence", "Logical act index requires explicit act-semantic source evidence, not a heading ordinal");
    if (c.type === "act" && c.actIndex === null && (!c.needsGlobalResolution || !c.actBoundaryHint)) fail("actIndex", "Unknown local act identity requires needsGlobalResolution and actBoundaryHint");
    if (c.actIndex === null && c.actEvidence !== null) fail("actEvidence", "Unresolved act identity must not claim resolved act evidence");
    if (c.actEvidence && (c.actEvidence.evidenceSource === "owned_source" ? c.actEvidence.previousCandidateId !== null : !c.actEvidence.previousCandidateId)) fail("actEvidence", "Evidence provenance must distinguish owned source from an identified verified predecessor");
    if (c.stageBoundary && (c.stageBoundary.paragraph !== c.paragraphStart || c.stageBoundary.paragraph > c.paragraphEnd)) fail("stageBoundary", "A confirmed stage boundary must start its own structural candidate, including at window end");
    if (c.stageBoundary?.stage === "reading" && c.type !== "act") fail("type", "Explicit act reading starts an act candidate, not an opening hint");
    if (c.sourceHeading === null && c.sourceHeadingOrdinal !== null) fail("sourceHeadingOrdinal", "Ordinal requires a source heading");
    if (c.relation === "branch" && (!c.variantGroupCandidateId || !c.branchId || !c.branchLabel)) fail("relation", "branch requires group candidate ID, branch ID and literal branch label");
    if (c.relation === "common" && (!c.variantGroupCandidateId || c.branchId || c.branchLabel || !c.continuationHint)) fail("relation", "common requires group ID and continuation hint, not branch identity");
    if ((c.relation === "common") !== (c.commonPosition !== null)) fail("commonPosition", "Only common requires explicit prefix/continuation position");
    if ((c.relation === "branch") !== (c.branchPosition !== null)) fail("branchPosition", "Only branch requires explicit body/continuation/boundary position");
    const b = c.stageBoundary;
    if (b) {
      if (b.boundaryScope === "branch" && (c.relation !== "branch" || c.branchPosition !== "boundary" || b.variantGroupCandidateId !== c.variantGroupCandidateId || b.branchId !== c.branchId)) fail("stageBoundary", "Branch boundary must retain the owning branch identity and boundary position");
      if (c.relation === "branch" && b.boundaryScope !== "branch" && b.boundaryScope !== "unresolved") fail("stageBoundary", "A branch-local boundary cannot become global or shared");
      if (b.boundaryScope === "global" && (b.variantGroupCandidateId || b.branchId || c.relation !== "none" || !b.scopeEvidence)) fail("stageBoundary", "Global boundary needs explicit owned scope evidence and no variant ownership");
      if (b.boundaryScope === "variant_group" && (c.relation !== "common" || c.commonPosition !== "continuation" || b.variantGroupCandidateId !== c.variantGroupCandidateId || b.branchId || !b.scopeEvidence)) fail("stageBoundary", "Group boundary requires evidenced shared continuation of the same group");
      if (b.boundaryScope === "unresolved" && !c.needsGlobalResolution) fail("stageBoundary", "Unresolved scope must remain pending global resolution");
    }
    if (c.relation === "none" && (c.variantGroupCandidateId || c.branchId || c.branchLabel || c.variantAmbiguity)) fail("relation", "none cannot conceal a variant relationship");
    if (c.relation === "ambiguous" && (!c.variantGroupCandidateId || !c.variantAmbiguity || !c.needsGlobalResolution)) fail("variantAmbiguity", "Unresolved variant needs a group ID, ambiguity description and global resolution flag");
    if (c.relation !== "ambiguous" && c.variantAmbiguity) fail("variantAmbiguity", "Ambiguity must be represented explicitly");
  })).min(1),
  references: z.array(RoleReferenceSchema),
  warnings: strings
}).strict();
export const GlobalRelationsSchema = z.object({
  groups: z.array(z.object({ logicalActId: z.string().nullable(), actIndex: z.number().int().positive().nullable(), type: StructureTypeSchema, candidateIds: strings }).strict()).min(1),
  variants: z.array(z.object({ id: z.string(), branches: z.array(z.object({ label: z.string(), candidateIds: strings }).strict()).min(2), continuationCandidateIds: strings, selectionCandidateIds: strings }).strict()),
  aliases: z.array(z.object({ canonicalRole: z.string(), referenceIds: strings }).strict()),
  warnings: strings
}).strict();
export type LocalStructure = z.infer<typeof LocalStructureSchema>;
export type StructureCandidate = LocalStructure["candidates"][number];
export type GlobalRelations = z.infer<typeof GlobalRelationsSchema>;
