import { z } from "zod";

export const AiPlayerDiscussionUtteranceSchema = z
  .object({
    formal_clue_ids: z.array(z.string().min(1)).max(5).nullable().optional(),
    content: z.string().min(1),
    metadata: z
      .object({
        revealed_facts: z.array(z.string()),
        emotional_points: z.array(z.string()),
        questions_raised: z.array(z.string()),
        mentioned_role_ids: z.array(z.string()),
        event_tags: z.array(z.string()),
        topic_tags: z.array(z.string())
      })
      .strict(),
    self_check: z
      .object({
        follows_brief_intent: z.boolean(),
        uses_only_allowed_context: z.boolean(),
        avoids_forbidden_boundaries: z.boolean()
      })
      .strict()
  })
  .strict();

export type AiPlayerDiscussionUtteranceOutput = z.infer<
  typeof AiPlayerDiscussionUtteranceSchema
>;
