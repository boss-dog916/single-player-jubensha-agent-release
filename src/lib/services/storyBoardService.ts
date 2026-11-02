import { generateStoryBoardPatch } from "@/src/lib/agents/storyBoardWriter";
import { uniquePublicFacts } from "./publicStoryBoardPresentation";
import { prisma } from "@/src/lib/db/prisma";
import type { StoryBoardPatch, StoryBoardPatchItem } from "@/src/lib/schemas/storyBoardPatchSchema";
import { getGameSession } from "@/src/lib/services/gameService";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import {
  getMessageInGame,
  markMessageStoryBoardProcessed
} from "@/src/lib/services/messageService";
import {
  applyMessageToPublicStoryBoard,
  createEmptyPublicStoryBoard
} from "@/src/lib/services/publicStoryBoardService";
import type { Message, PublicStoryBoard } from "@/src/lib/types/game";

export type UpsertPublicStoryBoardInput = {
  gameSessionId: string;
  board: PublicStoryBoard;
};

export type ApplyPublicMessageToStoredStoryBoardInput = {
  gameSessionId: string;
  message: Message;
  mockPatchOutput?: unknown;
};

export type ApplyPublicMessageToStoredStoryBoardResult = {
  board: PublicStoryBoard;
  patch: StoryBoardPatch | null;
  alreadyProcessed: boolean;
};

export { applyMessageToPublicStoryBoard, createEmptyPublicStoryBoard };

export async function getPublicStoryBoard(gameSessionId: string): Promise<PublicStoryBoard> {
  const record = await prisma.publicStoryBoard.findUnique({
    where: { gameSessionId }
  });

  if (!record) {
    throw new Error(`PublicStoryBoard not found for game session "${gameSessionId}".`);
  }

  return fromJsonValue(record.board, createEmptyPublicStoryBoard());
}

export async function getOrCreatePublicStoryBoard(
  gameSessionId: string
): Promise<PublicStoryBoard> {
  const existing = await prisma.publicStoryBoard.findUnique({
    where: { gameSessionId }
  });

  if (existing) {
    return fromJsonValue(existing.board, createEmptyPublicStoryBoard());
  }

  const board = createEmptyPublicStoryBoard();

  await prisma.publicStoryBoard.create({
    data: {
      gameSessionId,
      board: toJsonInput(board)
    }
  });

  return board;
}

export async function upsertPublicStoryBoard({
  gameSessionId,
  board
}: UpsertPublicStoryBoardInput): Promise<PublicStoryBoard> {
  const record = await prisma.publicStoryBoard.upsert({
    where: { gameSessionId },
    create: {
      gameSessionId,
      board: toJsonInput(board)
    },
    update: {
      board: toJsonInput(board)
    }
  });

  return fromJsonValue(record.board, createEmptyPublicStoryBoard());
}

export async function applyPublicMessageToStoredStoryBoard(
  gameSessionId: string,
  message: Message,
  mockPatchOutput?: unknown
): Promise<PublicStoryBoard> {
  const result = await processPublicMessageForStoryBoard({
    gameSessionId,
    message,
    mockPatchOutput
  });

  return result.board;
}

export async function applyPublicMessageToStoredStoryBoardWithPatch(
  gameSessionId: string,
  message: Message,
  mockPatchOutput?: unknown
): Promise<ApplyPublicMessageToStoredStoryBoardResult> {
  return processPublicMessageForStoryBoard({
    gameSessionId,
    message,
    mockPatchOutput
  });
}

export async function processPublicMessageForStoryBoard({
  gameSessionId,
  message,
  mockPatchOutput
}: ApplyPublicMessageToStoredStoryBoardInput): Promise<ApplyPublicMessageToStoredStoryBoardResult> {
  const storedMessage = await getMessageInGame(gameSessionId, message.message_id);

  if (!isFormalPublicMessage(storedMessage)) {
    return {
      board: await getOrCreatePublicStoryBoard(gameSessionId),
      patch: null,
      alreadyProcessed: false
    };
  }

  if (storedMessage.story_board_processed_at) {
    return {
      board: await getOrCreatePublicStoryBoard(gameSessionId),
      patch: null,
      alreadyProcessed: true
    };
  }

  const [session, currentBoard] = await Promise.all([
    getGameSession(gameSessionId),
    getOrCreatePublicStoryBoard(gameSessionId)
  ]);
  const { patch } = await generateStoryBoardPatch({
    session,
    latestMessage: storedMessage,
    mockOutput: mockPatchOutput
  });
  const nextBoard = mergeStoryBoardPatch(currentBoard, patch, storedMessage, session.currentActId);
  const saved = await upsertPublicStoryBoard({
    gameSessionId,
    board: nextBoard
  });

  await markMessageStoryBoardProcessed(storedMessage.message_id);

  return {
    board: saved,
    patch,
    alreadyProcessed: false
  };
}

export function mergeStoryBoardPatch(
  current: PublicStoryBoard,
  patch: StoryBoardPatch,
  sourceMessage: Message | string,
  sourceActId?: string
): PublicStoryBoard {
  const evidenceMessageId =
    typeof sourceMessage === "string" ? sourceMessage : sourceMessage.message_id;

  return {
    known_facts: uniquePublicFacts(appendPatchItems(
      current.known_facts,
      patch.known_facts_to_add,
      evidenceMessageId
    )),
    timeline: appendPatchItems(
      current.timeline,
      patch.timeline_events_to_add,
      evidenceMessageId
    ),
    relationships: appendPatchItems(
      current.relationships,
      patch.relationships_to_add,
      evidenceMessageId
    ),
    open_questions: appendPatchItems(
      current.open_questions,
      patch.open_questions_to_add,
      evidenceMessageId
    ),
    contradictions: appendPatchItems(
      current.contradictions,
      patch.contradictions_to_add,
      evidenceMessageId
    ),
    emotional_bonds: appendPatchItems(
      current.emotional_bonds,
      patch.emotional_bonds_to_add,
      evidenceMessageId
    ),
    discussed_questions: appendPatchItems(
      current.discussed_questions,
      patch.discussed_questions_to_add,
      evidenceMessageId
    ),
    current_conflicts: appendPatchItems(
      current.current_conflicts,
      patch.current_conflicts_to_add,
      evidenceMessageId
    ),
    lastUpdatedMessageId: evidenceMessageId,
    lastUpdatedActId:
      sourceActId ?? current.lastUpdatedActId ?? null,
    lastUpdatedMessageCreatedAt:
      typeof sourceMessage === "string"
        ? current.lastUpdatedMessageCreatedAt ?? null
        : sourceMessage.created_at?.toISOString() ?? new Date().toISOString(),
    visibility: "public"
  };
}

export function isFormalPublicMessage(message: Message): boolean {
  if (!message.message_id || !message.created_at) {
    return false;
  }

  if (message.speaker_type === "system") {
    return false;
  }

  if (message.speaker_type === "dm" && message.metadata.storyBoardEligible !== true) {
    return false;
  }

  if (message.speech_act === "system") {
    return false;
  }

  return Boolean(message.content.trim());
}

function appendPatchItems(
  current: string[],
  incoming: StoryBoardPatchItem[],
  evidenceMessageId: string
): string[] {
  const incomingTexts = incoming
    .filter((item) => item.evidenceMessageId === evidenceMessageId)
    .map((item) => item.text.trim())
    .filter(Boolean);

  return Array.from(new Set([...current, ...incomingTexts]));
}
