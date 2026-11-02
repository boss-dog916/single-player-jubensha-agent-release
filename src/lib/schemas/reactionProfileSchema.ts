import { z } from "zod";

export const ReactionProfileSchema = z
  .object({
    known_event_tags: z.array(z.string()),
    related_role_ids: z.array(z.string()),
    emotional_triggers: z.array(z.string()),
    unresolved_questions: z.array(z.string()),
    current_act_speakable_topics: z.array(z.string()),
    forbidden_boundaries_summary: z.array(z.string())
  })
  .strict();

export type ReactionProfileOutput = z.infer<typeof ReactionProfileSchema>;
