import type { Message as PrismaMessage, Prisma } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import type {
  GamePhase,
  Message,
  MessageMetadata,
  PublicMessage,
  SpeakerType,
  SpeechAct
} from "@/src/lib/types/game";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";

const EMPTY_METADATA: MessageMetadata = {
  revealed_facts: [],
  emotional_points: [],
  questions_raised: [],
  mentioned_role_ids: [],
  event_tags: [],
  topic_tags: []
};

export type CreateMessageInput = {
  gameSessionId: string;
  speakerType: SpeakerType;
  speakerRoleId?: RoleId | "dm" | "system" | null;
  speakerName?: string | null;
  targetRoleIds?: RoleId[];
  replyToMessageId?: string | null;
  phase: GamePhase;
  speechAct: SpeechAct;
  content: string;
  metadata?: MessageMetadata;
};

export async function createMessage(input: CreateMessageInput): Promise<Message> {
  const { commitConversationMessage } = await import("@/src/lib/services/conversationService");
  const committed = await commitConversationMessage(input);
  if (committed) return toMessage(committed);
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: input.gameSessionId }, select: { currentActId: true } });
  const record = await prisma.message.create({
    data: {
      gameSessionId: input.gameSessionId,
      speakerType: input.speakerType,
      speakerRoleId: input.speakerRoleId ?? null,
      speakerName: input.speakerName ?? null,
      targetRoleIds: toJsonInput(input.targetRoleIds ?? []),
      replyToMessageId: input.replyToMessageId ?? null,
      phase: input.phase,
      speechAct: input.speechAct,
      content: input.content,
      metadata: toJsonInput(normalizeMetadata({ ...input.metadata, act_id: input.metadata?.act_id ?? session.currentActId }))
    }
  });

  return toMessage(record);
}

export async function listMessages(gameSessionId: string, db: Prisma.TransactionClient = prisma): Promise<Message[]> {
  const records = await db.message.findMany({
    where: { gameSessionId },
    orderBy: { createdAt: "asc" }
  });

  return records.map(toMessage);
}

export async function listRecentPublicMessages(
  gameSessionId: string,
  limit = 10,
  before?: Date
): Promise<PublicMessage[]> {
  const records = await prisma.message.findMany({
    where: { gameSessionId, ...(before ? { createdAt: { lte: before } } : {}) },
    orderBy: { createdAt: "desc" },
    take: limit
  });

  return records.reverse().map((record) => ({
    id: record.id,
    speakerRoleId: record.speakerRoleId ?? "system",
    content: record.content
  }));
}

export async function getMessage(messageId: string): Promise<Message> {
  const record = await prisma.message.findUnique({
    where: { id: messageId }
  });

  if (!record) {
    throw new Error(`Message not found for messageId "${messageId}".`);
  }

  return toMessage(record);
}

export async function getMessageInGame(
  gameSessionId: string,
  messageId: string
): Promise<Message> {
  const record = await prisma.message.findFirst({
    where: {
      id: messageId,
      gameSessionId
    }
  });

  if (!record) {
    throw new Error(`Message "${messageId}" was not found in game "${gameSessionId}".`);
  }

  return toMessage(record);
}

export async function markMessageStoryBoardProcessed(
  messageId: string,
  processedAt = new Date()
): Promise<Message> {
  const record = await prisma.message.update({
    where: { id: messageId },
    data: {
      storyBoardProcessedAt: processedAt
    }
  });

  return toMessage(record);
}

function toMessage(record: PrismaMessage): Message {
  return {
    message_id: record.id,
    speaker_type: record.speakerType as SpeakerType,
    speaker_role_id: record.speakerRoleId as RoleId | "dm" | "system" | null,
    speaker_name: record.speakerName,
    target_role_ids: fromJsonValue<RoleId[]>(record.targetRoleIds, []),
    reply_to_message_id: record.replyToMessageId,
    phase: record.phase as GamePhase,
    speech_act: record.speechAct as SpeechAct,
    content: record.content,
    metadata: normalizeMetadata(fromJsonValue<Partial<MessageMetadata>>(record.metadata, EMPTY_METADATA)),
    story_board_processed_at: record.storyBoardProcessedAt,
    story_board_status: record.storyBoardStatus as Message["story_board_status"],
    story_board_attempt_count: record.storyBoardAttemptCount,
    story_board_error: record.storyBoardError,
    created_at: record.createdAt
  };
}

function normalizeMetadata(metadata?: Partial<MessageMetadata> | null): MessageMetadata {
  const normalized: MessageMetadata = {
    revealed_facts: cleanStringArray(metadata?.revealed_facts),
    emotional_points: cleanStringArray(metadata?.emotional_points),
    questions_raised: cleanStringArray(metadata?.questions_raised),
    mentioned_role_ids: cleanStringArray(metadata?.mentioned_role_ids) as RoleId[],
    event_tags: cleanStringArray(metadata?.event_tags),
    topic_tags: cleanStringArray(metadata?.topic_tags)
  };
  if (metadata?.discussionAddressingMode === "public" || metadata?.discussionAddressingMode === "reply") normalized.discussionAddressingMode = metadata.discussionAddressingMode;
  if (metadata?.discussionPublicationMode === "act_share" || metadata?.discussionPublicationMode === "reply") normalized.discussionPublicationMode = metadata.discussionPublicationMode;
  if (typeof metadata?.discussionFollowupAllowed === "boolean") normalized.discussionFollowupAllowed = metadata.discussionFollowupAllowed;
  for (const key of ["act_id", "runtimeDefinitionId", "dmRunId", "traceId", "lifecycleKey", "clueId", "discussionSourceMessageId"] as const) {
    if (typeof metadata?.[key] === "string") normalized[key] = metadata[key];
  }
  if (typeof metadata?.runtimeDefinitionVersion === "number") normalized.runtimeDefinitionVersion = metadata.runtimeDefinitionVersion;
  if (["runtime_auto", "runtime_manual_debug", "legacy_demo"].includes(metadata?.executionMode ?? "")) normalized.executionMode = metadata!.executionMode;

  if (isDmSource(metadata?.source)) {
    normalized.source = metadata.source;
  }

  if (typeof metadata?.dm_flow_node === "string" && metadata.dm_flow_node.trim()) {
    normalized.dm_flow_node = metadata.dm_flow_node.trim();
  }

  if (typeof metadata?.sourceNodeId === "string" && metadata.sourceNodeId.trim()) {
    normalized.sourceNodeId = metadata.sourceNodeId.trim();
  }

  if (typeof metadata?.sourceNodeType === "string" && metadata.sourceNodeType.trim()) {
    normalized.sourceNodeType = metadata.sourceNodeType.trim();
  }

  if (isSourceMode(metadata?.sourceMode)) {
    normalized.sourceMode = metadata.sourceMode;
  }

  if (typeof metadata?.conditionalRuleId === "string" && metadata.conditionalRuleId.trim()) {
    normalized.conditionalRuleId = metadata.conditionalRuleId.trim();
  }

  if (typeof metadata?.trigger === "string" && metadata.trigger.trim()) {
    normalized.trigger = metadata.trigger.trim();
  }

  if (metadata?.runtimeInputPolicy === "answer_only" || metadata?.runtimeInputPolicy === "choice_only" || metadata?.runtimeInputPolicy === "directed_sharing") normalized.runtimeInputPolicy = metadata.runtimeInputPolicy;
  if (typeof metadata?.storyBoardEligible === "boolean") {
    normalized.storyBoardEligible = metadata.storyBoardEligible;
  }
  if (Number.isInteger(metadata?.textUnitEnd) && metadata!.textUnitEnd! >= 0) normalized.textUnitEnd = metadata!.textUnitEnd;
  if (typeof metadata?.textInteraction === "boolean") normalized.textInteraction = metadata.textInteraction;
  if (typeof metadata?.groupMatchingResult === "boolean") normalized.groupMatchingResult = metadata.groupMatchingResult;
  if (typeof metadata?.choiceId === "string") normalized.choiceId = metadata.choiceId;
  if (typeof metadata?.round === "number" && Number.isInteger(metadata.round)) normalized.round = metadata.round;
  if (typeof metadata?.groupMatchingDiscussion === "boolean") normalized.groupMatchingDiscussion = metadata.groupMatchingDiscussion;

  if (isNextAction(metadata?.next_action)) {
    normalized.next_action = metadata.next_action;
  }

  if (typeof metadata?.checkerFailedBeforeFallback === "boolean") {
    normalized.checkerFailedBeforeFallback = metadata.checkerFailedBeforeFallback;
  }

  if (metadata?.checkerFailureReasons) {
    normalized.checkerFailureReasons = cleanStringArray(metadata.checkerFailureReasons);
  }

  if (metadata?.checkerFailureViolations) {
    normalized.checkerFailureViolations = cleanStringArray(metadata.checkerFailureViolations);
  }

  return normalized;
}

function cleanStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function isDmSource(value: unknown): value is NonNullable<MessageMetadata["source"]> {
  return (
    value === "script_fixed" ||
    value === "script_guided" ||
    value === "system_fallback" ||
    value === "fallback_must_share" ||
    value === "conditional_rule"
  );
}

function isSourceMode(value: unknown): value is NonNullable<MessageMetadata["sourceMode"]> {
  return (
    value === "script_fixed" ||
    value === "script_guided" ||
    value === "system_fallback" ||
    value === "conditional_rule"
  );
}

function isNextAction(value: unknown): value is NonNullable<MessageMetadata["next_action"]> {
  return value === "advance_phase" || value === "wait_for_user" || value === "none";
}
