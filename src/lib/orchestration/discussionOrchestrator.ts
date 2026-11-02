import { getResponseDeliveries, responseKey, beginResponseDelivery, finishResponseDelivery, settleFailedDMResponse, withOptionalResponse, isOptionalResponse } from "../services/responseDelivery";
import { explicitUserAddressing } from "../services/discussionReply";
import "server-only";
import { prisma } from "@/src/lib/db/prisma";
import { StaleConversationError, beginConversationTurn, conversationCheckpoint, deferConversationSeed, conversationStage, ensureConversation, inConversation, withConversation, conversationRevision } from "@/src/lib/services/conversationService";

import { runAiPlayerDiscussionUtterance, buildDiscussionUtteranceContext } from "@/src/lib/agents/aiPlayerDiscussionUtterance";
import { discussionKnowledge, findMemoryConnections, type DiscussionKnowledge, type MemoryConnection } from "@/src/lib/services/discussionKnowledge";
import { discussionPacing, performanceResponders } from "@/src/lib/services/discussionPacing";
import { normalizeLlmError } from "@/src/lib/llm/llmErrors";
import { redactLlmSecrets } from "@/src/lib/llm/providerAdapter";
import { planAiPlayerReaction } from "@/src/lib/agents/aiPlayerReactionPlanner";
import { runDiscussionChecker } from "@/src/lib/agents/discussionChecker";
import { completeAgentRun, createAgentRun, failAgentRun } from "@/src/lib/services/agentRunService";
import type { StoryBoardPatch } from "@/src/lib/schemas/storyBoardPatchSchema";
import type { RoleId, Script } from "@/src/lib/script/scriptTypes";
import {
  DEFAULT_MAX_DISCUSSION_TURNS,
  getGameSession,
  updateGameSession
} from "@/src/lib/services/gameService";
import { createMessage, getMessageInGame, listMessages, listRecentPublicMessages } from "@/src/lib/services/messageService";
import { getRoleMemory } from "@/src/lib/services/roleMemoryService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import {
  getOrCreatePublicStoryBoard
} from "@/src/lib/services/storyBoardService";
import { enqueuePublicMessageForStoryBoard } from "@/src/lib/services/storyBoardQueueService";
import type {
  GamePhase,
  Message,
  PublicStoryBoard,
  ReactionProfile,
  SpeechAct
} from "@/src/lib/types/game";
import {
  buildReactionCandidates,
  hasOverlap,
  type ReactionCandidate
} from "@/src/lib/orchestration/reactionPrefilter";
import {
  scheduleReactionTurns,
  type TurnSchedulerResult
} from "@/src/lib/orchestration/turnScheduler";
import type { ReactionIntent } from "@/src/lib/schemas/reactionIntentSchema";
import type { AiPlayerDiscussionUtteranceOutput } from "@/src/lib/schemas/aiPlayerDiscussionUtteranceSchema";
import type { DiscussionCheckerOutput } from "@/src/lib/schemas/discussionCheckerSchema";
import { resolveAddressing, sanitizeAddressing, publicDiscussionRoster, type AddressingResolution, type PublicRole } from "./addressingResolution";

export type CompactReactionContext = {
  knowledge?: DiscussionKnowledge;
  memory_connections?: MemoryConnection[];
  addressing_context?: {
    preAnalysis: AddressingResolution;
    publicRoster: PublicRole[];
    recentPublicMessages: { speakerRoleId: string | null; content: string }[];
  };
  role: {
    role_id: RoleId;
    name: string;
  };
  latest_message: {
    id: string;
    speaker_role_id: string | null;
    target_role_ids: RoleId[];
    speech_act: string;
    content: string;
    metadata: Message["metadata"];
  };
  role_reaction_profile: ReactionProfile;
  public_state_brief: {
    related_known_facts: string[];
    related_open_questions: string[];
    related_conflicts: string[];
    related_emotional_bonds: string[];
  };
  discussion_state: {
    phase: GamePhase;
    discussion_turn_count: number;
    max_discussion_turns: number;
  };
  prefilter: ReactionCandidate;
};

export type DiscussionReactionPlan = {
  plannerFailures?: Array<{ roleId: string; type: string; message: string }>;
  addressing?: AddressingResolution;
  addressingTrace?: { heuristicLatencyMs: number; heuristicFastPath: boolean; plannerCalls: number;
    plannerFailures: number; targetDetectorCalls: number; selectionReason: string; plannerDisagreement: boolean };
  plannerCandidates?: ReactionCandidate[];
  latestMessage: Message;
  triggerClassification: DiscussionTriggerClassification;
  prefilterCandidates: ReactionCandidate[];
  reactionIntents: ReactionIntent[];
  schedulerResult: TurnSchedulerResult;
};

export type DiscussionTriggerClassification = {
  triggerType:
    | "directed_question"
    | "group_question"
    | "specific_content"
    | "dm_discussion_invitation"
    | "none";
  targetRoleIds: RoleId[];
  targetRoleNames: string[];
  confidence: number;
};

type ReactionIntentWithDebugFlags = ReactionIntent & {
  forced_by_direct_address?: boolean;
  triggered_by_group_question?: boolean;
  scheduler_bypassed_threshold?: boolean;
};

export type PlanDiscussionReactionsInput = {
  gameSessionId: string;
  latestMessageId: string;
  latestStoryBoardPatch?: StoryBoardPatch | null;
  mockPlannerOutputs?: Partial<Record<RoleId, unknown>>;
  schedulerOptions?: {
    maxAiReactionsPerTrigger?: number;
    minRelevanceScore?: number;
  };
  latestMessageOverride?: Message;
  participationOnly?: boolean;
};

export type BlockedReaction = {
  selectedReaction: ReactionIntent;
  checkerResult?: DiscussionCheckerOutput;
  reason: string;
};

export type DiscussionAttemptDebug = {
  roleId: RoleId;
  attempt: 1 | 2;
  candidate: AiPlayerDiscussionUtteranceOutput;
  checkerResult: DiscussionCheckerOutput;
  checkerMode: Awaited<ReturnType<typeof runDiscussionChecker>>["checkerMode"];
  checkerLlmInvoked: boolean;
  checkerDeterministicLatencyMs: number;
};

export type ExecutedReaction = {
  selectedReaction: ReactionIntent;
  candidate: AiPlayerDiscussionUtteranceOutput;
  checkerResult: DiscussionCheckerOutput;
  checkerMode: Awaited<ReturnType<typeof runDiscussionChecker>>["checkerMode"];
  message: Message;
};

export type ExecuteSelectedReactionsResult = {
  latestMessage: Message;
  selectedReactions: ReactionIntent[];
  createdMessages: Message[];
  checkerResults: DiscussionCheckerOutput[];
  blockedReactions: BlockedReaction[];
  updatedStoryBoard: PublicStoryBoard;
  updatedGameSession: Awaited<ReturnType<typeof getGameSession>>;
  executedReactions: ExecutedReaction[];
  attempts: DiscussionAttemptDebug[];
};

export async function planDiscussionReactions({
  gameSessionId,
  latestMessageId,
  latestStoryBoardPatch = null,
  mockPlannerOutputs = {},
  schedulerOptions = {},
  latestMessageOverride, participationOnly = false
}: PlanDiscussionReactionsInput): Promise<DiscussionReactionPlan> {
  const startedAt = Date.now();
  const [session, savedLatestMessage, publicStoryBoard, script, history] = await Promise.all([
    getGameSession(gameSessionId),
    getMessageInGame(gameSessionId, latestMessageId),
    getOrCreatePublicStoryBoard(gameSessionId),
    getScriptForGameSession(gameSessionId),
    listMessages(gameSessionId)
  ]);
  const latestMessage = latestMessageOverride ?? savedLatestMessage;
  const definition = session.runtimeDefinitionId ? await (await import("@/src/lib/services/scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(session.runtimeDefinitionId) : null;
  const pacing = discussionPacing(session, definition?.definition);
  const dmInteraction = (await import("../services/publicDiscussionContext")).currentDMInteraction(session, history, latestMessage);
  if (pacing.mode === "dm_performance" || dmInteraction?.kind === "player_followup") {
    const addressing = resolveMessageAddressing(latestMessage, script.roles);
    const pending = session.dmFlowCursor?.pendingDMQuestion;
    const declaredTargets = pending?.messageId === latestMessage.message_id ? pending.targetRoleNames : addressing.directTargets;
    const directed = declaredTargets.length > 0;
    const responders = participationOnly ? [] : (dmInteraction?.kind === "player_followup" ? dmInteraction.target_role_ids : performanceResponders(session, latestMessage, addressing.directTargets))
      .filter(id => !history.some(m => m.speaker_role_id === id && m.reply_to_message_id === latestMessage.message_id));
    const intents: ReactionIntentWithDebugFlags[] = responders.map(role_id => ({ role_id, wants_to_speak: true,
      trigger_type: "direct_question_to_self", relevance_score: 5, urgency_score: 5, emotional_intensity_score: 1,
      boundary_risk: "low", target_role_ids: [latestMessage.speaker_role_id ?? "dm"], speech_act: latestMessage.speaker_type === "user" ? "answer_user_question" : "answer_dm_question", forced_by_direct_address: true,
      triggered_by_group_question: !directed,
      reason: "演绎阶段仅由DM当前问题安排回应", brief_intent: "仅具体回答当前DM问答或真人对其的定向追问，优先补充合法相关细节，回答完即停；不复述无关旧经历、不提新问题、不邀请其他玩家讨论。" }));
    const plan: DiscussionReactionPlan = { latestMessage, triggerClassification: { triggerType: latestMessage.speaker_type === "dm" ? directed ? "directed_question" : "group_question" : "none",
      targetRoleIds: directed ? declaredTargets : [], targetRoleNames: directed ? declaredTargets : [], confidence: 1 }, prefilterCandidates: [], reactionIntents: intents,
      schedulerResult: { selected_reactions: intents, should_dm_intervene: false,
        reason: responders.length ? "按DM演绎问题回应，之后交回DM" : "演绎中不调度玩家之间的讨论，等待DM" } };
    const trace = await createAgentRun({ gameSessionId, agentType: "discussion_orchestrator", actId: session.currentActId,
      phase: session.currentPhase, inputJson: { latestMessageId, mode: "dm_performance", participationOnly } });
    await completeAgentRun({ agentRunId: trace.id, outputJson: plan, latencyMs: Date.now() - startedAt });
    return plan;
  }
  // Only identities already spoken publicly are address aliases. Private or
  // future identities must never enter the table's target resolver.
  const publicRoles = publicDiscussionRoster(script.roles, history);
  const inputWindow = await (await import("@/src/lib/services/runtimeInputPolicy")).runtimeInputPolicy(gameSessionId);
  if (inputWindow && (inputWindow.policy === "choice_only" || participationOnly ||
    latestMessage.speaker_type !== "dm" || session.dmFlowCursor?.pendingDMQuestion?.messageId !== latestMessage.message_id)) {
    return { latestMessage, triggerClassification: { triggerType: "none", targetRoleIds: [], targetRoleNames: [], confidence: 1 },
      prefilterCandidates: [], reactionIntents: [], schedulerResult: { selected_reactions: [], should_dm_intervene: false,
        reason: "当前为独立回答窗口；保底分享与普通回应等待正式开放讨论。" } };
  }
  const ordinaryLimit = getEffectiveMaxDiscussionTurns(
    session.currentPhase,
    session.maxDiscussionTurns
  );
  // An authored interactive question gets its bounded response opportunity;
  // ordinary free-chat turn limits must not silence its designated responder.
  const authoredQuestion = session.dmFlowCursor?.pendingDMQuestion?.textInteraction &&
    session.dmFlowCursor.pendingDMQuestion.messageId === latestMessage.message_id && latestMessage.speaker_type === "dm";
  const participation = session.currentPhase === "free_discussion" || session.dmFlowCursor?.textPresentation?.kind === "start" && !session.dmFlowCursor.textPresentation.confirmed
    ? await getDiscussionParticipation(gameSessionId) : null;
  let effectiveMaxDiscussionTurns = (authoredQuestion || participation?.pendingRoleIds.length || pacing.matchingDiscussion) ? Math.max(ordinaryLimit, session.discussionTurnCount + (pacing.matchingDiscussion ? 5 : 1)) : ordinaryLimit;
  const reactionProfiles = await getReactionProfiles(gameSessionId, session.aiRoleIds);
  const publicSpeakingCounts: Record<string, number> = {};
  for (const m of history) if (m.speaker_type === "ai_player" && m.speaker_role_id && m.phase === session.currentPhase &&
    (m.metadata.act_id === session.currentActId || !m.metadata.act_id && !session.currentActId.startsWith("runtime_act_")))
    publicSpeakingCounts[m.speaker_role_id] = (publicSpeakingCounts[m.speaker_role_id] ?? 0) + 1;
  const heuristicStartedAt = Date.now();
  let addressing = resolveMessageAddressing(latestMessage, publicRoles);
  if (addressing.directTargets.some(id => session.aiRoleIds.includes(id)) ||
    latestMessage.speaker_type === "user" && addressing.addressingMode === "group")
    effectiveMaxDiscussionTurns = Math.max(effectiveMaxDiscussionTurns, session.discussionTurnCount + 5);
  if (participationOnly) addressing = { ...addressing, addressingMode: "group", directTargets: [], excludedTargets: [],
    needsPlanner: false, controlMessage: false, reason: "定时检查本幕尚未表达角色，不重发或改写DM台词" };
  const heuristicLatencyMs = Date.now() - heuristicStartedAt;
  let triggerClassification = classifyDiscussionTrigger(latestMessage, script, session.aiRoleIds, addressing);
  let prefilterCandidates = buildReactionCandidates({
    latestMessage,
    latestStoryBoardPatch,
    publicStoryBoard,
    aiRoleIds: session.aiRoleIds,
    reactionProfiles,
    userRoleId: session.userRoleId,
    currentPhase: session.currentPhase,
    roles: script.roles,
    addressing
  });
  const knowledgeByRole = new Map<RoleId, DiscussionKnowledge>();
  const connectionsByRole = new Map<RoleId, MemoryConnection[]>();
  const contextBuildStartedAt = Date.now();
  if (!participationOnly && !addressing.controlMessage && (addressing.needsPlanner || addressing.addressingMode !== "direct")) {
    // Local reads only. Each candidate gets its own authorized sources, never
    // the combined private texts of all candidates. No extra reasoning Agent.
    await Promise.all(session.aiRoleIds.filter(id => id !== latestMessage.speaker_role_id).map(async roleId => {
      const sourceContext = await buildDiscussionUtteranceContext(gameSessionId, latestMessageId, {
        role_id: roleId, wants_to_speak: true, trigger_type: "minor_relevance", relevance_score: 4,
        urgency_score: 3, emotional_intensity_score: 2, boundary_risk: "low", target_role_ids: [],
        speech_act: "clarify", reason: "local source comparison", brief_intent: "比较本人合法记忆与公开发言" });
      const knowledge = discussionKnowledge(sourceContext);
      knowledgeByRole.set(roleId, knowledge);
      const connections = findMemoryConnections(knowledge, { id: latestMessage.message_id,
        speaker_role_id: latestMessage.speaker_role_id, content: latestMessage.content }, roleId);
      connectionsByRole.set(roleId, connections);
    }));
    for (const [roleId, links] of connectionsByRole) if (links.length && !addressing.excludedTargets.includes(roleId)) {
      const previous = prefilterCandidates.find(c => c.roleId === roleId);
      const candidate = { roleId, roughScore: Math.max(4, previous?.roughScore ?? 0),
        matchedSignals: [...previous?.matchedSignals ?? [], "memory_connection"] };
      prefilterCandidates = [...prefilterCandidates.filter(c => c.roleId !== roleId), candidate];
    }
    prefilterCandidates.sort((a,b) => b.roughScore - a.roughScore);
    prefilterCandidates = prefilterCandidates.slice(0, 3);
  }
  const contextBuildMs = Date.now() - contextBuildStartedAt;
  const plannerCandidates = buildAddressingCandidates(addressing, prefilterCandidates, latestMessage,
    session.aiRoleIds.filter((id) => id !== session.userRoleId), reactionProfiles, publicSpeakingCounts);
  const recentPublicMessages = addressing.needsPlanner || addressing.addressingMode === "group" ? (await listRecentPublicMessages(gameSessionId, 4, latestMessage.created_at))
    .filter((message) => message.id !== latestMessage.message_id).slice(-3)
    .map((message) => ({ speakerRoleId: message.speakerRoleId, content: message.content.slice(0, 240) })) : [];
  const orchestrationRun = await createAgentRun({
    gameSessionId,
    agentType: "discussion_orchestrator",
    actId: session.currentActId,
    phase: session.currentPhase,
    inputJson: {
      latestMessageId,
      contextBuildMs,
      conversationRevision: conversationRevision(),
      latestMessage: compactMessageForLog(latestMessage),
      latestStoryBoardPatchSignals: compactPatchSignals(latestStoryBoardPatch),
      triggerClassification,
      prefilterCandidates,
      addressing,
      plannerCandidates, participationOnly
    }
  });

  let plannerFailures: NonNullable<DiscussionReactionPlan["plannerFailures"]> = [];
  try {
    const directedIntents = addressing.needsPlanner || addressing.controlMessage ? [] : buildForcedDirectedQuestionIntents({
      latestMessage,
      triggerClassification,
      aiRoleIds: session.aiRoleIds,
      userRoleId: session.userRoleId
    });

    const participationRoles = participation && (participationOnly || !addressing.directTargets.length &&
      addressing.addressingMode === "group" && !addressing.needsPlanner) ? participation.pendingRoleIds
        .map(id => ({ id, tie: Math.random() })).sort((a, b) => a.tie - b.tie).map(r => r.id)
        .filter(id => !addressing.excludedTargets.includes(id)) : [];
    const forcedDirectedIntents: ReactionIntentWithDebugFlags[] = !participationOnly && directedIntents.length ? directedIntents : participationRoles.slice(0, 2).map(roleId => ({
      triggered_by_group_question: true,
      role_id: roleId, wants_to_speak: true, trigger_type: "minor_relevance" as const,
      relevance_score: 5 as const, urgency_score: 4 as const, emotional_intensity_score: 2 as const,
      boundary_risk: "low" as const, target_role_ids: [], speech_act: "clarify" as const,
      reason: "本幕尚无已发布表达，提供一次有界参与机会",
      brief_intent: "充分讲述当前幕 mustShare/mayShare 中的重要经历、事件、关系和具体细节；按经历连贯叙述，不能只报姓名年龄。已讲过的部分简略带过，优先新增信息。没有可公开事实时，只表达感受、困惑或暂不透露的态度，不编造事实；严守 mustNotShare。"
    }));
    const settled = await Promise.allSettled(
      forcedDirectedIntents.length || participationOnly
        ? []
        : plannerCandidates.map((candidate) =>
            planAiPlayerReaction({
              gameSessionId,
              roleId: candidate.roleId,
              actId: session.currentActId,
              phase: session.currentPhase,
              context: buildCompactReactionContext({
                roleId: candidate.roleId,
                script,
                candidate,
                knowledge: knowledgeByRole.get(candidate.roleId),
                memoryConnections: connectionsByRole.get(candidate.roleId),
                latestMessage,
                publicStoryBoard,
                reactionProfile: reactionProfiles[candidate.roleId] ?? createEmptyReactionProfile(),
                phase: session.currentPhase,
                discussionTurnCount: session.discussionTurnCount,
                maxDiscussionTurns: effectiveMaxDiscussionTurns,
                addressingContext: { preAnalysis: addressing, publicRoster: publicRoles.map(({role_id, name, aliases}) => ({role_id, name,
                  ...(aliases?.length ? { aliases: [...new Set(aliases)] } : {}) })),
                  recentPublicMessages }
              }),
              mockOutput: mockPlannerOutputs[candidate.roleId]
            })
          )
    );
    const plannerIntents = settled
      .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof planAiPlayerReaction>>> => result.status === "fulfilled")
      .map((result) => result.value.intent);
    plannerFailures = settled.flatMap((result, index) => result.status === "rejected" ? [{
      roleId: plannerCandidates[index].roleId, type: normalizeLlmError(result.reason).type,
      message: redactLlmSecrets(result.reason instanceof Error ? result.reason.message : String(result.reason))
    }] : []);
    for (const intent of plannerIntents) {
      const own = intent.addressing;
      if (intent.wants_to_speak && intent.trigger_type === "direct_question_to_self" && own?.addressingMode === "direct" &&
        !own.directTargets.includes(intent.role_id)) {
        throw new Error(`addressing_conflict: ${intent.role_id} wants to answer itself but names a different addressee`);
      }
    }
    const resolutions = plannerIntents.flatMap((intent) => intent.addressing ? [sanitizeAddressing(intent.addressing, script.roles)] : []);
    const plannerDisagreement = resolutions.some((value) => JSON.stringify([value.addressingMode, [...value.directTargets].sort(), [...value.excludedTargets].sort()]) !==
      JSON.stringify([resolutions[0].addressingMode, [...resolutions[0].directTargets].sort(), [...resolutions[0].excludedTargets].sort()]));
    if (addressing.needsPlanner && resolutions.length && !plannerDisagreement) {
      addressing = { ...addressing, ...resolutions[0], referencedRoles: [...new Set(resolutions.flatMap((value) => value.referencedRoles))],
        excludedTargets: [...new Set([...addressing.excludedTargets, ...resolutions[0].excludedTargets])],
        source: "planner", reason: "已有候选 Planner 的对象判断一致" };
    }
    triggerClassification = classifyDiscussionTrigger(latestMessage, script, session.aiRoleIds, addressing);
    const schedulingMessage = { ...latestMessage, target_role_ids: addressing.directTargets };
    const maxAiReactionsPerTrigger = addressing.addressingMode !== "none"
      ? Math.min(5, schedulerOptions.maxAiReactionsPerTrigger ?? 5) : schedulerOptions.maxAiReactionsPerTrigger;
    let reactionIntents = [
      ...forcedDirectedIntents,
      ...plannerIntents
    ].map((intent) => {
      const own = addressing.needsPlanner && intent.addressing ? sanitizeAddressing(intent.addressing, script.roles) : addressing;
      const excluded = addressing.excludedTargets.includes(intent.role_id) || own.excludedTargets.includes(intent.role_id);
      const otherDirected = own.addressingMode === "direct" && !own.directTargets.includes(intent.role_id);
      if (otherDirected && intent.wants_to_speak && intent.trigger_type === "direct_question_to_self") {
        throw new Error(`addressing_conflict: ${intent.role_id} was willing to answer but merged addressing points elsewhere`);
      }
      if (excluded || otherDirected) return { ...intent, wants_to_speak: false, speech_act: "none" as const,
        reason: excluded ? "实际提问对象排除了本角色" : "实际问题点名其他角色" };
      if (intent.trigger_type === "direct_question_to_self" && !own.directTargets.includes(intent.role_id)) {
        intent = { ...intent, trigger_type: "minor_relevance", reason: `${intent.reason}；不是直接提问对象` };
      }
      if ((own.addressingMode === "group" || own.addressingMode === "open") && intent.wants_to_speak && intent.relevance_score >= 4) {
        return withReactionDebugFlags(intent, { triggered_by_group_question: true });
      }
      return intent;
    });
    let schedulerResult = scheduleReactionTurns({
      reactionIntents,
      latestMessage: schedulingMessage,
      discussionTurnCount: session.discussionTurnCount,
      maxDiscussionTurns: effectiveMaxDiscussionTurns,
      maxAiReactionsPerTrigger,
      publicSpeakingCounts,
      recentSpeakerRoleIds: recentPublicMessages.map((message) => message.speakerRoleId).filter((id): id is string => !!id),
      minRelevanceScore: schedulerOptions.minRelevanceScore
    });

    if (
      schedulerResult.selected_reactions.length === 0 &&
      !participationOnly && forcedDirectedIntents.length === 0 &&
      !settled.some((result) => result.status === "rejected") &&
      !plannerDisagreement &&
      (triggerClassification.triggerType === "group_question" ||
        triggerClassification.triggerType === "directed_question")
    ) {
      const fallbackIntents = buildQuestionFallbackIntents({
        latestMessage,
        triggerClassification,
        aiRoleIds: session.aiRoleIds,
        userRoleId: session.userRoleId,
        prefilterCandidates: plannerCandidates,
        phase: session.currentPhase,
        actId: session.currentActId,
        booklets: script.acts.find(act => act.act_id === session.currentActId)?.booklets ?? [],
        messages: history,
        excludedTargets: addressing.excludedTargets,
        failedPlannerRoles: plannerCandidates.filter((_, index) => settled[index]?.status === "rejected").map((candidate) => candidate.roleId)
      });

      if (fallbackIntents.length > 0) {
        reactionIntents = [...reactionIntents.filter((intent) => !fallbackIntents.some((fallback) => fallback.role_id === intent.role_id)), ...fallbackIntents];
        schedulerResult = scheduleReactionTurns({
          reactionIntents,
          latestMessage: schedulingMessage,
          discussionTurnCount: session.discussionTurnCount,
          maxDiscussionTurns: effectiveMaxDiscussionTurns,
          maxAiReactionsPerTrigger,
          publicSpeakingCounts,
          recentSpeakerRoleIds: recentPublicMessages.map((message) => message.speakerRoleId).filter((id): id is string => !!id),
          minRelevanceScore: schedulerOptions.minRelevanceScore
        });
      }
    }

    if (!schedulerResult.selected_reactions.length && settled.some(result => result.status === "rejected")) {
      const failed = plannerCandidates.filter((_, index) => settled[index]?.status === "rejected").map(candidate => candidate.roleId);
      // A single failed Planner cannot pause its successful peers. When no
      // responder is available, retain the question and expose a real outage.
      for (const result of settled) if (result.status === "rejected") {
        if (!isOptionalResponse() || ["authentication", "quota", "test_budget"].includes(normalizeLlmError(result.reason).type))
          await (await import("@/src/lib/services/modelAvailabilityService")).recordModelFailure(gameSessionId, result.reason);
      }
      throw new Error(`reaction_planner_failed: ${failed.join(", ")}; public question remains unhandled`);
    }
    const plan: DiscussionReactionPlan = {
      plannerFailures,
      addressing,
      plannerCandidates,
      addressingTrace: { heuristicLatencyMs, heuristicFastPath: !addressing.needsPlanner, plannerCalls: forcedDirectedIntents.length || participationOnly ? 0 : plannerCandidates.length,
        plannerFailures: settled.filter((result) => result.status === "rejected").length, targetDetectorCalls: 0, plannerDisagreement,
        selectionReason: schedulerResult.selected_reactions.map((intent) => `${intent.role_id}: ${intent.reason}`).join("；") || "未选中回应者" },
      latestMessage,
      triggerClassification,
      prefilterCandidates,
      reactionIntents,
      schedulerResult
    };

    await completeAgentRun({
      agentRunId: orchestrationRun.id,
      outputJson: plan,
      latencyMs: Date.now() - startedAt
    });

    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discussion orchestration failed.";

    await failAgentRun({
      agentRunId: orchestrationRun.id,
      error: "discussion_orchestrator_failed",
      errorMessage: message,
      outputJson: { plannerFailures, questionHandled: false, latestMessageId },
      latencyMs: Date.now() - startedAt
    });

    throw error;
  }
}

// Persisted public messages prove expression; a request/plan alone never does.
// Existing AgentRun spans bound attempts across ticks, including failures before provider start.
export async function getDiscussionParticipation(gameId: string) {
  const session = await getGameSession(gameId);
  const messages = await listMessages(gameId);
  const expressed = new Set(messages.filter(m => m.metadata.act_id === session.currentActId &&
    ["share_round", "free_discussion"].includes(m.phase) && !["answer_only","choice_only"].includes(m.metadata.runtimeInputPolicy ?? "") && ["user", "ai_player"].includes(m.speaker_type) && m.content.trim())
    .map(m => m.speaker_role_id));
  const readiness = await (await import("./../services/discussionReadiness")).getDiscussionReadiness(gameId);
  if (readiness) { expressed.clear(); for (const id of readiness.sharedRoleIds) expressed.add(id); }
  const runs = await prisma.agentRun.findMany({ where: { gameSessionId: gameId, actId: session.currentActId,
    agentType: "discussion_participation_attempt", OR: [{ error: null }, { error: { not: "model_paused" } }] }, select: { roleId: true } });
  const missingRoleIds = session.aiRoleIds.filter(id => !expressed.has(id));
  const exhaustedRoleIds = missingRoleIds.filter(id => runs.filter(r => r.roleId === id).length >= 2);
  return { expressedRoleIds: [...expressed], pendingRoleIds: missingRoleIds.filter(id => !exhaustedRoleIds.includes(id)),
    exhaustedRoleIds, humanExpressed: expressed.has(session.userRoleId) };
}

// Invoked under the Lifecycle lease: at most two baseline speakers per wakeup,
// with a bounded relevant followup. No second queue or private memory store.
export async function runDiscussionParticipation(gameId: string, seedMessageId: string) {
  // PDF preflight is explicitly offline. Do not consume a role's finite model
  // attempts before the developer starts Live; the normal tick resumes later.
  if ((await import("@/src/lib/llm/localPlaytestGuard")).localPlaytestMode() === "blocked") return;
  if (await (await import("@/src/lib/services/runtimeInputPolicy")).runtimeInputPolicy(gameId)) return;
  const session = await getGameSession(gameId);
  const pending = session.dmFlowCursor?.pendingDMQuestion;
  const view = session.runtimeDefinitionId ? await (await import("./../services/scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(session.runtimeDefinitionId) : null;
  if (discussionPacing(session, view?.definition).mode !== "discussion" || !["free_discussion", "dm_question"].includes(session.currentPhase) || pending && pending.nodeId === session.dmFlowCursor?.nodeId &&
    ["waiting", "partial_answered"].includes(pending.status)) return;
  // The foreground runner has already spent its reply budget before entering
  // its DM stage. Let the existing timer organize the next batch, rather than
  // appending extra speakers to the same human-triggered wave.
  if ((await ensureConversation(gameId)).stage === "dm" || !(await getDiscussionParticipation(gameId)).pendingRoleIds.length) return;
  const plan = await planDiscussionReactions({ gameSessionId: gameId, latestMessageId: seedMessageId,
    participationOnly: true, schedulerOptions: { maxAiReactionsPerTrigger: 2 } });
  for (const reaction of plan.schedulerResult.selected_reactions) {
    const checkpoint = await conversationCheckpoint(gameId);
    if (checkpoint.changed) {
      if (checkpoint.seedMessageId) await deferConversationSeed(gameId, checkpoint.seedMessageId);
      return { interrupted: true };
    }
    const attempt = await createAgentRun({ gameSessionId: gameId, agentType: "discussion_participation_attempt",
      roleId: reaction.role_id, actId: session.currentActId, phase: session.currentPhase,
      inputJson: { seedMessageId, nodeId: session.dmFlowCursor?.nodeId, purpose: "bounded_expression_opportunity" } });
    let sharedMessages: Message[] = [];
    try {
      const execution = await executeSelectedReactions({ gameSessionId: gameId, latestMessageId: seedMessageId, selectedReactions: [reaction] });
      if (!execution.createdMessages.length) throw new Error("Participation produced no approved public message");
      await completeAgentRun({ agentRunId: attempt.id, outputJson: { messageIds: execution.createdMessages.map(m => m.message_id) } });
      sharedMessages = execution.createdMessages;
    } catch (error) {
      const paused = (await import("@/src/lib/llm/localPlaytestGuard")).localPlaytestMode() === "blocked" ||
        await (await import("@/src/lib/services/modelAvailabilityService")).getModelAvailability(gameId);
      await failAgentRun({ agentRunId: attempt.id, error: paused ? "model_paused" : "participation_failed", errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    // Baseline shares bypass AutoDiscussionRunner. Give a question or a real
    // memory connection one bounded reply opportunity without reentering Lifecycle. A failed
    // answer must not relabel an already committed baseline share as failed.
    for (const message of sharedMessages) {
      const beforeFollowup = await conversationCheckpoint(gameId);
      if (beforeFollowup.changed) {
        if (beforeFollowup.seedMessageId) await deferConversationSeed(gameId, beforeFollowup.seedMessageId);
        return { interrupted: true };
      }
      const followup = await planDiscussionReactions({ gameSessionId: gameId, latestMessageId: message.message_id,
        schedulerOptions: { maxAiReactionsPerTrigger: 2 } });
      const afterFollowup = await conversationCheckpoint(gameId);
      if (afterFollowup.changed) {
        if (afterFollowup.seedMessageId) await deferConversationSeed(gameId, afterFollowup.seedMessageId);
        return { interrupted: true };
      }
      await executeSelectedReactions({ gameSessionId: gameId, latestMessageId: message.message_id,
        selectedReactions: followup.schedulerResult.selected_reactions.slice(0, 2) });
    }
  }
}

function getEffectiveMaxDiscussionTurns(phase: GamePhase, savedMaxDiscussionTurns: number): number {
  return phase === "free_discussion"
    ? Math.max(savedMaxDiscussionTurns, DEFAULT_MAX_DISCUSSION_TURNS)
    : savedMaxDiscussionTurns;
}

function resolveMessageAddressing(message: Message, roles: PublicRole[]): AddressingResolution {
  const result = resolveAddressing(message.content, roles);
  const explicit = explicitUserAddressing(message, roles, result);
  if (explicit) return explicit;
  // DM targets are authored by the DM controller, unlike legacy user name-detection metadata.
  if (message.speaker_type === "dm" && isQuestionLike(message) && (message.target_role_ids ?? []).length && !result.controlMessage) {
    return { ...result, addressingMode: "direct", directTargets: message.target_role_ids ?? [],
      needsPlanner: false, reason: "结构化 Agent 点名" };
  }
  // An AI can naturally ask its interlocutor "你呢" without repeating their
  // name. Preserve its planned, public recipient when the text has no explicit
  // addressee; do not override a named target or a group invitation.
  const recipients = (message.target_role_ids ?? []).filter(id => id !== message.speaker_role_id && roles.some(r => r.role_id === id));
  const actualQuestion = message.speech_act === "question" || message.metadata.questions_raised.length > 0 ||
    /[?？]|[吗呢][。！!\s]*$/.test(message.content);
  if (message.speaker_type === "ai_player" && actualQuestion && recipients.length && !result.controlMessage &&
    ["none", "open"].includes(result.addressingMode)) {
    return { ...result, addressingMode: "direct", directTargets: recipients, needsPlanner: false,
      reason: "AI向其已规划的公开对象继续求证" };
  }
  return result;
}

function buildAddressingCandidates(addressing: AddressingResolution, prefiltered: ReactionCandidate[], message: Message,
  aiRoleIds: RoleId[], profiles: Partial<Record<RoleId, ReactionProfile>>, speakingCounts: Record<string, number>): ReactionCandidate[] {
  if (addressing.controlMessage) return [];
  if (!addressing.needsPlanner && addressing.addressingMode !== "group" && addressing.addressingMode !== "open") return prefiltered;
  if (addressing.addressingMode === "none") {
    return prefiltered.length ? prefiltered : aiRoleIds.filter((roleId) => roleId !== message.speaker_role_id &&
      !addressing.excludedTargets.includes(roleId) && addressing.referencedRoles.includes(roleId))
      .map((roleId) => ({roleId, roughScore: 0, matchedSignals: ["addressing_ambiguous_reference"]})).slice(0, 3);
  }
  const tie = new Map(aiRoleIds.map(id => [id, Math.random()]));
  return aiRoleIds.filter((id) => id !== message.speaker_role_id && !addressing.excludedTargets.includes(id)).map((roleId) => {
    const existing = prefiltered.find((candidate) => candidate.roleId === roleId);
    const profile = profiles[roleId];
    const topics = [...profile?.known_event_tags ?? [], ...profile?.current_act_speakable_topics ?? [], ...profile?.unresolved_questions ?? []];
    const topicHit = hasOverlap([message.content], topics);
    const direct = addressing.directTargets.includes(roleId);
    return { roleId, roughScore: Math.max(existing?.roughScore ?? 0, direct ? 5 : topicHit ? 4 : addressing.referencedRoles.includes(roleId) ? 3 : 0),
      matchedSignals: [...existing?.matchedSignals ?? [], ...(topicHit ? ["own_topic_relevance"] : []),
        "addressing_question_candidate"] };
  }).filter((candidate) => addressing.needsPlanner || candidate.roughScore >= 4)
    .sort((a, b) => b.roughScore - a.roughScore || (speakingCounts[a.roleId] ?? 0) - (speakingCounts[b.roleId] ?? 0) || tie.get(a.roleId)! - tie.get(b.roleId)!).slice(0, 3);
}

export function classifyDiscussionTrigger(
  latestMessage: Message,
  script: Script,
  aiRoleIds: RoleId[],
  addressing: AddressingResolution = resolveMessageAddressing(latestMessage, script.roles)
): DiscussionTriggerClassification {
  const targetRoleIds = addressing.directTargets;
  const targetRoleNames = targetRoleIds.map((roleId) => getRoleName(script, roleId));
  const questionLike = isQuestionLike(latestMessage);

  if (
    latestMessage.speaker_type === "dm" &&
    (questionLike || addressing.addressingMode === "direct") &&
    targetRoleIds.some((roleId) => aiRoleIds.includes(roleId))
  ) {
    return {
      triggerType: "directed_question",
      targetRoleIds,
      targetRoleNames,
      confidence: 0.95
    };
  }

  if (addressing.addressingMode === "direct" && targetRoleIds.length > 0) {
    return {
      triggerType: "directed_question",
      targetRoleIds,
      targetRoleNames,
      confidence: addressing.needsPlanner && addressing.source !== "planner" ? 0.6 : 0.9
    };
  }

  if (
    !addressing.controlMessage &&
    (addressing.addressingMode === "group" ||
      (latestMessage.speaker_type === "dm" && questionLike && targetRoleIds.length === 0 && isOpenDmQuestionText(latestMessage.content)))
  ) {
    return {
      triggerType: "group_question",
      targetRoleIds: [],
      targetRoleNames: [],
      confidence: 0.82
    };
  }

  if (latestMessage.speaker_type === "dm" && latestMessage.speech_act === "discussion_invitation") {
    return {
      triggerType: "dm_discussion_invitation",
      targetRoleIds: [],
      targetRoleNames: [],
      confidence: 0.8
    };
  }

  if (latestMessage.metadata.event_tags.length || latestMessage.metadata.topic_tags.length) {
    return {
      triggerType: "specific_content",
      targetRoleIds,
      targetRoleNames,
      confidence: 0.65
    };
  }

  return {
    triggerType: "none",
    targetRoleIds,
    targetRoleNames,
    confidence: 0.4
  };
}

function buildForcedDirectedQuestionIntents(input: {
  latestMessage: Message;
  triggerClassification: DiscussionTriggerClassification;
  aiRoleIds: RoleId[];
  userRoleId: RoleId | null;
}): ReactionIntent[] {
  if (
    input.latestMessage.speaker_type !== "dm" &&
    input.latestMessage.speaker_type !== "user" &&
    input.latestMessage.speaker_type !== "ai_player"
  ) {
    return [];
  }

  if (
    input.triggerClassification.triggerType !== "directed_question"
  ) {
    return [];
  }

  return input.triggerClassification.targetRoleIds
    .filter((roleId) => input.aiRoleIds.includes(roleId))
    .filter((roleId) => roleId !== input.userRoleId)
    .slice(0, 5)
    .map((roleId) =>
      withReactionDebugFlags(
        {
          role_id: roleId,
          wants_to_speak: true,
          trigger_type: "direct_question_to_self",
          relevance_score: 5,
          urgency_score: 5,
          emotional_intensity_score: 2,
          boundary_risk: "low",
          target_role_ids:
            input.latestMessage.speaker_role_id &&
            input.latestMessage.speaker_role_id !== "system"
              ? [input.latestMessage.speaker_role_id]
              : [],
          speech_act:
            input.latestMessage.speaker_type === "dm"
              ? "answer_dm_question"
              : input.latestMessage.speaker_type === "user" ? "answer_user_question" : "answer",
          reason:
            input.latestMessage.speaker_type === "dm"
              ? "DM directly asked this role a question"
              : "User directly asked this role a question",
          brief_intent:
            "先直接回答刚才点名提出的问题；优先使用当前幕 mustShare/mayShare 中相关且尚未讲过的具体经历，不能机械重复身份或上一段。允许讲清事件，但不逐字朗读角色本；碰到 mustNotShare 自然回避。"
        },
        {
          forced_by_direct_address: true,
          scheduler_bypassed_threshold: true
        }
      )
    );
}

function buildQuestionFallbackIntents(input: {
  latestMessage: Message;
  triggerClassification: DiscussionTriggerClassification;
  aiRoleIds: RoleId[];
  userRoleId: RoleId | null;
  prefilterCandidates: ReactionCandidate[];
  phase: GamePhase;
  actId: string;
  booklets: Script["acts"][number]["booklets"];
  messages: Message[];
  excludedTargets: string[];
  failedPlannerRoles: string[];
}): ReactionIntent[] {
  // Authored DM performance questions need one actor; a player inviting the
  // table needs multiple independent answers, not one randomly chosen role.
  const maxFallbackCount = input.latestMessage.speaker_type === "dm" ? 1 : 5;
  const targetRoleIds =
    input.triggerClassification.triggerType === "directed_question"
      ? input.triggerClassification.targetRoleIds
      : [];
  const candidateRoleIds = targetRoleIds.length
    ? targetRoleIds
    : [
        ...input.prefilterCandidates.map((candidate) => candidate.roleId),
        ...[...input.aiRoleIds].sort()
      ];
  let roleIds = Array.from(new Set(candidateRoleIds))
    .filter((roleId) => input.aiRoleIds.includes(roleId))
    .filter((roleId) => roleId !== input.latestMessage.speaker_role_id)
    .filter((roleId) => roleId !== input.userRoleId)
    .filter((roleId) => !input.excludedTargets.includes(roleId) && !input.failedPlannerRoles.includes(roleId));
  const informationShare = !targetRoleIds.length && input.phase === "free_discussion";
  if (!targetRoleIds.length) {
    const eligible = roleIds.flatMap(roleId => {
      const booklet = input.booklets.find(b => b.role_id === roleId);
      // Positive current-act publication permission only. Never mine private text,
      // other acts or infer a role's hidden knowledge to manufacture a speaker.
      const allowed = [...(booklet?.must_share ?? []), ...(booklet?.may_share ?? [])].filter(fact => fact.trim() &&
        !(booklet?.must_not_share ?? []).some(secret => secret.trim() && (fact.includes(secret) || secret.includes(fact))));
      if (!allowed.length) return [];
      const publicFacts = new Set(input.messages.filter(m => m.metadata.act_id === input.actId).flatMap(m => m.metadata.revealed_facts));
      const unshared = allowed.filter(fact => !publicFacts.has(fact));
      if (informationShare && !unshared.length) return [];
      const spoken = input.messages.filter(m => m.speaker_type === "ai_player" && m.speaker_role_id === roleId &&
        (m.metadata.act_id === input.actId || !m.metadata.act_id && !input.actId.startsWith("runtime_act_")) && m.phase === input.phase);
      const relevant = input.prefilterCandidates.find(c => c.roleId === roleId)?.roughScore ?? 0;
      return [{ roleId, count: spoken.length, freshFacts: unshared.length > 0 ? 1 : 0, relevant }];
    }).sort((a, b) => a.count - b.count || b.freshFacts - a.freshFacts || b.relevant - a.relevant);
    roleIds = eligible.map(r => r.roleId);
  }
  roleIds = roleIds.slice(0, maxFallbackCount);

  return roleIds.map((roleId) => {
    const directed = input.triggerClassification.triggerType === "directed_question";

    return withReactionDebugFlags(
      {
        role_id: roleId,
        wants_to_speak: true,
        trigger_type: directed ? "direct_question_to_self" : "minor_relevance",
        relevance_score: directed ? 5 : input.phase === "share_round" ? 5 : 4,
        urgency_score: directed ? 4 : 3,
        emotional_intensity_score: 2,
        boundary_risk: "low",
        target_role_ids:
          input.latestMessage.speaker_role_id &&
          input.latestMessage.speaker_role_id !== "system"
            ? [input.latestMessage.speaker_role_id]
            : [],
        speech_act: directed
          ? input.latestMessage.speaker_type === "dm"
            ? "answer_dm_question"
            : input.latestMessage.speaker_type === "user" ? "answer_user_question" : "answer"
          : "answer_group_question",
        reason: directed
          ? "The latest message directly asked this role a question, but ordinary planning selected none"
          : "优先邀请当前阶段较少发言、有合法公开内容的角色回应",
        brief_intent: directed
          ? "先直接回应对方点名的问题；使用当前幕可公开的相关事实回答，再说明不确定性，不要额外爆料。"
          : informationShare ? "根据自己的当前幕 mustShare/mayShare，自然补充一两点允许公开、尚未充分分享的相关信息；只说自己能确认的部分。若没有相关事实可以说明不确定，但不要机械重复不知道。遵守 mustNotShare 和当前阶段限制；不编造、不替其他角色确认，不必回应每一句。"
          : "直接回应眼前的互动问题。偏好或假设问题可以表达自己的选择与感受，不要机械当作记忆测验、反复重复姓名年龄或不知道；涉及剧情事实时仍只用本幕许可信息，不能编造经历或透露 mustNotShare。"
      },
      {
        triggered_by_group_question: !directed,
        scheduler_bypassed_threshold: !directed
      }
    );
  });
}

function withReactionDebugFlags(
  intent: ReactionIntent,
  flags: Partial<ReactionIntentWithDebugFlags>
): ReactionIntent {
  return {
    ...intent,
    ...flags
  } as ReactionIntent;
}

function isQuestionLike(message: Message): boolean {
  return (
    message.speech_act === "question" ||
    message.speech_act === "clarify" ||
    message.speech_act === "dm_prompt" ||
    message.speech_act === "dm_directed_question" ||
    message.speech_act === "group_question" ||
    message.metadata.questions_raised.length > 0 ||
    /[?？]|吗|呢|有没有|怎么看|觉得|谁|哪位|有人|要不要|注意到|想问|补充|说说|说一下|聊聊|回答|回应|请.+说|请.+答/.test(
      message.content
    )
  );
}

function isOpenDmQuestionText(content: string): boolean {
  return /[?？]|吗|呢|有没有|记起来|想起来|怎么看|觉得|谁|哪位|要不要|注意到|补充|说说|说一下|聊聊|回答|回应/.test(
    content
  );
}

type ExecuteReactionsInput = { gameSessionId: string; latestMessageId: string; selectedReactions: ReactionIntent[]; conversationRevision?: number; responseDeadlineMs?: number };

export async function executeSelectedReactions(input: ExecuteReactionsInput): Promise<ExecuteSelectedReactionsResult> {
  const result = await withConversation(input.gameSessionId, input.latestMessageId, () => executeReactionBatch(input));
  if (!result) throw new Error("对话正在由另一个 worker 执行。");
  return result;
}

async function executeReactionBatch({
  gameSessionId,
  latestMessageId,
  selectedReactions,
  conversationRevision,
  responseDeadlineMs
}: ExecuteReactionsInput): Promise<ExecuteSelectedReactionsResult> {
  if (await (await import("@/src/lib/services/runtimeInputPolicy")).isRuntimeChoiceOnly(gameSessionId))
    throw new Error("当前请先完成结构化选择，不能执行普通AI发言。");
  const startedAt = Date.now();
  const [initialSession, latestMessage, script] = await Promise.all([
    getGameSession(gameSessionId),
    getMessageInGame(gameSessionId, latestMessageId),
    getScriptForGameSession(gameSessionId)
  ]);
  const definition = initialSession.runtimeDefinitionId ? await (await import("@/src/lib/services/scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(initialSession.runtimeDefinitionId) : null;
  const dmInteraction = (await import("../services/publicDiscussionContext")).currentDMInteraction(initialSession, await listMessages(gameSessionId), latestMessage);
  if (discussionPacing(initialSession, definition?.definition).mode === "dm_performance" || dmInteraction?.kind === "player_followup") {
    const allowed = dmInteraction?.kind === "player_followup" ? dmInteraction.target_role_ids : performanceResponders(initialSession, latestMessage, resolveMessageAddressing(latestMessage, script.roles).directTargets);
    if (selectedReactions.some(r => !allowed.includes(r.role_id)))
      throw new Error("演绎阶段只能回应DM当前问题，不能执行玩家间讨论。");
  }

  if (
    initialSession.currentPhase !== "share_round" &&
    initialSession.currentPhase !== "free_discussion" &&
    initialSession.currentPhase !== "dm_question"
  ) {
    throw new Error("只有分享、自由讨论或 DM 提问阶段可以执行 AI 反应。");
  }

  const restricted = await (await import("@/src/lib/services/runtimeInputPolicy")).runtimeInputPolicy(gameSessionId);
  if (restricted && ["answer_only","directed_sharing"].includes(restricted.policy) && selectedReactions.some(r => !restricted.targets.includes(r.role_id)))
    throw new Error("当前独立回答窗口仅允许指定角色回应。");
  if (selectedReactions.length > 6) {
    throw new Error("一次最多执行 6 个 AI 反应。");
  }

  const executorRun = await createAgentRun({
    gameSessionId,
    agentType: "discussion_reaction_executor",
    actId: initialSession.currentActId,
    phase: initialSession.currentPhase,
    inputJson: {
      latestMessageId,
      responseDeliveryPolicy: 1,
      selectedReactions: selectedReactions.map(compactReactionIntent)
    }
  });
  const createdMessages: Message[] = [];
  const checkerResults: DiscussionCheckerOutput[] = [];
  const blockedReactions: BlockedReaction[] = [];
  const executedReactions: ExecutedReaction[] = [];
  const attempts: DiscussionAttemptDebug[] = [];
  const baseRevision = conversationRevision ?? (inConversation() ? (await ensureConversation(gameSessionId)).revision : 0);
  let updatedStoryBoard = await getOrCreatePublicStoryBoard(gameSessionId);
  let updatedGameSession = initialSession;

  try {
    for (const selectedReaction of selectedReactions) {
      if (selectedReaction.speech_act === "none" || !selectedReaction.wants_to_speak) {
        blockedReactions.push({
          selectedReaction,
          reason: "该 ReactionIntent 不需要发言。"
        });
        continue;
      }
      if (await prisma.message.count({ where: { gameSessionId, speakerType: "ai_player",
        speakerRoleId: selectedReaction.role_id, OR: [{ replyToMessageId: latestMessageId }, { metadata: { contains: `"discussionSourceMessageId":${JSON.stringify(latestMessageId)}` } }] } })) continue;
      const optional = !(selectedReaction.speech_act === "clarify" && selectedReaction.trigger_type === "minor_relevance") &&
        (isQuestionLike(latestMessage) || selectedReaction.speech_act.startsWith("answer"));
      if (optional && (await getResponseDeliveries(gameSessionId)).get(responseKey(latestMessageId, selectedReaction.role_id))?.skipped) {
        await settleFailedDMResponse(gameSessionId, latestMessageId, selectedReaction.role_id);
        continue;
      }
      if (!await beginConversationTurn(gameSessionId, selectedReaction.role_id, baseRevision)) break;
      const delivery = optional ? await beginResponseDelivery({ gameId: gameSessionId, messageId: latestMessageId,
        roleId: selectedReaction.role_id, actId: initialSession.currentActId, phase: initialSession.currentPhase }) : null;
      try {
      const currentSession = await getGameSession(gameSessionId);
      const pending = currentSession.dmFlowCursor?.pendingDMQuestion;
      if (pending?.messageId === latestMessageId && ["waiting", "partial_answered"].includes(pending.status) &&
        pending.targetRoleNames.includes(selectedReaction.role_id)) {
        if (responseDeadlineMs !== undefined && Date.now() >= responseDeadlineMs) throw new Error("DM response deadline expired");
        await updateGameSession(gameSessionId, { dmFlowCursor: { ...currentSession.dmFlowCursor!,
          pendingDMQuestion: { ...pending, responseAttempts: (pending.responseAttempts ?? 0) + 1, responseLastError: null } } });
      }
      const invokeAttempt = (input: Parameters<typeof runDiscussionAttempt>[0]) => optional ? withOptionalResponse(() => runDiscussionAttempt(input)) : runDiscussionAttempt(input);
      const firstAttempt = await invokeAttempt({
        gameSessionId,
        latestMessageId,
        selectedReaction,
        attempt: 1,
        responseDeadlineMs
      });
      attempts.push(toDiscussionAttemptDebug(firstAttempt));
      const secondAttempt =
        firstAttempt.checker.output.decision === "rewrite_required"
          ? await invokeAttempt({
              gameSessionId,
              latestMessageId,
              selectedReaction,
              attempt: 2,
              responseDeadlineMs,
              repairInstructions: buildDiscussionRepairInstructions(firstAttempt)
            })
          : null;

      if (secondAttempt) {
        attempts.push(toDiscussionAttemptDebug(secondAttempt));
      }

      const finalAttempt = secondAttempt ?? firstAttempt;

      checkerResults.push(firstAttempt.checker.output);
      if (secondAttempt) {
        checkerResults.push(secondAttempt.checker.output);
      }

      if (!isDiscussionCheckerPassed(finalAttempt.checker.output)) {
        if (delivery) { await finishResponseDelivery(delivery.id, "failed", finalAttempt.checker.output.rewrite_advice ?? "Checker未通过");
          await settleFailedDMResponse(gameSessionId, latestMessageId, selectedReaction.role_id, finalAttempt.checker.output.rewrite_advice ?? "Checker未通过"); }
        blockedReactions.push({
          selectedReaction,
          checkerResult: finalAttempt.checker.output,
          reason: finalAttempt.checker.output.rewrite_advice ?? "Discussion Checker 未通过。"
        });
        await conversationStage("planning");
        continue;
      }

      const sessionBeforeWrite = await getGameSession(gameSessionId);
      if (sessionBeforeWrite.currentActId !== initialSession.currentActId || sessionBeforeWrite.currentPhase !== initialSession.currentPhase) break;
      const clueIds = finalAttempt.candidate.output.formal_clue_ids ?? [];
      if (clueIds.length) {
        const scope = finalAttempt.candidate.context.clue_scope;
        if (!scope) throw new Error("AI正式分享缺少有效线索上下文。");
        await (await import("@/src/lib/services/runtimeClueService")).shareAIRuntimeClues(gameSessionId, selectedReaction.role_id, clueIds, scope);
      }
      const message = await createMessage({
        gameSessionId,
        speakerType: "ai_player",
        speakerRoleId: selectedReaction.role_id,
        speakerName: getRoleName(script, selectedReaction.role_id),
        targetRoleIds: selectedReaction.target_role_ids,
        replyToMessageId: finalAttempt.candidate.context.publication_mode === "act_share" ? null : latestMessageId,
        phase: sessionBeforeWrite.currentPhase,
        speechAct: selectedReaction.speech_act as SpeechAct,
        content: finalAttempt.candidate.output.content,
        metadata: { ...finalAttempt.candidate.output.metadata, discussionSourceMessageId: latestMessageId, discussionAddressingMode: finalAttempt.candidate.context.publication_mode === "act_share" ? "public" : "reply", discussionPublicationMode: finalAttempt.candidate.context.publication_mode ?? "reply",
          discussionFollowupAllowed: finalAttempt.candidate.context.discussion_pacing?.allow_followup_question ?? false,
          runtimeInputPolicy: finalAttempt.candidate.context.input_policy ?? undefined }
      });
      if (delivery) await finishResponseDelivery(delivery.id, "published");
      await enqueuePublicMessageForStoryBoard({ gameSessionId, message });
      updatedGameSession = inConversation() ? await getGameSession(gameSessionId) : await updateGameSession(gameSessionId, {
        discussionTurnCount: sessionBeforeWrite.discussionTurnCount + 1
      });
      createdMessages.push(message);
      executedReactions.push({
        selectedReaction,
        candidate: finalAttempt.candidate.output,
        checkerResult: finalAttempt.checker.output,
        checkerMode: finalAttempt.checker.checkerMode,
        message
      });
      } catch (error) {
        let cause = error as { name?: string; cause?: unknown } | undefined;
        let interrupted = false;
        for (let depth = 0; cause && depth < 6; depth++, cause = cause.cause as typeof cause) {
          if (cause instanceof StaleConversationError || cause.name === "AbortError") { interrupted = true; break; }
        }
        if (!delivery || interrupted) {
          if (delivery) await finishResponseDelivery(delivery.id, "cancelled");
          throw error;
        }
        const reason = redactLlmSecrets(error instanceof Error ? error.message : String(error));
        await finishResponseDelivery(delivery.id, "failed", reason);
        await settleFailedDMResponse(gameSessionId, latestMessageId, selectedReaction.role_id, reason);
        if (["authentication", "quota", "test_budget"].includes(normalizeLlmError(error).type)) throw error;
        blockedReactions.push({ selectedReaction, reason });
        await conversationStage("planning");
      }
    }

    const result: ExecuteSelectedReactionsResult = {
      latestMessage,
      selectedReactions,
      createdMessages,
      checkerResults,
      blockedReactions,
      updatedStoryBoard,
      updatedGameSession,
      executedReactions,
      attempts
    };

    await completeAgentRun({
      agentRunId: executorRun.id,
      outputJson: result,
      latencyMs: Date.now() - startedAt
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execute selected reactions failed.";

    await failAgentRun({
      agentRunId: executorRun.id,
      error: "discussion_reaction_executor_failed",
      errorMessage: message,
      latencyMs: Date.now() - startedAt
    });

    throw error;
  }
}

function buildCompactReactionContext(input: {
  knowledge?: DiscussionKnowledge;
  memoryConnections?: MemoryConnection[];
  roleId: RoleId;
  script: Script;
  candidate: ReactionCandidate;
  latestMessage: Message;
  publicStoryBoard: PublicStoryBoard;
  reactionProfile: ReactionProfile;
  phase: GamePhase;
  discussionTurnCount: number;
  maxDiscussionTurns: number;
  addressingContext: NonNullable<CompactReactionContext["addressing_context"]>;
}): CompactReactionContext {
  const roleName = input.script.roles.find((role) => role.role_id === input.roleId)?.name;

  return {
    knowledge: input.knowledge,
    memory_connections: input.memoryConnections,
    addressing_context: input.addressingContext,
    role: {
      role_id: input.roleId,
      name: roleName ?? input.roleId
    },
    latest_message: {
      id: input.latestMessage.message_id,
      speaker_role_id: input.latestMessage.speaker_role_id,
      target_role_ids: input.latestMessage.target_role_ids ?? [],
      speech_act: input.latestMessage.speech_act,
      content: input.latestMessage.content,
      metadata: input.latestMessage.metadata
    },
    role_reaction_profile: input.knowledge ? { ...input.reactionProfile,
      current_act_speakable_topics: [...input.knowledge.current_role_booklet?.mustShare ?? [], ...input.knowledge.current_role_booklet?.mayShare ?? []],
      forbidden_boundaries_summary: input.knowledge.restrictions.filter(r => r.id.startsWith("profile.")).map(r => r.text)
    } : input.reactionProfile,
    public_state_brief: buildPublicStateBrief(
      input.publicStoryBoard,
      input.latestMessage,
      input.reactionProfile,
      input.roleId
    ),
    discussion_state: {
      phase: input.phase,
      discussion_turn_count: input.discussionTurnCount,
      max_discussion_turns: input.maxDiscussionTurns
    },
    prefilter: input.candidate
  };
}

async function runDiscussionAttempt(input: {
  gameSessionId: string;
  latestMessageId: string;
  selectedReaction: ReactionIntent;
  attempt: 1 | 2;
  repairInstructions?: unknown;
  responseDeadlineMs?: number;
}): Promise<{
  attempt: 1 | 2;
  candidate: Awaited<ReturnType<typeof runAiPlayerDiscussionUtterance>>;
  checker: Awaited<ReturnType<typeof runDiscussionChecker>>;
}> {
  const remaining = () => {
    if (input.responseDeadlineMs === undefined) return {};
    const timeoutMs = input.responseDeadlineMs - Date.now();
    if (timeoutMs <= 0) throw new Error("DM response deadline expired");
    return { timeoutMs, signal: AbortSignal.timeout(timeoutMs) };
  };
  const candidate = await runAiPlayerDiscussionUtterance({
    ...remaining(),
    gameSessionId: input.gameSessionId,
    latestMessageId: input.latestMessageId,
    selectedReaction: input.selectedReaction,
    repairInstructions: input.repairInstructions
      ? {
          attempt: input.attempt,
          ...asRecord(input.repairInstructions)
        }
      : null
  });
  await conversationStage("checking");
  const checker = await runDiscussionChecker({
    ...remaining(),
    gameSessionId: input.gameSessionId,
    roleId: input.selectedReaction.role_id,
    context: candidate.context,
    candidate: candidate.output,
    attempt: input.attempt
  });

  return {
    attempt: input.attempt,
    candidate,
    checker
  };
}

function isDiscussionCheckerPassed(output: DiscussionCheckerOutput): boolean {
  return output.passed && output.decision === "pass";
}

function buildDiscussionRepairInstructions(input: {
  attempt: 1 | 2;
  candidate: Awaited<ReturnType<typeof runAiPlayerDiscussionUtterance>>;
  checker: Awaited<ReturnType<typeof runDiscussionChecker>>;
}) {
  return {
    previous_attempt: input.attempt,
    previous_content: input.candidate.output.content,
    checker_mode: input.checker.checkerMode,
    retry_hint: input.checker.output.rewrite_advice,
    violations: [
      ...input.checker.output.leakage.items,
      ...input.checker.output.boundary.items,
      ...input.checker.output.intent_alignment.issues,
      ...input.checker.output.role_consistency.issues,
      ...input.checker.output.quality.issues
    ].slice(0, 6)
  };
}

function toDiscussionAttemptDebug(input: {
  attempt: 1 | 2;
  candidate: Awaited<ReturnType<typeof runAiPlayerDiscussionUtterance>>;
  checker: Awaited<ReturnType<typeof runDiscussionChecker>>;
}): DiscussionAttemptDebug {
  return {
    roleId: input.candidate.roleId,
    attempt: input.attempt,
    candidate: input.candidate.output,
    checkerResult: input.checker.output,
    checkerMode: input.checker.checkerMode,
    checkerLlmInvoked: input.checker.llmInvoked,
    checkerDeterministicLatencyMs: input.checker.deterministicLatencyMs
  };
}

async function getReactionProfiles(
  gameSessionId: string,
  aiRoleIds: RoleId[]
): Promise<Partial<Record<RoleId, ReactionProfile>>> {
  const entries = await Promise.all(
    aiRoleIds.map(async (roleId) => {
      const memory = await getRoleMemory(gameSessionId, roleId);

      return [roleId, memory.reaction_profile ?? createEmptyReactionProfile()] as const;
    })
  );

  return Object.fromEntries(entries);
}

function buildPublicStateBrief(
  board: PublicStoryBoard,
  latestMessage: Message,
  reactionProfile: ReactionProfile,
  roleId: RoleId
): CompactReactionContext["public_state_brief"] {
  const signals = [
    roleId,
    latestMessage.speaker_role_id ?? "",
    ...latestMessage.metadata.mentioned_role_ids,
    ...latestMessage.metadata.event_tags,
    ...latestMessage.metadata.topic_tags,
    ...reactionProfile.known_event_tags,
    ...reactionProfile.current_act_speakable_topics
  ];

  return {
    related_known_facts: pickRelated(board.known_facts, signals),
    related_open_questions: pickRelated(board.open_questions, signals),
    related_conflicts: pickRelated(board.current_conflicts, signals),
    related_emotional_bonds: pickRelated(board.emotional_bonds, signals)
  };
}

function pickRelated(items: string[], signals: string[]): string[] {
  const filtered = items.filter((item) => hasOverlap([item], signals));

  return filtered.slice(-4);
}

function compactMessageForLog(message: Message) {
  return {
    id: message.message_id,
    speakerRoleId: message.speaker_role_id,
    targetRoleIds: message.target_role_ids ?? [],
    phase: message.phase,
    speechAct: message.speech_act,
    metadata: message.metadata
  };
}

function compactPatchSignals(patch: StoryBoardPatch | null) {
  if (!patch) {
    return null;
  }

  return {
    role_ids_involved: patch.role_ids_involved,
    event_tags_added: patch.event_tags_added,
    topic_tags_added: patch.topic_tags_added
  };
}

function compactReactionIntent(intent: ReactionIntent) {
  return {
    role_id: intent.role_id,
    target_role_ids: intent.target_role_ids,
    speech_act: intent.speech_act,
    brief_intent: intent.brief_intent,
    trigger_type: intent.trigger_type,
    relevance_score: intent.relevance_score,
    urgency_score: intent.urgency_score,
    emotional_intensity_score: intent.emotional_intensity_score,
    boundary_risk: intent.boundary_risk,
    wants_to_speak: intent.wants_to_speak
  };
}

function getRoleName(script: Script, roleId: RoleId): string {
  return script.roles.find((role) => role.role_id === roleId)?.name ?? roleId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function createEmptyReactionProfile(): ReactionProfile {
  return {
    known_event_tags: [],
    related_role_ids: [],
    emotional_triggers: [],
    unresolved_questions: [],
    current_act_speakable_topics: [],
    forbidden_boundaries_summary: []
  };
}
