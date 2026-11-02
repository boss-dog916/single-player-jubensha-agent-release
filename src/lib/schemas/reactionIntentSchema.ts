import { z } from "zod";

export const ReactionSpeechActSchema = z.enum([
  "none",
  "question",
  "answer",
  "answer_dm_question",
  "answer_user_question",
  "answer_group_question",
  "challenge",
  "empathy",
  "clarify",
  "emotion"
]);

export const ReactionTriggerTypeSchema = z.enum([
  "memory_connection",
  "contradiction_with_own_knowledge",
  "direct_question_to_self",
  "negative_or_partial_portrayal_of_self",
  "strong_emotional_trigger",
  "minor_relevance",
  "none"
]);

export const BoundaryRiskSchema = z.enum(["none", "low", "medium", "high"]);

export const AddressingSchema = z.object({
  addressingMode: z.enum(["direct", "group", "open", "none"]),
  directTargets: z.array(z.string()),
  referencedRoles: z.array(z.string()),
  excludedTargets: z.array(z.string()),
  topic: z.string()
}).strict();

export const ReactionIntentSchema = z
  .object({
    role_id: z.string(),
    wants_to_speak: z.boolean(),
    trigger_type: ReactionTriggerTypeSchema,
    relevance_score: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5)
    ]),
    urgency_score: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5)
    ]),
    emotional_intensity_score: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5)
    ]),
    boundary_risk: BoundaryRiskSchema,
    target_role_ids: z.array(z.string()),
    speech_act: ReactionSpeechActSchema,
    reason: z.string(),
    brief_intent: z.string(),
    addressing: AddressingSchema.nullable().optional()
  })
  .strict();

export type ReactionIntent = z.infer<typeof ReactionIntentSchema>;
