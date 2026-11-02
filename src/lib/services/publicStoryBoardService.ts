import type { Message, PublicStoryBoard } from "@/src/lib/types/game";

export function createEmptyPublicStoryBoard(): PublicStoryBoard {
  return {
    known_facts: [],
    timeline: [],
    relationships: [],
    open_questions: [],
    contradictions: [],
    emotional_bonds: [],
    discussed_questions: [],
    current_conflicts: [],
    lastUpdatedMessageId: null,
    lastUpdatedActId: null,
    lastUpdatedMessageCreatedAt: null,
    visibility: "public_opening"
  };
}

export function applyMessageToPublicStoryBoard(
  storyBoard: PublicStoryBoard,
  message: Message
): PublicStoryBoard {
  return {
    ...storyBoard,
    known_facts: appendUnique(storyBoard.known_facts, message.metadata.revealed_facts),
    open_questions: appendUnique(storyBoard.open_questions, message.metadata.questions_raised),
    emotional_bonds: appendUnique(storyBoard.emotional_bonds, message.metadata.emotional_points),
    lastUpdatedMessageId: message.message_id,
    lastUpdatedMessageCreatedAt: message.created_at?.toISOString() ?? new Date().toISOString(),
    visibility: "public"
  };
}

function appendUnique(current: string[], incoming: string[]): string[] {
  return Array.from(new Set([...current, ...incoming].filter(Boolean)));
}
