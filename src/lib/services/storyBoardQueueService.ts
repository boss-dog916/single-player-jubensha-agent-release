import "server-only";

import {
  createDeterministicStoryBoardPatch, createInternalPublicPatch,
  generateStoryBoardPatch
} from "@/src/lib/agents/storyBoardWriter";
import { prisma } from "@/src/lib/db/prisma";
import { RUNTIME_BASELINE } from "@/src/lib/env/runtimeBaseline";
import { runInTraceContext } from "@/src/lib/observability/traceContext";
import type { StoryBoardPatch, StoryBoardPatchItem } from "@/src/lib/schemas/storyBoardPatchSchema";
import {
  completeAgentRun,
  createAgentRun,
  failAgentRun,
  getAgentRun
} from "@/src/lib/services/agentRunService";
import { getGameSession } from "@/src/lib/services/gameService";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import { getMessageInGame } from "@/src/lib/services/messageService";
import { createEmptyPublicStoryBoard } from "@/src/lib/services/publicStoryBoardService";
import { isFormalPublicMessage, mergeStoryBoardPatch } from "@/src/lib/services/storyBoardService";
import type { Message, PublicStoryBoard } from "@/src/lib/types/game";

const maxAttempts = () => RUNTIME_BASELINE.storyBoardAttempts;
const STALE_CLAIM_MS = 5 * 60_000;
const drains = new Map<string, Promise<StoryBoardDrainResult>>();
const scheduledGames = new Set<string>();

type StoryBoardUpdateMode = "deterministic" | "llm";

export type StoryBoardEnqueueResult = {
  status: "pending" | "skipped" | "already_queued";
  mode: StoryBoardUpdateMode | null;
  immediatePatch: StoryBoardPatch | null;
  agentRunId: string | null;
  reason: string | null;
};

export type StoryBoardDrainResult = {
  processed: number;
  failed: number;
  remaining: number;
};

export async function enqueuePublicMessageForStoryBoard(input: {
  gameSessionId: string;
  message: Message;
}): Promise<StoryBoardEnqueueResult> {
  const stored = await getMessageInGame(input.gameSessionId, input.message.message_id);
  const skipReason = getSkipReason(stored);
  const session = await getGameSession(input.gameSessionId);
  const mode = skipReason ? null : selectUpdateMode(stored, session.publicStoryBoardEnabled);
  const immediatePatch = skipReason ? null : session.publicStoryBoardEnabled === false ? createInternalPublicPatch(stored) : buildImmediateStoryBoardPatch(stored);
  const run = await createAgentRun({
    gameSessionId: input.gameSessionId,
    runKind: "span",
    agentType: "story_board_update",
    actId: session.currentActId,
    phase: session.currentPhase,
    inputJson: {
      sourceMessageId: stored.message_id,
      triggered: !skipReason,
      mode,
      queuedAt: new Date().toISOString(),
      deltaSignals: summarizePatch(immediatePatch),
      skipReason
    }
  });

  const claimed = await prisma.message.updateMany({
    where: {
      id: stored.message_id,
      gameSessionId: input.gameSessionId,
      storyBoardStatus: "not_queued"
    },
    data: {
      storyBoardStatus: skipReason ? "skipped" : "pending",
      storyBoardAgentRunId: run.id,
      storyBoardError: skipReason,
      storyBoardProcessedAt: skipReason ? new Date() : null
    }
  });

  if (claimed.count === 0) {
    await completeAgentRun({
      agentRunId: run.id,
      outputJson: {
        triggered: false,
        skipped: true,
        reason: "message_already_queued",
        sourceMessageId: stored.message_id,
        compaction: false
      },
      latencyMs: Date.now() - run.startedAt.getTime()
    });
    return {
      status: "already_queued",
      mode: null,
      immediatePatch: null,
      agentRunId: null,
      reason: "message_already_queued"
    };
  }

  if (skipReason) {
    await completeAgentRun({
      agentRunId: run.id,
      outputJson: {
        triggered: false,
        skipped: true,
        reason: skipReason,
        sourceMessageId: stored.message_id,
        compaction: false
      },
      latencyMs: Date.now() - run.startedAt.getTime()
    });
    return {
      status: "skipped",
      mode: null,
      immediatePatch: null,
      agentRunId: run.id,
      reason: skipReason
    };
  }

  return {
    status: "pending",
    mode,
    immediatePatch,
    agentRunId: run.id,
    reason: null
  };
}

export function scheduleStoryBoardDrain(gameSessionId: string): void {
  if (scheduledGames.has(gameSessionId)) {
    return;
  }

  scheduledGames.add(gameSessionId);
  setTimeout(() => {
    scheduledGames.delete(gameSessionId);
    void drainStoryBoardUpdates(gameSessionId).catch((error) => {
      console.error("StoryBoard background drain failed", error);
    });
  }, 0);
}

export async function drainStoryBoardUpdates(
  gameSessionId: string
): Promise<StoryBoardDrainResult> {
  const existing = drains.get(gameSessionId);
  if (existing) {
    return existing;
  }

  const drain = runDrain(gameSessionId).finally(() => {
    drains.delete(gameSessionId);
  });
  drains.set(gameSessionId, drain);
  return drain;
}

async function runDrain(gameSessionId: string): Promise<StoryBoardDrainResult> {
  if (await (await import("./runtimeModelPolicy")).runtimeModelsDisabled(gameSessionId)) return { processed: 0, failed: 0, remaining: 0 };
  if (await (await import("./modelAvailabilityService")).getModelAvailability(gameSessionId)) return { processed: 0, failed: 0,
    remaining: await prisma.message.count({ where: { gameSessionId, storyBoardStatus: "pending" } }) };
  await prisma.message.updateMany({
    where: {
      gameSessionId,
      storyBoardStatus: "processing",
      storyBoardClaimedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
      storyBoardAttemptCount: { lt: maxAttempts() }
    },
    data: {
      storyBoardStatus: "pending",
      storyBoardClaimedAt: null,
      storyBoardError: "recovered_stale_claim"
    }
  });

  let processed = 0;
  let failed = 0;

  while (true) {
    if ((await prisma.gameSession.findUniqueOrThrow({ where: { id: gameSessionId }, select: { currentPhase: true } })).currentPhase === "finished") break;
    const next = await prisma.message.findFirst({
      where: {
        gameSessionId,
        storyBoardStatus: { in: ["pending", "failed"] },
        storyBoardAttemptCount: { lt: maxAttempts() }
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    if (!next) {
      break;
    }

    const claim = await prisma.message.updateMany({
      where: {
        id: next.id,
        storyBoardStatus: next.storyBoardStatus,
        storyBoardAttemptCount: next.storyBoardAttemptCount
      },
      data: {
        storyBoardStatus: "processing",
        storyBoardClaimedAt: new Date(),
        storyBoardAttemptCount: { increment: 1 },
        storyBoardError: null
      }
    });
    if (claim.count === 0) {
      continue;
    }

    try {
      await processClaimedMessage(gameSessionId, next.id, next.storyBoardStatus === "failed");
      processed += 1;
    } catch (error) {
      failed += 1;
      await markClaimFailed(next.id, error);
      if (await (await import("./modelAvailabilityService")).getModelAvailability(gameSessionId)) {
        await prisma.message.updateMany({ where: { id: next.id, storyBoardStatus: "failed", storyBoardAttemptCount: next.storyBoardAttemptCount + 1 },
          data: { storyBoardStatus: "pending", storyBoardAttemptCount: next.storyBoardAttemptCount, storyBoardClaimedAt: null } });
      }
      break;
    }
  }

  const remaining = await prisma.message.count({
    where: {
      gameSessionId,
      storyBoardStatus: { in: ["pending", "processing", "failed"] },
      storyBoardAttemptCount: { lt: maxAttempts() }
    }
  });
  return { processed, failed, remaining };
}

async function processClaimedMessage(
  gameSessionId: string,
  messageId: string,
  isRetry: boolean
): Promise<void> {
  const message = await getMessageInGame(gameSessionId, messageId);
  const session = await getGameSession(gameSessionId);
  const mode = selectUpdateMode(message, session.publicStoryBoardEnabled);
  let run = message.story_board_status === "processing" && !isRetry
    ? await getAgentRunForMessage(messageId)
    : null;

  if (!run || run.status !== "pending") {
    run = await createAgentRun({
      gameSessionId,
      runKind: "span",
      agentType: "story_board_update",
      actId: session.currentActId,
      phase: session.currentPhase,
      inputJson: {
        sourceMessageId: messageId,
        triggered: true,
        mode,
        retry: true,
        queuedAt: new Date().toISOString()
      }
    });
    await prisma.message.update({
      where: { id: messageId },
      data: { storyBoardAgentRunId: run.id }
    });
  }

  const startedAt = Date.now();
  try {
    const patch = mode === "deterministic"
      ? buildDeterministicPatch(message, session.publicStoryBoardEnabled === false)
      : (await runInTraceContext(
          { traceId: run.traceId ?? run.id, parentRunId: run.id },
          () => generateStoryBoardPatch({ session, latestMessage: message })
        )).patch;

    await prisma.$transaction(async (tx) => {
      const boardRecord = await tx.publicStoryBoard.findUnique({
        where: { gameSessionId }
      });
      const current = boardRecord
        ? fromJsonValue<PublicStoryBoard>(boardRecord.board, createEmptyPublicStoryBoard())
        : createEmptyPublicStoryBoard();
      const next = mergeStoryBoardPatch(current, patch, message, session.currentActId);

      await tx.publicStoryBoard.upsert({
        where: { gameSessionId },
        create: { gameSessionId, board: toJsonInput(next) },
        update: { board: toJsonInput(next) }
      });
      await tx.message.update({
        where: { id: messageId },
        data: {
          storyBoardStatus: "completed",
          storyBoardProcessedAt: new Date(),
          storyBoardClaimedAt: null,
          storyBoardError: null
        }
      });
    });

    await completeAgentRun({
      agentRunId: run.id,
      outputJson: {
        triggered: true,
        skipped: false,
        sourceMessageId: messageId,
        source: mode === "deterministic" ? "message_metadata" : "latest_public_message_llm",
        mode,
        delta: summarizePatch(patch),
        queueDelayMs: Math.max(0, startedAt - run.startedAt.getTime()),
        executionMs: Date.now() - startedAt,
        compaction: false
      },
      latencyMs: Date.now() - run.startedAt.getTime()
    });
  } catch (error) {
    await failAgentRun({
      agentRunId: run.id,
      error: "story_board_update_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      outputJson: {
        sourceMessageId: messageId,
        mode,
        compaction: false
      },
      latencyMs: Date.now() - run.startedAt.getTime()
    });
    throw error;
  }
}

async function getAgentRunForMessage(messageId: string) {
  const record = await prisma.message.findUnique({
    where: { id: messageId },
    select: { storyBoardAgentRunId: true }
  });
  return record?.storyBoardAgentRunId ? getAgentRun(record.storyBoardAgentRunId) : null;
}

async function markClaimFailed(messageId: string, error: unknown): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: {
      storyBoardStatus: "failed",
      storyBoardClaimedAt: null,
      storyBoardError: error instanceof Error ? error.message : String(error)
    }
  });
}

function getSkipReason(message: Message): string | null {
  if (!isFormalPublicMessage(message)) {
    return "not_formal_public_message";
  }
  const text = message.content.trim();
  if (
    /^(嗯+|哦+|好+的?|行|知道了|收到|谢谢|哈哈+|呵呵+|我?同意|继续|请继续|然后呢|DM问你呢|[.。!！?？…]+)$/i.test(text) ||
    /^[\p{L}\p{N}_]{1,8}(你说一下|你来说|请回答)$/u.test(text)
  ) {
    return "low_value_acknowledgement";
  }
  return null;
}

function selectUpdateMode(message: Message, enabled = true): StoryBoardUpdateMode {
  if (!enabled) return "deterministic";
  if (message.metadata.clueId && hasStructuredMetadata(message)) return "deterministic";
  if (message.speaker_type === "ai_player" && hasStructuredMetadata(message)) {
    return "deterministic";
  }
  if (message.speaker_type === "dm" && hasStructuredMetadata(message)) {
    return "deterministic";
  }
  return "llm";
}

function hasStructuredMetadata(message: Message): boolean {
  const metadata = message.metadata;
  return [
    metadata.revealed_facts,
    metadata.emotional_points,
    metadata.questions_raised,
    metadata.mentioned_role_ids,
    metadata.event_tags,
    metadata.topic_tags
  ].some((items) => items.length > 0);
}

export function buildImmediateStoryBoardPatch(message: Message): StoryBoardPatch {
  if (hasStructuredMetadata(message)) {
    return createDeterministicStoryBoardPatch(message);
  }

  return {
    ...emptyPatch(),
    discussed_questions_to_add: message.speech_act === "question"
      ? [{ text: message.content.trim(), evidenceMessageId: message.message_id }]
      : [],
    role_ids_involved: message.metadata.mentioned_role_ids
  };
}

export function buildDeterministicPatch(message: Message, internalOnly = false): StoryBoardPatch {
  const patch = internalOnly ? createInternalPublicPatch(message) : createDeterministicStoryBoardPatch(message);
  return {
    ...patch,
    known_facts_to_add: patch.known_facts_to_add.map((item) => ({
      ...item,
      text: attributeClaim(item.text, message)
    }))
  };
}

function attributeClaim(text: string, message: Message): string {
  if (/(公开|表示|声称|称|承认|据.+说)/.test(text)) {
    return text;
  }
  const speaker = message.speaker_name ?? message.speaker_role_id ?? "该角色";
  return `${speaker}公开表示：${text}`;
}

function emptyPatch(): StoryBoardPatch {
  return {
    known_facts_to_add: [],
    timeline_events_to_add: [],
    relationships_to_add: [],
    open_questions_to_add: [],
    contradictions_to_add: [],
    emotional_bonds_to_add: [],
    discussed_questions_to_add: [],
    current_conflicts_to_add: [],
    ignored_items: [],
    role_ids_involved: [],
    event_tags_added: [],
    topic_tags_added: []
  };
}

function summarizePatch(patch: StoryBoardPatch | null) {
  if (!patch) {
    return null;
  }
  const count = (items: StoryBoardPatchItem[]) => items.length;
  return {
    knownFacts: count(patch.known_facts_to_add),
    timeline: count(patch.timeline_events_to_add),
    relationships: count(patch.relationships_to_add),
    openQuestions: count(patch.open_questions_to_add),
    contradictions: count(patch.contradictions_to_add),
    emotionalBonds: count(patch.emotional_bonds_to_add),
    discussedQuestions: count(patch.discussed_questions_to_add),
    currentConflicts: count(patch.current_conflicts_to_add),
    ignored: patch.ignored_items.length,
    roleSignals: patch.role_ids_involved.length,
    eventSignals: patch.event_tags_added.length,
    topicSignals: patch.topic_tags_added.length
  };
}
