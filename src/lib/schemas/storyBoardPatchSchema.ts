import { z } from "zod";

const StoryBoardPatchItemSchema = z
  .object({
    text: z.string(),
    evidenceMessageId: z.string()
  })
  .strict();

const IgnoredStoryBoardItemSchema = z
  .object({
    text: z.string(),
    reason: z.string(),
    evidenceMessageId: z.string()
  })
  .strict();

export const StoryBoardPatchSchema = z
  .object({
    known_facts_to_add: z.array(StoryBoardPatchItemSchema),
    timeline_events_to_add: z.array(StoryBoardPatchItemSchema),
    relationships_to_add: z.array(StoryBoardPatchItemSchema),
    open_questions_to_add: z.array(StoryBoardPatchItemSchema),
    contradictions_to_add: z.array(StoryBoardPatchItemSchema),
    emotional_bonds_to_add: z.array(StoryBoardPatchItemSchema),
    discussed_questions_to_add: z.array(StoryBoardPatchItemSchema),
    current_conflicts_to_add: z.array(StoryBoardPatchItemSchema),
    ignored_items: z.array(IgnoredStoryBoardItemSchema),
    role_ids_involved: z.array(z.string()),
    event_tags_added: z.array(z.string()),
    topic_tags_added: z.array(z.string())
  })
  .strict();

export type StoryBoardPatch = z.infer<typeof StoryBoardPatchSchema>;
export type StoryBoardPatchItem = z.infer<typeof StoryBoardPatchItemSchema>;
