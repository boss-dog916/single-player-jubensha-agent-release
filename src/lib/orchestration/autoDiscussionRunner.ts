import { withOptionalResponse, getResponseDeliveries, responseKey, settleFailedDMResponse } from "../services/responseDelivery";
import "server-only";
import { withConversation, conversationCheckpoint, coalescedSeed, conversationStage,
  syncCommittedUserStoryBoard, deferConversationSeed } from "@/src/lib/services/conversationService";
import { withLlmPriority } from "@/src/lib/llm/concurrencyBudget";

import { runDmFlowStep } from "@/src/lib/agents/dmFlowRunner";
import {
  executeSelectedReactions,
  planDiscussionReactions,
  type DiscussionReactionPlan,
  type ExecuteSelectedReactionsResult
} from "@/src/lib/orchestration/discussionOrchestrator";
import type { ReactionIntent } from "@/src/lib/schemas/reactionIntentSchema";
import type { StoryBoardPatch } from "@/src/lib/schemas/storyBoardPatchSchema";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { completeAgentRun, createAgentRun, failAgentRun, listRecentAgentRuns } from "@/src/lib/services/agentRunService";
import { getGameSession, updateGameSession } from "@/src/lib/services/gameService";
import { handlePostPublicMessageFlow } from "@/src/lib/services/dmFlowCursorService";
import { getMessageInGame } from "@/src/lib/services/messageService";
import { prisma } from "@/src/lib/db/prisma";
import { getScriptRuntimeDefinition } from "@/src/lib/services/scriptRuntimeDefinitionService";
import type { GamePhase, Message } from "@/src/lib/types/game";
import { discussionPacing, isActualDiscussionQuestion } from "@/src/lib/services/discussionPacing";

export type DiscussionExecutionMode = "manual_debug" | "auto_play";

export type AutoDiscussionBudget = {
  maxReactionWaves: number;
  maxTotalAiReplies: number;
  maxRepliesPerWave: number;
  minRelevanceScore: number;
  allowFollowupAfterAiReply: boolean;
  shouldCloseWithDm: boolean;
};

export type AutoDiscussionStopReason =
  | "manual_debug"
  | "already_processed"
  | "not_public_message"
  | "phase_not_supported"
  | "max_waves_reached"
  | "max_ai_replies_reached"
  | "no_relevant_candidates"
  | "scheduler_selected_none"
  | "dm_should_close"
  | "all_candidates_blocked"
  | "share_round_single_wave_done"
  | "phase_changed"
  | "low_value_replies"
  | "user_input_expected"
  | "user_input_pending";

export type AutoDiscussionWave = {
  waveIndex: number;
  seedMessageId: string;
  phase: GamePhase;
  selectedReactions: ReactionIntent[];
  createdMessageIds: string[];
  blockedCount: number;
  stopReason?: AutoDiscussionStopReason;
};

export type AutoDiscussionResult = {
  mode: DiscussionExecutionMode;
  seedMessageId: string;
  phase: GamePhase;
  budget: AutoDiscussionBudget;
  waves: AutoDiscussionWave[];
  totalAiReplies: number;
  stopReason: AutoDiscussionStopReason;
  dmCloseTriggered: boolean;
  deferredSeedMessageId?: string;
  dmCloseMessageId?: string | null;
};

export async function runAutoDiscussionAfterMessage(input: {
  gameId: string;
  seedMessageId: string;
  mode?: DiscussionExecutionMode;
  budget?: Partial<AutoDiscussionBudget>;
  latestStoryBoardPatch?: StoryBoardPatch | null;
}): Promise<AutoDiscussionResult> {
  if (await (await import("@/src/lib/services/runtimeModelPolicy")).runtimeModelsDisabled(input.gameId)) {
    const seed = await getMessageInGame(input.gameId, input.seedMessageId);
    return emptyResult(input.mode ?? "auto_play", seed, getBudgetForPhase(seed.phase), "already_processed");
  }
  await (await import("@/src/lib/services/modelAvailabilityService")).assertModelAvailable(input.gameId);
  const seedForPolicy = await getMessageInGame(input.gameId, input.seedMessageId);
  const optionalPlanning = ["user", "ai_player"].includes(seedForPolicy.speaker_type) && isActualDiscussionQuestion(seedForPolicy);
  const result = await withConversation(input.gameId, input.seedMessageId, async () => {
    if (!optionalPlanning) return runInterruptibleDiscussion(input);
    const failures = await prisma.agentRun.findMany({ where: { gameSessionId: input.gameId, agentType: "auto_discussion_runner",
      status: "failed", OR: [{ errorMessage: { contains: "reaction_planner_failed:" } }, { errorMessage: { contains: "addressing_conflict:" } }] }, select: { input: true } });
    const prior = failures.filter(r => JSON.parse(r.input || "{}").seedMessageId === input.seedMessageId).length;
    for (let attempt = prior; attempt < 2; attempt++) {
      try { return await withOptionalResponse(() => runInterruptibleDiscussion(input)); }
      catch (error) {
        if (!(error instanceof Error) || !(/reaction_planner_failed:|addressing_conflict:/.test(error.message)) ||
          await (await import("../services/modelAvailabilityService")).getModelAvailability(input.gameId)) throw error;
        const interrupt = await conversationCheckpoint(input.gameId);
        if (interrupt.changed && interrupt.seedMessageId && interrupt.seedMessageId !== input.seedMessageId) {
          await deferConversationSeed(input.gameId, interrupt.seedMessageId);
          return { ...emptyResult(input.mode ?? "auto_play", seedForPolicy, getBudgetForPhase(seedForPolicy.phase), "user_input_pending"),
            deferredSeedMessageId: interrupt.seedMessageId };
        }
      }
    }
    const run = await createAgentRun({ gameSessionId: input.gameId, agentType: "response_planning_skipped", runKind: "span",
      actId: seedForPolicy.metadata.act_id, phase: seedForPolicy.phase, inputJson: { seedMessageId: input.seedMessageId } });
    await completeAgentRun({ agentRunId: run.id, outputJson: { outcome: "unanswered_skipped", reason: "Planner initial and retry both failed; no public answer fabricated" } });
    return emptyResult(input.mode ?? "auto_play", seedForPolicy, getBudgetForPhase(seedForPolicy.phase), "all_candidates_blocked");
  });
  if (result) return result;
  const seed = await getMessageInGame(input.gameId, input.seedMessageId);
  return emptyResult(input.mode ?? "auto_play", seed, getBudgetForPhase(seed.phase), "already_processed");
}

async function runInterruptibleDiscussion(input: {
  gameId: string; seedMessageId: string; mode?: DiscussionExecutionMode; budget?: Partial<AutoDiscussionBudget>; latestStoryBoardPatch?: StoryBoardPatch | null;
}): Promise<AutoDiscussionResult> {
  const startedAt = Date.now();
  const [initialSession, savedSeedMessage] = await Promise.all([
    getGameSession(input.gameId),
    getMessageInGame(input.gameId, input.seedMessageId)
  ]);
  const initialCheckpoint = await conversationCheckpoint(input.gameId);
  const requestedSeed = initialCheckpoint.changed && initialCheckpoint.seedMessageId
    ? await getMessageInGame(input.gameId, initialCheckpoint.seedMessageId) : savedSeedMessage;
  const mode = input.mode ?? getDiscussionExecutionMode(initialSession);
  const pendingResponse = mode === "auto_play" ? await getPendingResponse(input.gameId) : null;
  const definition = initialSession.runtimeDefinitionId ? await getScriptRuntimeDefinition(initialSession.runtimeDefinitionId) : null;
  const scopedFollowup = (await import("../services/publicDiscussionContext")).currentDMInteraction(initialSession, await (await import("../services/messageService")).listMessages(input.gameId), requestedSeed);
  const performance = discussionPacing(initialSession, definition?.definition).mode === "dm_performance" || scopedFollowup?.kind === "player_followup";
  const prioritizeQuestion = pendingResponse && pendingResponse.attempts < 2 && Date.now() < pendingResponse.deadline;
  const seedMessage = prioritizeQuestion ? pendingResponse.message : requestedSeed;
  let deferredUserSeed = seedMessage.message_id !== requestedSeed.message_id && requestedSeed.speaker_type === "user" ? requestedSeed.message_id : null;
  const base = getBudgetForPhase(seedMessage.phase);
  const budget = { ...base, ...input.budget,
    maxReactionWaves: Math.min(base.maxReactionWaves, input.budget?.maxReactionWaves ?? base.maxReactionWaves),
    maxTotalAiReplies: Math.min(base.maxTotalAiReplies, input.budget?.maxTotalAiReplies ?? base.maxTotalAiReplies),
    maxRepliesPerWave: Math.min(base.maxRepliesPerWave, input.budget?.maxRepliesPerWave ?? base.maxRepliesPerWave) };
  if (performance) Object.assign(budget, { maxReactionWaves: 1, allowFollowupAfterAiReply: false, shouldCloseWithDm: false });
  const runnerRun = await createAgentRun({
    gameSessionId: input.gameId,
    agentType: "auto_discussion_runner",
    actId: initialSession.currentActId,
    phase: initialSession.currentPhase,
    inputJson: {
      seedMessageId: input.seedMessageId,
      seedMessage: compactMessage(seedMessage),
      conversationRevision: initialCheckpoint.revision,
      conversationMode: seedMessage.phase === "share_round" ? "POST_SHARE_REACTION" : seedMessage.speaker_type === "dm" ? "DM_TRIGGERED_DISCUSSION" : "FREE_DISCUSSION",
      mode,
      budget
    }
  });

  try {
    if (mode === "manual_debug") {
      await planDiscussionReactions({
        gameSessionId: input.gameId,
        latestMessageId: seedMessage.message_id,
        latestStoryBoardPatch: input.latestStoryBoardPatch
      });

      return completeRunner({
        agentRunId: runnerRun.id,
        startedAt,
        result: emptyResult(mode, seedMessage, budget, "manual_debug")
      });
    }

    if (pendingResponse?.message.message_id === seedMessage.message_id && !prioritizeQuestion) {
      return completeRunner({ agentRunId: runnerRun.id, startedAt,
        result: emptyResult(mode, seedMessage, budget, "all_candidates_blocked") });
    }
    if (seedMessage.metadata.groupMatchingDiscussion &&
      (seedMessage.metadata.act_id !== initialSession.currentActId || seedMessage.metadata.runtimeDefinitionId !== initialSession.runtimeDefinitionId ||
        seedMessage.metadata.sourceNodeId !== initialSession.dmFlowCursor?.nodeId ||
        initialSession.dmFlowCursor?.completedNodeIds.includes(seedMessage.metadata.sourceNodeId ?? ""))) {
      return completeRunner({ agentRunId: runnerRun.id, startedAt,
        result: emptyResult(mode, seedMessage, budget, "phase_changed") });
    }
    if (await hasProcessedSeedMessage(input.gameId, seedMessage.message_id, discussionPacing(initialSession, definition?.definition).matchingDiscussion)) {
      return completeRunner({
        agentRunId: runnerRun.id,
        startedAt,
        result: emptyResult(mode, seedMessage, budget, "already_processed")
      });
    }

    if (!canTriggerAutoDiscussion(seedMessage)) {
      return completeRunner({
        agentRunId: runnerRun.id,
        startedAt,
        result: emptyResult(mode, seedMessage, budget, "not_public_message")
      });
    }

    if (!isAutoDiscussionSupportedPhase(seedMessage.phase)) {
      return completeRunner({
        agentRunId: runnerRun.id,
        startedAt,
        result: emptyResult(mode, seedMessage, budget, "phase_not_supported")
      });
    }

    const waves: AutoDiscussionWave[] = [];
    const recentAiSpeakers = new Set<RoleId>();
    let latestMessage = seedMessage;
    let latestCreatedPublicMessage: Message | null = null;
    const followupQuestions: Message[] = [];
    let followupChosen = false;
    let totalAiReplies = 0;
    let noSignalWaveCount = 0;
    let stopReason: AutoDiscussionStopReason | null = null;

    for (let waveIndex = 1; waveIndex <= budget.maxReactionWaves; waveIndex += 1) {
      const beforePlan = await conversationCheckpoint(input.gameId);
      if (beforePlan.changed && beforePlan.seedMessageId) {
        if (pendingResponse?.message.message_id === latestMessage.message_id) deferredUserSeed = beforePlan.seedMessageId;
        else latestMessage = await getMessageInGame(input.gameId, beforePlan.seedMessageId);
      }
      await syncCommittedUserStoryBoard(input.gameId);
      const session = await getGameSession(input.gameId);

      if (!isAutoDiscussionSupportedPhase(session.currentPhase)) {
        stopReason = "phase_changed";
        break;
      }

      if (totalAiReplies >= budget.maxTotalAiReplies && beforePlan.changed && beforePlan.seedMessageId) {
        await deferConversationSeed(input.gameId, beforePlan.seedMessageId);
        return completeRunner({ agentRunId: runnerRun.id, startedAt, result: {
          ...emptyResult(mode, seedMessage, budget, "user_input_pending"), waves, totalAiReplies, deferredSeedMessageId: beforePlan.seedMessageId } });
      }
      if (totalAiReplies >= budget.maxTotalAiReplies) {
        stopReason = "max_ai_replies_reached";
        break;
      }

      const combinedSeed = await coalescedSeed(input.gameId, latestMessage.message_id);
      const plan = await withLlmPriority(latestMessage.speaker_type === "user" ? 0 : 1.5, () => planDiscussionReactions({
        gameSessionId: input.gameId,
        latestMessageId: latestMessage.message_id,
        latestStoryBoardPatch: waveIndex === 1 ? input.latestStoryBoardPatch : null,
        schedulerOptions: {
          maxAiReactionsPerTrigger: budget.maxRepliesPerWave,
          minRelevanceScore: budget.minRelevanceScore
        },
        latestMessageOverride: combinedSeed
      }));
      const afterPlan = await conversationCheckpoint(input.gameId);
      if (afterPlan.changed && afterPlan.seedMessageId) {
        if (pendingResponse?.message.message_id === latestMessage.message_id) deferredUserSeed = afterPlan.seedMessageId;
        else latestMessage = await getMessageInGame(input.gameId, afterPlan.seedMessageId);
        waveIndex -= 1;
        continue;
      }

      if (plan.schedulerResult.should_dm_intervene) {
        stopReason = "dm_should_close";
        waves.push(toSkippedWave(waveIndex, latestMessage, plan, "dm_should_close"));
        break;
      }

      const selectedReactions = filterAutoSelectedReactions({
        plan,
        latestMessage,
        recentAiSpeakers,
        remainingReplyBudget: budget.maxTotalAiReplies - totalAiReplies,
        maxRepliesPerWave: waveIndex > 1 ? 1 : budget.maxRepliesPerWave
      });

      if (selectedReactions.length === 0) {
        stopReason =
          plan.reactionIntents.length === 0 ? "no_relevant_candidates" : "scheduler_selected_none";
        waves.push(toSkippedWave(waveIndex, latestMessage, plan, stopReason));
        break;
      }

      const execution = await withLlmPriority(latestMessage.speaker_type === "user" ? 0 : 1.5, () => executeSelectedReactions({
        gameSessionId: input.gameId,
        latestMessageId: latestMessage.message_id,
        selectedReactions,
        conversationRevision: afterPlan.revision,
        responseDeadlineMs: pendingResponse?.message.message_id === latestMessage.message_id ? pendingResponse.deadline : undefined
      }));
      const createdMessageIds = execution.createdMessages.map((message) => message.message_id);
      if (!followupChosen && !performance) {
        const question = execution.createdMessages.find(m => isActualDiscussionQuestion(m));
        if (question) { followupQuestions.push(question); followupChosen = true; }
      }
      latestCreatedPublicMessage = execution.createdMessages.at(-1) ?? latestCreatedPublicMessage;

      totalAiReplies += execution.createdMessages.length;
      waves.push({
        waveIndex,
        seedMessageId: latestMessage.message_id,
        phase: latestMessage.phase,
        selectedReactions,
        createdMessageIds,
        blockedCount: execution.blockedReactions.length
      });
      const interrupt = await conversationCheckpoint(input.gameId);
      if ((interrupt.changed && interrupt.seedMessageId) || deferredUserSeed) {
        const nextSeed = interrupt.seedMessageId ?? deferredUserSeed!;
        // Runtime human input ends this batch even when AI followup budget
        // remains. Keep the demo runner's existing inline replan contract.
        if (initialSession.runtimeDefinitionId || deferredUserSeed || waveIndex >= budget.maxReactionWaves || totalAiReplies >= budget.maxTotalAiReplies) {
          await deferConversationSeed(input.gameId, nextSeed);
          return completeRunner({ agentRunId: runnerRun.id, startedAt, result: {
            ...emptyResult(mode, seedMessage, budget, "user_input_pending"), waves, totalAiReplies, deferredSeedMessageId: nextSeed } });
        }
        latestMessage = await getMessageInGame(input.gameId, nextSeed);
        recentAiSpeakers.clear();
        followupQuestions.length = 0;
        continue;
      }
      if (pendingResponse?.message.message_id === latestMessage.message_id && execution.createdMessages.length === 0) {
        const delivery = (await getResponseDeliveries(input.gameId)).get(responseKey(latestMessage.message_id, pendingResponse.roleId));
        if (!delivery?.skipped && Date.now() < pendingResponse.deadline) {
          await deferConversationSeed(input.gameId, latestMessage.message_id);
          return completeRunner({ agentRunId: runnerRun.id, startedAt, result: {
            ...emptyResult(mode, seedMessage, budget, "user_input_pending"), waves, totalAiReplies, deferredSeedMessageId: latestMessage.message_id } });
        }
      }

      if (execution.createdMessages.length === 0) {
        stopReason = "all_candidates_blocked";
        break;
      }

      // One verification question gets its answer, then the floor returns to
      // the human/DM even if the answer itself contains another invitation.
      if (latestMessage.phase !== "share_round" && latestMessage.speaker_type === "ai_player" && isActualDiscussionQuestion(latestMessage)) {
        stopReason = "user_input_expected";
        break;
      }

      if (!hasNewDiscussionSignal(execution)) {
        noSignalWaveCount += 1;
      } else {
        noSignalWaveCount = 0;
      }

      if (noSignalWaveCount >= 2) {
        stopReason = "low_value_replies";
        break;
      }

      recentAiSpeakers.clear();
      execution.createdMessages.forEach((message) => {
        if (message.speaker_role_id && message.speaker_role_id !== "dm" && message.speaker_role_id !== "system") {
          recentAiSpeakers.add(message.speaker_role_id);
        }
      });

      if (latestMessage.phase === "share_round") {
        stopReason = "share_round_single_wave_done";
        break;
      }

      if (!budget.allowFollowupAfterAiReply) {
        stopReason = "user_input_expected";
        break;
      }

      // A performance's authored question gets its answer, then awaits the
      // human confirmation. Continue only an actual followup question, not a
      // new round of incidental commentary on every fixed DM line.
      if (initialSession.runtimeDefinitionId && seedMessage.speaker_type === "dm" && followupQuestions.length === 0) {
        stopReason = "user_input_expected";
        break;
      }

      latestMessage = followupQuestions.shift() ?? execution.createdMessages.at(-1) ?? latestMessage;
    }

    if (!stopReason) {
      stopReason =
        totalAiReplies >= budget.maxTotalAiReplies ? "max_ai_replies_reached" : "max_waves_reached";
    }

    await conversationStage("dm");
    const closeResult = await maybeRunDmDiscussionClose({
      gameId: input.gameId,
      phase: seedMessage.phase,
      reason: stopReason,
      budget,
      waves
    });
    const afterClose = await conversationCheckpoint(input.gameId);
    if (afterClose.changed && afterClose.seedMessageId) await deferConversationSeed(input.gameId, afterClose.seedMessageId);
    const latestForPostFlow = latestCreatedPublicMessage ?? seedMessage;

    if (!afterClose.changed && closeResult.messageId) {
      const current = await getGameSession(input.gameId);
      const question = current.dmFlowCursor?.pendingDMQuestion;
      if (question?.textInteraction && question.status === "waiting" && question.messageId === closeResult.messageId) {
        await runAutoDiscussionAfterMessage({ gameId: input.gameId, seedMessageId: question.messageId, mode });
      }
    }

    if (!afterClose.changed && !closeResult.triggered && latestForPostFlow.speaker_type !== "dm") {
      await conversationStage("dm");
      const postFlowResult = await handlePostPublicMessageFlow({
        gameId: input.gameId,
        latestMessageId: latestForPostFlow.message_id
      });

      if (postFlowResult?.autoDiscussionSeedMessageId) {
        await runAutoDiscussionAfterMessage({
          gameId: input.gameId,
          seedMessageId: postFlowResult.autoDiscussionSeedMessageId,
          mode
        });
      }
    }

    return completeRunner({
      agentRunId: runnerRun.id,
      startedAt,
      result: {
        mode,
        seedMessageId: seedMessage.message_id,
        phase: seedMessage.phase,
        budget,
        waves,
        totalAiReplies,
        stopReason,
        dmCloseTriggered: closeResult.triggered,
        dmCloseMessageId: closeResult.messageId
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Auto discussion runner failed.";

    await failAgentRun({
      agentRunId: runnerRun.id,
      error: "auto_discussion_failed",
      errorMessage: message,
      latencyMs: Date.now() - startedAt
    });

    if (pendingResponse?.message.message_id === seedMessage.message_id) {
      const current = await getGameSession(input.gameId);
      const question = current.dmFlowCursor?.pendingDMQuestion;
      if (question?.messageId === seedMessage.message_id) {
        const paused = await (await import("@/src/lib/services/modelAvailabilityService")).getModelAvailability(input.gameId);
        await updateGameSession(input.gameId, { dmFlowCursor: { ...current.dmFlowCursor!,
          pendingDMQuestion: { ...question, responseLastError: message,
            ...(paused ? { responseAttempts: Math.max(0, (question.responseAttempts ?? 0) - 1) } : {}) } } });
        const interrupt = await conversationCheckpoint(input.gameId);
        if (((question.responseAttempts ?? 0) === 1 && Date.now() < pendingResponse.deadline) || interrupt.changed || deferredUserSeed) {
          await deferConversationSeed(input.gameId, interrupt.seedMessageId ?? deferredUserSeed ?? seedMessage.message_id);
        }
      }
    }
    throw error;
  }
}

// Reuse the authored pending question, durable attempt count and public reply
// receipts. This is not a second queue: at most initial + one recovery, bounded
// by the question's existing authored deadline (including model queue time).
async function getPendingResponse(gameId: string) {
  const session = await getGameSession(gameId), question = session.dmFlowCursor?.pendingDMQuestion;
  if (!session.runtimeDefinitionId || !question || !["waiting", "partial_answered"].includes(question.status) ||
    question.targetRoleNames.length !== 1 || !session.aiRoleIds.includes(question.targetRoleNames[0])) return null;
  if (await prisma.message.count({ where: { gameSessionId: gameId, speakerType: "ai_player",
    speakerRoleId: question.targetRoleNames[0], replyToMessageId: question.messageId } })) return null;
  const roleId = question.targetRoleNames[0];
  if ((await getResponseDeliveries(gameId)).get(responseKey(question.messageId, roleId))?.skipped) {
    await settleFailedDMResponse(gameId, question.messageId, roleId);
    return null;
  }
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const node = view.definition.dmFlow?.actFlows.find(flow => flow.actIndex === question.actIndex)?.nodes.find(node => node.nodeId === question.nodeId);
  const waitMs = node?.discussionExit?.questionWaitMs ?? node?.textExecution?.wait?.maxWaitMs;
  if (!waitMs) return null;
  const message = await getMessageInGame(gameId, question.messageId);
  if (message.metadata.act_id !== session.currentActId || message.phase !== session.currentPhase) return null;
  return { message, roleId, attempts: question.responseAttempts ?? 0, deadline: Date.parse(question.askedAt) + waitMs };
}

export function getDiscussionExecutionMode(session: {
  testMode?: boolean;
  runtimeDefinitionId?: string | null;
  runtimeScope?: unknown | null;
}): DiscussionExecutionMode {
  const explicitMode = (session.runtimeScope as { runtimeMode?: string } | null)?.runtimeMode;
  if (explicitMode === "runtime_manual_debug") return "manual_debug";
  if (isRecord(session.runtimeScope) && session.runtimeScope.autoAiReactions === false) {
    return "manual_debug";
  }

  return session.testMode || session.runtimeDefinitionId ? "auto_play" : "manual_debug";
}

export function getBudgetForPhase(phase: GamePhase): AutoDiscussionBudget {
  // A discussion in the local trial needs the same answer opportunities as
  // ordinary play. Bounds still prevent an unattended conversation loop.
  if (phase === "dm_question") return {
    maxReactionWaves: 3, maxTotalAiReplies: 7, maxRepliesPerWave: 5, minRelevanceScore: 4,
    allowFollowupAfterAiReply: true, shouldCloseWithDm: false
  };
  if (phase === "share_round") {
    return {
      maxReactionWaves: 2,
      maxTotalAiReplies: 2,
      maxRepliesPerWave: 2,
      minRelevanceScore: 5,
      allowFollowupAfterAiReply: false,
      shouldCloseWithDm: false
    };
  }

  return {
    maxReactionWaves: 3,
    maxTotalAiReplies: 7,
    maxRepliesPerWave: 5,
    minRelevanceScore: 4,
    allowFollowupAfterAiReply: true,
    shouldCloseWithDm: true
  };
}

function isAutoDiscussionSupportedPhase(phase: GamePhase): boolean {
  return phase === "share_round" || phase === "free_discussion" || phase === "dm_question";
}

function filterAutoSelectedReactions(input: {
  plan: DiscussionReactionPlan;
  latestMessage: Message;
  recentAiSpeakers: Set<RoleId>;
  remainingReplyBudget: number;
  maxRepliesPerWave: number;
}): ReactionIntent[] {
  return input.plan.schedulerResult.selected_reactions
    .filter((reaction) => reaction.role_id !== input.latestMessage.speaker_role_id)
    .filter((reaction) => {
      if (!input.recentAiSpeakers.has(reaction.role_id)) {
        return true;
      }

      return (
        (input.latestMessage.target_role_ids ?? []).includes(reaction.role_id) ||
        isForcedByDirectAddress(reaction)
      );
    })
    .filter(
      (reaction) =>
        reaction.trigger_type !== "none" &&
        (reaction.trigger_type !== "minor_relevance" || isTriggeredByGroupQuestion(reaction))
    )
    .filter((reaction) => reaction.wants_to_speak && reaction.speech_act !== "none")
    .slice(0, Math.max(0, Math.min(input.remainingReplyBudget, input.maxRepliesPerWave)));
}

function toSkippedWave(
  waveIndex: number,
  latestMessage: Message,
  plan: DiscussionReactionPlan,
  stopReason: AutoDiscussionStopReason
): AutoDiscussionWave {
  return {
    waveIndex,
    seedMessageId: latestMessage.message_id,
    phase: latestMessage.phase,
    selectedReactions: plan.schedulerResult.selected_reactions,
    createdMessageIds: [],
    blockedCount: 0,
    stopReason
  };
}

function canTriggerAutoDiscussion(message: Message): boolean {
  if (message.speaker_type === "dm") {
    if (message.metadata.textUnitEnd !== undefined && message.metadata.textInteraction !== true) return false;
    return (
      message.speech_act === "dm_directed_question" ||
      message.speech_act === "group_question" ||
      message.speech_act === "dm_prompt" ||
      (message.speech_act === "question" && (message.target_role_ids ?? []).length > 0) ||
      isDmTextQuestionOrDirectAddress(message.content)
    );
  }

  if (message.speaker_type === "user" && message.speech_act === "statement") return true;
  if (message.speaker_type !== "user" && message.speaker_type !== "ai_player") {
    return false;
  }

  return [
    "share",
    "question",
    "answer",
    "answer_dm_question",
    "answer_user_question",
    "answer_group_question",
    "challenge",
    "empathy",
    "clarify",
    "emotion",
    "group_question"
  ].includes(message.speech_act);
}

function isDmTextQuestionOrDirectAddress(content: string): boolean {
  return /[?？]|你怎么看|怎么看|你觉得|觉得呢|要不要|有没有|注意到|想问|补充|说说|说一下|聊聊|回答|回应|请.+说|请.+答|.+呢/.test(
    content
  );
}

function isForcedByDirectAddress(intent: ReactionIntent): boolean {
  return Boolean((intent as ReactionIntent & { forced_by_direct_address?: boolean }).forced_by_direct_address);
}

function isTriggeredByGroupQuestion(intent: ReactionIntent): boolean {
  return Boolean((intent as ReactionIntent & { triggered_by_group_question?: boolean }).triggered_by_group_question);
}

function hasNewDiscussionSignal(execution: ExecuteSelectedReactionsResult): boolean {
  return execution.createdMessages.some((message) => {
    const metadata = message.metadata;

    return Boolean(
      metadata.revealed_facts.length ||
        metadata.questions_raised.length ||
        metadata.emotional_points.length ||
        metadata.event_tags.length ||
        metadata.topic_tags.length
    );
  });
}

async function maybeRunDmDiscussionClose(input: {
  gameId: string;
  phase: GamePhase;
  reason: AutoDiscussionStopReason;
  budget: AutoDiscussionBudget;
  waves: AutoDiscussionWave[];
}): Promise<{ triggered: boolean; messageId: string | null }> {
  const shouldClose =
    input.phase === "free_discussion" &&
    input.budget.shouldCloseWithDm &&
    (input.reason === "dm_should_close" ||
      input.reason === "max_ai_replies_reached" ||
      input.reason === "max_waves_reached" ||
      input.reason === "low_value_replies");

  if (!shouldClose) {
    return { triggered: false, messageId: null };
  }

  const result = await runDmFlowStep({
    gameSessionId: input.gameId,
    trigger: "discussion_turn_limit_reached",
    nextAction: "wait_for_user"
  });

  return {
    triggered: Boolean(result.message),
    messageId: result.message?.message_id ?? null
  };
}

async function hasProcessedSeedMessage(gameId: string, seedMessageId: string, matchingWindow = false): Promise<boolean> {
  const pending = await getPendingResponse(gameId);
  if (pending?.message.message_id === seedMessageId && Date.now() < pending.deadline) return false;
  const untouched = await (await import("@/src/lib/services/discussionReadiness")).nextUnansweredDiscussionQuestion(gameId);
  if (untouched?.messageId === seedMessageId) return false;
  const runs = await listRecentAgentRuns(gameId, ["auto_discussion_runner"], 20);

  return runs.some((run) => {
    if (run.status !== "success") {
      return false;
    }

    const input = isRecord(run.inputJson) ? run.inputJson : {};
    const output = isRecord(run.outputJson) ? run.outputJson : {};
    // Old free-chat caps could report a matching question processed without
    // publishing anything. It still deserves its bounded response opportunity.
    if (matchingWindow && ["dm_should_close", "already_processed"].includes(String(output.stopReason)) && output.totalAiReplies === 0) return false;

    if (output.deferredSeedMessageId === seedMessageId) return false;
    return (output.seedMessageId ?? input.seedMessageId) === seedMessageId ||
      Array.isArray(output.waves) && output.waves.some(wave => isRecord(wave) && wave.seedMessageId === seedMessageId);
  });
}

async function completeRunner(input: {
  agentRunId: string;
  startedAt: number;
  result: AutoDiscussionResult;
}): Promise<AutoDiscussionResult> {
  await completeAgentRun({
    agentRunId: input.agentRunId,
    outputJson: input.result,
    latencyMs: Date.now() - input.startedAt
  });

  return input.result;
}

function emptyResult(
  mode: DiscussionExecutionMode,
  seedMessage: Message,
  budget: AutoDiscussionBudget,
  stopReason: AutoDiscussionStopReason
): AutoDiscussionResult {
  return {
    mode,
    seedMessageId: seedMessage.message_id,
    phase: seedMessage.phase,
    budget,
    waves: [],
    totalAiReplies: 0,
    stopReason,
    dmCloseTriggered: false,
    dmCloseMessageId: null
  };
}

function compactMessage(message: Message) {
  return {
    messageId: message.message_id,
    speakerType: message.speaker_type,
    speakerRoleId: message.speaker_role_id,
    phase: message.phase,
    speechAct: message.speech_act
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
