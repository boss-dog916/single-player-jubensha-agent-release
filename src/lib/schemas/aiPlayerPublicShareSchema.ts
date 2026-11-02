import { z } from "zod";

export const AiPlayerPublicShareSchema = z
  .object({
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
        covered_must_share: z.boolean(),
        avoided_must_not_share: z.boolean(),
        used_only_allowed_context: z.boolean()
      })
      .strict()
  })
  .strict();

export type AiPlayerPublicShareOutput = z.infer<typeof AiPlayerPublicShareSchema>;
