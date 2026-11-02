import "server-only";
import { withLlmPriority } from "@/src/lib/llm/concurrencyBudget";
import { withConversation, conversationStage, conversationCheckpoint } from "@/src/lib/services/conversationService";

import { runDmFlowStep } from "@/src/lib/agents/dmFlowRunner";
import { prisma } from "@/src/lib/db/prisma";
import { runAutoDiscussionAfterMessage } from "@/src/lib/orchestration/autoDiscussionRunner";
import { runInTraceContext } from "@/src/lib/observability/traceContext";
import {
  completeAgentRun,
  failAgentRun,
  getAgentRun
} from "@/src/lib/services/agentRunService";
import { getGameSession } from "@/src/lib/services/gameService";
import { getMessageInGame } from "@/src/lib/services/messageService";
import {
  buildImmediateStoryBoardPatch,
  enqueuePublicMessageForStoryBoard,
  scheduleStoryBoardDrain
} from "@/src/lib/services/storyBoardQueueService";
import type { Message } from "@/src/lib/types/game";

const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MS = 10 * 60_000;
const drains = new Map<string, Promise<PostShareDrainResult>>();
const scheduledGames = new Set<string>();

export type PostShareTaskStatus = "pending" | "running" | "completed" | "failed";

export type PostShareTaskView = {
  id: string;
  seedMessageId: string;
  sourceActId: string;
  sharedRoleId: string;
  hasMoreShares: boolean;
  nextRoleId: string | null;
  status: PostShareTaskStatus;
  attemptCount: number;
  triggeredAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  agentRunId: string | null;
};

export type PostShareDrainResult = {
  processed: number;
  failed: number;
  remaining: number;
};

type PostShareExecutionHooks = {
  runAutoDiscussion: typeof runAutoDiscussionAfterMessage;
  runDmFlow: typeof runDmFlowStep;
};

const defaultHooks: PostShareExecutionHooks = {
  runAutoDiscussion: runAutoDiscussionAfterMessage,
  runDmFlow: runDmFlowStep
};

let testHooks: Partial<PostShareExecutionHooks> | null = null;

export function setPostShareExecutionHooksForTests(
  hooks: Partial<PostShareExecutionHooks> | null
): void {
  testHooks = hooks;
}

export async function getLatestPostShareTask(
  gameSessionId: string
): Promise<PostShareTaskView | null> {
  const task = await prisma.postShareTask.findFirst({
    where: { gameSessionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });

  return task ? toTaskView(task) : null;
}

export async function hasActivePostShareTask(gameSessionId: string): Promise<boolean> {
  const count = await prisma.postShareTask.count({
    where: { gameSessionId, status: { in: ["pending", "running"] } }
  });

  return count > 0;
}

export function schedulePostShareTaskDrain(gameSessionId: string): void {
  if (scheduledGames.has(gameSessionId)) {
    return;
  }

  scheduledGames.add(gameSessionId);
  setTimeout(() => {
    scheduledGames.delete(gameSessionId);
    void drainPostShareTasks(gameSessionId).catch((error) => {
      console.error("Post-share background drain failed", error);
    });
  }, 0);
}

export async function drainPostShareTasks(
  gameSessionId: string
): Promise<PostShareDrainResult> {
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

async function runDrain(gameSessionId: string): Promise<PostShareDrainResult> {
  if (await (await import("./modelAvailabilityService")).getModelAvailability(gameSessionId)) return { processed: 0, failed: 0,
    remaining: await prisma.postShareTask.count({ where: { gameSessionId, status: "pending" } }) };
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  await prisma.postShareTask.updateMany({
    where: {
      gameSessionId,
      status: "running",
      claimedAt: { lt: staleBefore },
      attemptCount: { lt: MAX_ATTEMPTS }
    },
    data: {
      status: "pending",
      claimedAt: null,
      errorMessage: "recovered_stale_claim"
    }
  });
  await prisma.postShareTask.updateMany({
    where: {
      gameSessionId,
      status: "running",
      claimedAt: { lt: staleBefore },
      attemptCount: { gte: MAX_ATTEMPTS }
    },
    data: {
      status: "failed",
      completedAt: new Date(),
      errorMessage: "stale_claim_attempt_limit_reached"
    }
  });

  let processed = 0;
  let failed = 0;

  while (true) {
    const active = await prisma.postShareTask.count({
      where: { gameSessionId, status: "running" }
    });
    if (active > 0) {
      break;
    }

    const next = await prisma.postShareTask.findFirst({
      where: { gameSessionId, status: "pending", attemptCount: { lt: MAX_ATTEMPTS } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }]
    });
    if (!next) {
      break;
    }

    const claimedAt = new Date();
    try {
      const claim = await prisma.postShareTask.updateMany({
        where: {
          id: next.id,
          status: "pending",
          attemptCount: next.attemptCount
        },
        data: {
          status: "running",
          claimedAt,
          attemptCount: { increment: 1 },
          errorMessage: null
        }
      });
      if (claim.count === 0) {
        continue;
      }
    } catch {
      break;
    }

    const succeeded = await processClaimedTask(next.id);
    if (succeeded) {
      processed += 1;
    } else {
      failed += 1;
    }
    if (await (await import("./modelAvailabilityService")).getModelAvailability(gameSessionId)) break;
  }

  const remaining = await prisma.postShareTask.count({
    where: { gameSessionId, status: { in: ["pending", "running"] } }
  });

  return { processed, failed, remaining };
}

async function processClaimedTask(taskId: string): Promise<boolean> {
  const task = await prisma.postShareTask.findUniqueOrThrow({ where: { id: taskId } });
  const run = task.agentRunId ? await getAgentRun(task.agentRunId) : null;
  const hooks = { ...defaultHooks, ...testHooks };
  const executionStartedAt = Date.now();
  const errors: string[] = [];
  let stoppedReason: string | null = null;

  try {
    await withLlmPriority(1.5, () => runInTraceContext(
      {
        traceId: run?.traceId ?? run?.id ?? task.id,
        parentRunId: run?.id ?? task.id
      },
      async () => {
        const owned = await withConversation(task.gameSessionId, task.seedMessageId, async () => {
        const session = await getGameSession(task.gameSessionId);
        if (
          session.currentActId !== task.sourceActId ||
          session.currentPhase !== "share_round" ||
          session.currentShareIndex !== task.committedShareIndex
        ) {
          stoppedReason = "phase_or_cursor_changed";
          return;
        }

        const message = await getMessageInGame(task.gameSessionId, task.seedMessageId);
        if (message.story_board_status === "not_queued") {
          await enqueuePublicMessageForStoryBoard({
            gameSessionId: task.gameSessionId,
            message
          }).catch((error) => errors.push(toErrorMessage("storyboard_enqueue", error)));
        }

        await hooks
          .runAutoDiscussion({
            gameId: task.gameSessionId,
            seedMessageId: task.seedMessageId,
            latestStoryBoardPatch: buildImmediateStoryBoardPatch(message)
          })
          .catch((error) => errors.push(toErrorMessage("share_auto_discussion", error)));

        if (!await currentTaskClaim(task)) { stoppedReason = "claim_lost"; return; }
        const interruption = await conversationCheckpoint(task.gameSessionId);
        if (interruption.changed && interruption.seedMessageId) await hooks.runAutoDiscussion({
          gameId: task.gameSessionId, seedMessageId: interruption.seedMessageId });

        await conversationStage("dm");
        if (!task.hasMoreShares) {
          const advanced = await prisma.gameSession.updateMany({
            where: {
              id: task.gameSessionId,
              currentActId: task.sourceActId,
              currentPhase: "share_round",
              currentShareIndex: task.committedShareIndex
            },
            data: {
              currentPhase: "free_discussion",
              currentShareIndex: task.sourceShareIndex,
              discussionTurnCount: 0
            }
          });
          if (advanced.count === 0) {
            stoppedReason = "phase_or_cursor_changed";
            return;
          }
        }

        const dmResult = await hooks
          .runDmFlow({
            gameSessionId: task.gameSessionId,
            trigger: task.hasMoreShares ? "before_next_share" : "all_shares_completed",
            targetRoleId: task.hasMoreShares ? task.nextRoleId : undefined,
            nextAction: "wait_for_user"
          })
          .catch((error) => {
            errors.push(toErrorMessage("dm_followup", error));
            return null;
          });
        const dmMessage = dmResult?.autoExecutedMessage ?? dmResult?.message ?? null;
        if (!await currentTaskClaim(task)) { stoppedReason = "claim_lost"; return; }

        if (dmMessage && shouldAutoReactToDmMessage(dmMessage)) {
          await hooks
            .runAutoDiscussion({
              gameId: task.gameSessionId,
              seedMessageId: dmMessage.message_id
            })
            .catch((error) => errors.push(toErrorMessage("dm_auto_discussion", error)));
        }
        });
        if (owned === null) throw new Error("conversation_claim_unavailable");
      }
    ));
  } catch (error) {
    errors.push(toErrorMessage("post_share_task", error));
  }

  if (!await currentTaskClaim(task)) return false;
  if (!task.hasMoreShares) {
    await ensureFinalSharePhase(task).catch((error) => {
      errors.push(toErrorMessage("final_share_phase_recovery", error));
    });
  }

  const completedAt = new Date();
  const interaction = run?.traceId ? await getAgentRun(run.traceId) : null;
  const runInput = run?.inputJson as { shareVisibleRunId?: string } | null;
  const visibleRun = runInput?.shareVisibleRunId ? await getAgentRun(runInput.shareVisibleRunId) : null;
  const firstFollowup = await prisma.message.findFirst({
    where: {
      gameSessionId: task.gameSessionId,
      id: { not: task.seedMessageId },
      createdAt: { gte: task.createdAt },
      speakerType: { in: ["ai_player", "dm"] },
      speechAct: { notIn: ["share", "system", "notice"] }
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }]
  });
  const visibleAt = visibleRun?.finishedAt ?? task.createdAt;
  const output = {
    seedMessageId: task.seedMessageId,
    sharedRoleId: task.sharedRoleId,
    triggeredAt: task.createdAt.toISOString(),
    claimedAt: task.claimedAt?.toISOString() ?? null,
    completedAt: completedAt.toISOString(),
    nextActionReadyLatencyMs: interaction || visibleRun
      ? completedAt.getTime() - (interaction ?? visibleRun)!.startedAt.getTime() : null,
    firstPostShareMessageLatencyMs: firstFollowup ? Math.max(0, firstFollowup.createdAt.getTime() - visibleAt.getTime()) : null,
    firstPostShareMessageId: firstFollowup?.id ?? null,
    queueDelayMs: Math.max(0, executionStartedAt - task.createdAt.getTime()),
    executionLatencyMs: Date.now() - executionStartedAt,
    postShareDiscussionLatencyMs: Date.now() - task.createdAt.getTime(),
    stoppedReason,
    errors
  };
  const succeeded = errors.length === 0;
  const paused = await (await import("./modelAvailabilityService")).getModelAvailability(task.gameSessionId);

  const finished = await prisma.postShareTask.updateMany({
    where: { id: task.id, status: "running", claimedAt: task.claimedAt, attemptCount: task.attemptCount },
    data: {
      status: paused ? "pending" : succeeded ? "completed" : "failed",
      completedAt: paused ? null : completedAt,
      ...(paused ? { attemptCount: Math.max(0, task.attemptCount - 1) } : {}),
      claimedAt: null,
      errorMessage: succeeded ? null : errors.join(" | ")
    }
  });
  if (!finished.count) return false;

  if (run) {
    if (succeeded) {
      await completeAgentRun({
        agentRunId: run.id,
        outputJson: output,
        latencyMs: Date.now() - run.startedAt.getTime()
      });
    } else {
      await failAgentRun({
        agentRunId: run.id,
        error: "post_share_discussion_failed",
        errorMessage: errors.join(" | "),
        outputJson: output,
        latencyMs: Date.now() - run.startedAt.getTime()
      });
    }
  }

  scheduleStoryBoardDrain(task.gameSessionId);
  return succeeded;
}

async function ensureFinalSharePhase(task: {
  id: string;
  claimedAt: Date | null;
  attemptCount: number;
  gameSessionId: string;
  sourceActId: string;
  sourceShareIndex: number;
  committedShareIndex: number;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
  const ownsClaim = await tx.postShareTask.count({ where: { id: task.id, status: "running",
    claimedAt: task.claimedAt, attemptCount: task.attemptCount } });
  const conversation = await tx.conversationState.findUnique({ where: { gameSessionId: task.gameSessionId } });
  if (!ownsClaim || conversation && ["running", "pending"].includes(conversation.status) ||
    await tx.pendingUserTurn.count({ where: { gameSessionId: task.gameSessionId, status: "queued" } })) return;
  await tx.gameSession.updateMany({
    where: {
      id: task.gameSessionId,
      currentActId: task.sourceActId,
      currentPhase: "share_round",
      currentShareIndex: task.committedShareIndex
    },
    data: {
      currentPhase: "free_discussion",
      currentShareIndex: task.sourceShareIndex,
      discussionTurnCount: 0
    }
  });
  });
}

async function currentTaskClaim(task: { id: string; claimedAt: Date | null; attemptCount: number }) {
  return await prisma.postShareTask.count({ where: { id: task.id, status: "running",
    claimedAt: task.claimedAt, attemptCount: task.attemptCount } }) === 1;
}

function shouldAutoReactToDmMessage(message: Message): boolean {
  return (
    message.speaker_type === "dm" &&
    (message.speech_act === "dm_directed_question" ||
      message.speech_act === "group_question" ||
      message.speech_act === "dm_prompt" ||
      (message.speech_act === "question" && (message.target_role_ids ?? []).length > 0) ||
      /[?？]|你怎么看|怎么看|你觉得|觉得呢|要不要|有没有|注意到|想问|补充|说说|说一下|聊聊|回答|回应|请.+说|请.+答|.+呢/.test(
        message.content
      ))
  );
}

function toTaskView(task: {
  id: string;
  seedMessageId: string;
  sourceActId: string;
  sharedRoleId: string;
  hasMoreShares: boolean;
  nextRoleId: string | null;
  status: string;
  attemptCount: number;
  createdAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  agentRunId: string | null;
}): PostShareTaskView {
  return {
    id: task.id,
    seedMessageId: task.seedMessageId,
    sourceActId: task.sourceActId,
    sharedRoleId: task.sharedRoleId,
    hasMoreShares: task.hasMoreShares,
    nextRoleId: task.nextRoleId,
    status: task.status as PostShareTaskStatus,
    attemptCount: task.attemptCount,
    triggeredAt: task.createdAt.toISOString(),
    claimedAt: task.claimedAt?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    errorMessage: task.errorMessage,
    agentRunId: task.agentRunId
  };
}

function toErrorMessage(stage: string, error: unknown): string {
  return `${stage}: ${error instanceof Error ? error.message : String(error)}`;
}
