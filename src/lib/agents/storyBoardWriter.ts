import "server-only";

import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildStoryBoardWriterPrompt } from "@/src/lib/prompts/storyBoardWriterPrompt";
import {
  StoryBoardPatchSchema,
  type StoryBoardPatch,
  type StoryBoardPatchItem
} from "@/src/lib/schemas/storyBoardPatchSchema";
import type { GameSession, Message } from "@/src/lib/types/game";
import { hasDiscussionHypothesis } from "@/src/lib/services/discussionKnowledge";

export type GenerateStoryBoardPatchInput = {
  session: GameSession;
  latestMessage: Message;
  mockOutput?: unknown;
};

export type GenerateStoryBoardPatchResult = {
  patch: StoryBoardPatch;
  agentRunId: string;
};

export async function generateStoryBoardPatch({
  session,
  latestMessage,
  mockOutput
}: GenerateStoryBoardPatchInput): Promise<GenerateStoryBoardPatchResult> {
  if (session.publicStoryBoardEnabled === false) return { patch: createInternalPublicPatch(latestMessage), agentRunId: "" };
  const result = await generateStructured<StoryBoardPatch>({
    gameSessionId: session.gameId,
    agentType: "story_board_writer",
    actId: session.currentActId,
    phase: session.currentPhase,
    schemaName: "story_board_patch",
    zodSchema: StoryBoardPatchSchema,
    messages: buildStoryBoardWriterPrompt({
      session,
      latestMessage
    }),
    temperature: 0.1,
    maxOutputTokens: 6000,
    mockOutput: mockOutput ?? createDeterministicStoryBoardPatch(latestMessage)
  });

  return {
    patch: preserveHypothesisStatus(result.data, latestMessage),
    agentRunId: result.agentRunId
  };
}

export function createDeterministicStoryBoardPatch(message: Message): StoryBoardPatch {
  return preserveHypothesisStatus({
    // Pronouns in generated metadata may be copied from a second-person
    // booklet. Use the actual utterance as an attributed quotation instead of
    // attempting a global pronoun rewrite (which corrupts dialogue).
    known_facts_to_add: toPatchItems(message.speaker_type === "ai_player" && message.metadata.revealed_facts.some(f => /[我你]/.test(f))
      ? [`${message.speaker_name ?? message.speaker_role_id}公开表示：“${message.content}”`] : message.metadata.revealed_facts, message.message_id),
    timeline_events_to_add: [],
    relationships_to_add: [],
    open_questions_to_add: toPatchItems(message.metadata.questions_raised, message.message_id),
    contradictions_to_add: [],
    emotional_bonds_to_add: toPatchItems(message.metadata.emotional_points, message.message_id),
    discussed_questions_to_add:
      message.speech_act === "question"
        ? toPatchItems(message.metadata.questions_raised, message.message_id)
        : [],
    current_conflicts_to_add: [],
    ignored_items: [],
    role_ids_involved: message.metadata.mentioned_role_ids,
    event_tags_added: message.metadata.event_tags,
    topic_tags_added: message.metadata.topic_tags
  }, message);
}

/** A speculative utterance remains a source-attributed open question, even
 * when generated metadata or the board model turns it into a categorical fact. */
function preserveHypothesisStatus(patch: StoryBoardPatch, message: Message): StoryBoardPatch {
  if (!["ai_player", "user"].includes(message.speaker_type) || !hasDiscussionHypothesis(message.content)) return patch;
  return { ...patch, known_facts_to_add: [], timeline_events_to_add: [], relationships_to_add: [],
    open_questions_to_add: [{ text: `${message.speaker_name ?? message.speaker_role_id}提出待核实的说法：“${message.content}”`, evidenceMessageId: message.message_id },
      ...patch.open_questions_to_add] };
}

function toPatchItems(items: string[], evidenceMessageId: string): StoryBoardPatchItem[] {
  return items.filter(Boolean).map((text) => ({
    text,
    evidenceMessageId
  }));
}

/** Minimum public-memory compatibility without inferred display summaries.
 * Keep plain human statements as attributed claims, never as verified facts. */
export function createInternalPublicPatch(message: Message): StoryBoardPatch {
  const patch = createDeterministicStoryBoardPatch(message);
  if (!patch.known_facts_to_add.length && !patch.open_questions_to_add.length && message.content.trim()) {
    const item = { text: `${message.speaker_name ?? message.speaker_role_id}公开表示：“${message.content}”`, evidenceMessageId: message.message_id };
    if (message.speech_act === "question") patch.open_questions_to_add.push(item);
    else patch.known_facts_to_add.push(item);
  }
  return patch;
}
