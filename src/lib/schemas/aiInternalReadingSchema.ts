import { z } from "zod";
import { ReactionProfileSchema } from "@/src/lib/schemas/reactionProfileSchema";

export const AiInternalReadingSchema = z
  .object({
    private_memory_update: z.string().min(1),
    beliefs: z.array(z.string()),
    emotional_state: z.string(),
    unresolved_questions: z.array(z.string()),
    share_intentions: z
      .object({
        must_share_summary: z.array(z.string()),
        may_share_summary: z.array(z.string()),
        must_not_share_reminder: z.array(z.string())
      })
      .strict(),
    share_plan: z
      .object({
        must_mention: z.array(z.string()),
        emotional_tone: z.string(),
        safe_boundaries: z.array(z.string()),
        possible_opening: z.string().nullable()
      })
      .strict(),
    reaction_profile: ReactionProfileSchema
  })
  .strict();

export type AiInternalReadingOutput = z.infer<typeof AiInternalReadingSchema>;
