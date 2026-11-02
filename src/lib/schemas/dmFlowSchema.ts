import { z } from "zod";

export const DMFlowNodeTypeSchema = z.enum([
  "fixed_line",
  "reading_start",
  "sharing_round",
  "free_discussion",
  "dm_prompt",
  "performance_instruction",
  "clue_release",
  "act_summary",
  "transition",
  "ending_reveal",
  "unknown"
]);

export const DMFlowClueRefSchema = z
  .object({
    title: z.string().trim().nullable(),
    rawText: z.string().trim().nullable(),
    releaseMode: z.enum(["fixed_at_node", "dm_decision", "user_choice", "manual", "unknown"]),
    targetRoleNames: z.array(z.string().trim()),
    visibility: z.enum(["public", "private", "unknown"])
  })
  .strict();

export const DMFlowPerformanceSchema = z
  .object({
    kind: z.enum(["npc_line", "bgm", "prop", "letter", "audio", "video", "other"]).nullable(),
    instruction: z.string().trim().nullable(),
    rawText: z.string().trim().nullable()
  })
  .strict();

export const DMConditionalRuleTypeSchema = z.enum([
  "if_player_asks",
  "keyword_mentioned",
  "missing_public_point",
  "discussion_stuck",
  "discussion_too_long",
  "specific_role_speaks",
  "clue_requested",
  "fallback_answer",
  "manual"
]);

export const DMConditionalRuleResponseTypeSchema = z.enum([
  "fixed_answer",
  "guided_answer",
  "release_clue",
  "dm_prompt",
  "do_not_answer"
]);

export const DMConditionalRuleSchema = z
  .object({
    ruleId: z.string().trim().min(1),
    triggerType: DMConditionalRuleTypeSchema,
    conditionText: z.string().trim(),
    responseType: DMConditionalRuleResponseTypeSchema,
    responseText: z.string().trim().nullable(),
    targetRoleNames: z.array(z.string().trim()),
    keywords: z.array(z.string().trim()),
    // Explicit runtime opt-in: all complete public statements must be observed.
    // Legacy keywords retain their original trigger semantics.
    publicPointClaims: z.array(z.string().trim()).optional(),
    sourceQuote: z.string().trim().nullable(),
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string().trim())
  })
  .strict();

export const DMNodeGuidanceSchema = z
  .object({
    discussionGoal: z.string().trim().nullable(),
    requiredPublicPoints: z.array(z.string().trim()),
    ifMissingPoints: z.array(z.string().trim()),
    forbiddenReveals: z.array(z.string().trim()),
    toneGuidance: z.string().trim().nullable(),
    fallbackHint: z.string().trim().nullable()
  })
  .strict();

export const DMFlowNodeSchema = z
  .object({
    nodeId: z.string().trim().min(1),
    type: DMFlowNodeTypeSchema,
    actIndex: z.number().int().positive().nullable(),
    title: z.string().trim().nullable(),
    text: z.string().trim().nullable(),
    fixedLine: z.string().trim().nullable(),
    promptGoal: z.string().trim().nullable(),
    targetRoleNames: z.array(z.string().trim()),
    expectedSpeakerRoleNames: z.array(z.string().trim()),
    durationHint: z.string().trim().nullable(),
    orderHint: z.number().int().nullable(),
    requiredPublicPoints: z.array(z.string().trim()),
    ifMissingPoints: z.array(z.string().trim()),
    forbiddenReveals: z.array(z.string().trim()),
    conditionalRules: z.array(DMConditionalRuleSchema),
    guidance: DMNodeGuidanceSchema.nullable(),
    clueRefs: z.array(DMFlowClueRefSchema),
    performance: DMFlowPerformanceSchema.nullable(),
    sourceQuote: z.string().trim().min(1),
    confidence: z.number().min(0).max(1),
    warnings: z.array(z.string().trim()),
    textExecution: z.object({
      fidelity: z.enum(["fixed", "reference"]),
      wait: z.object({ maxWaitMs: z.number().int().positive(), maxResponses: z.number().int().positive() }).strict().optional(),
      when: z.object({ questionNodeId: z.string().min(1), predicate: z.string().min(1), roleName: z.string().nullable(),
        completionRequirement: z.string().trim().min(1).optional() }).strict().optional()
    }).strict().optional(),
    discussionExit: z.object({ maxWaitMs: z.number().int().positive(), minMessages: z.number().int().nonnegative(),
      maxMessages: z.number().int().positive(), questionWaitMs: z.number().int().positive(),
      onUnconfirmed: z.enum(["continue", "block"]) }).strict().optional()
  })
  .strict();

export const DMFlowSectionOutputSchema = z
  .object({
    sectionType: z.enum(["dm_opening", "dm_act", "dm_ending"]),
    actIndex: z.number().int().positive().nullable(),
    title: z.string().trim().nullable(),
    nodes: z.array(DMFlowNodeSchema),
    warnings: z.array(z.string().trim())
  })
  .strict();

export type DMFlowNodeType = z.infer<typeof DMFlowNodeTypeSchema>;
export type DMConditionalRuleType = z.infer<typeof DMConditionalRuleTypeSchema>;
export type DMConditionalRule = z.infer<typeof DMConditionalRuleSchema>;
export type DMNodeGuidance = z.infer<typeof DMNodeGuidanceSchema>;
export type DMFlowNode = z.infer<typeof DMFlowNodeSchema> & {
  // Exact, source-bound permission release; never inferred from the act number.
  knowledgeRelease?: { sourceBookletId: string; restriction: string; allowedFacts: string[] }[];
  // A short authored answer window. Ordinary discussion resumes at its next node.
  inputPolicy?: "choice_only" | "answer_only" | "directed_sharing";
  continuationRequired?: boolean;
  clueAction?: z.infer<typeof import("./runtimeClueSchema").RuntimeClueActionSchema>;
  choice?: import("zod").z.infer<typeof import("./runtimeChoiceSchema").RuntimeChoiceSchema>;
  choiceRecap?: import("zod").z.infer<typeof import("./runtimeChoiceSchema").ChoiceRecapSchema>;
  matchingReveal?: z.infer<typeof import("./runtimeChoiceSchema").GroupMatchingRevealSchema>;
  choiceEnding?: z.infer<typeof import("./runtimeChoiceSchema").ChoiceEndingSchema>;
  whenChoice?: import("zod").z.infer<typeof import("./runtimeChoiceSchema").ChoiceEqualsSchema>;
  sourceEvidence?: import("@/src/lib/schemas/manualSemanticSchema").SourceEvidence;
  semanticItemId?: string;
  variantGroup?: string;
  branchId?: string;
};
export type DMFlowSectionOutput = z.infer<typeof DMFlowSectionOutputSchema>;
