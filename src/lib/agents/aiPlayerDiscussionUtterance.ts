import "server-only";

import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildAiPlayerDiscussionUtterancePrompt } from "@/src/lib/prompts/aiPlayerDiscussionUtterancePrompt";
import {
  AiPlayerDiscussionUtteranceSchema,
  type AiPlayerDiscussionUtteranceOutput
} from "@/src/lib/schemas/aiPlayerDiscussionUtteranceSchema";
import type { ReactionIntent } from "@/src/lib/schemas/reactionIntentSchema";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { DEFAULT_MAX_DISCUSSION_TURNS, getGameSession } from "@/src/lib/services/gameService";
import { listMessages, getMessageInGame } from "@/src/lib/services/messageService";
import { getRoleMemory } from "@/src/lib/services/roleMemoryService";
import { getOrCreatePublicStoryBoard } from "@/src/lib/services/storyBoardService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import { getScriptRuntimeDefinition } from "@/src/lib/services/scriptRuntimeDefinitionService";
import { buildHistoricalPrivateKnowledge, hasCompletedPrivateReading, type HistoricalPrivateKnowledge, type PrivateBookletSource } from "@/src/lib/services/rolePrivateKnowledge";
import type { Message, PublicStoryBoard, ReactionProfile, RoleMemory } from "@/src/lib/types/game";
import { currentIdentityAnchor } from "@/src/lib/services/roleIdentity";
import { presentPublicFacts } from "@/src/lib/services/publicStoryBoardPresentation";
import { discussionPacing, isActualDiscussionQuestion } from "@/src/lib/services/discussionPacing";

export type DiscussionUtteranceContext = {
  public_choice_context?: ReturnType<typeof import("../services/publicDiscussionContext").publicChoiceContext>;
  dm_interaction?: import("../services/publicDiscussionContext").DMInteraction;
  reply_context?: CompactMessage | null;
  public_audience?: import("../orchestration/addressingResolution").PublicRole[];
  discussion_pacing?: { mode: "discussion" | "dm_performance"; allow_followup_question: boolean };
  identity_anchor?: ReturnType<typeof currentIdentityAnchor>;
  publication_mode?: "act_share" | "reply";
  own_act_messages?: string[];
  input_policy?: "choice_only" | "answer_only" | "directed_sharing" | null;
  runtime_clues?: import("@/src/lib/schemas/runtimeClueSchema").VisibleRuntimeClue[];
  clue_scope?: import("@/src/lib/schemas/runtimeClueSchema").ClueScope;
  game_session: {
    gameId: string;
    currentActId: string;
    currentPhase: string;
    discussionTurnCount: number;
    maxDiscussionTurns: number;
  };
  role: {
    role_id: RoleId;
    name: string;
  };
  latest_message: CompactMessage;
  selected_reaction: Pick<
    ReactionIntent,
    | "role_id"
    | "target_role_ids"
    | "speech_act"
    | "brief_intent"
    | "relevance_score"
    | "urgency_score"
    | "trigger_type"
    | "emotional_intensity_score"
    | "boundary_risk"
  >;
  direct_answer_mode: {
    enabled: boolean;
    speech_act: "answer_dm_question" | "answer_user_question" | "answer_group_question" | null;
    question_topic: string;
    mentioned_entities: string[];
    requested_time_or_event: string[];
    requested_object: string[];
  };
  current_role_booklet: {
    roleName: string;
    actIndex: number;
    privateText: string;
    mustShare: string[];
    mayShare: string[];
    mustNotShare: string[];
    emotionalPoints: string[];
    relationshipPoints: string[];
    timelineFragments: string[];
  } | null;
  historical_private_knowledge?: HistoricalPrivateKnowledge;
  own_role_memory_summary: {
    beliefs: string[];
    emotional_state: string;
    unresolved_questions: string[];
  };
  role_reaction_profile: ReactionProfile;
  public_state_brief: {
    related_known_facts: string[];
    related_open_questions: string[];
    related_conflicts: string[];
    related_emotional_bonds: string[];
  };
  recent_public_messages: CompactMessage[];
};

type CompactMessage = {
  id: string;
  speaker_role_id: string | null;
  speaker_name: string | null;
  target_role_ids: RoleId[];
  speech_act: string;
  content: string;
  metadata: Message["metadata"];
};

export type RunAiPlayerDiscussionUtteranceInput = {
  gameSessionId: string;
  latestMessageId: string;
  selectedReaction: ReactionIntent;
  mockOutput?: unknown;
  repairInstructions?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type RunAiPlayerDiscussionUtteranceResult = {
  roleId: RoleId;
  output: AiPlayerDiscussionUtteranceOutput;
  agentRunId: string;
  context: DiscussionUtteranceContext;
};

export async function runAiPlayerDiscussionUtterance({
  gameSessionId,
  latestMessageId,
  selectedReaction,
  mockOutput,
  repairInstructions = null,
  timeoutMs, signal
}: RunAiPlayerDiscussionUtteranceInput): Promise<RunAiPlayerDiscussionUtteranceResult> {
  const context = await buildDiscussionUtteranceContext(
    gameSessionId,
    latestMessageId,
    selectedReaction
  );
  const result = await generateStructured<AiPlayerDiscussionUtteranceOutput>({
    gameSessionId,
    agentType: "ai_player_discussion_utterance",
    roleId: selectedReaction.role_id,
    actId: context.game_session.currentActId,
    phase: context.game_session.currentPhase,
    schemaName: "ai_player_discussion_utterance",
    zodSchema: AiPlayerDiscussionUtteranceSchema,
    messages: buildAiPlayerDiscussionUtterancePrompt(context, repairInstructions),
    temperature: 0.7,
    maxOutputTokens: context.publication_mode === "act_share" ? 1500 : 900,
    reasoningEffort: "none",
    timeoutMs, signal,
    metadata: {
      compressionSafety: { protectedPublicMessageIds: context.recent_public_messages.map(m => m.id) },
      reasoningMode: "none",
      responseKind: "discussion_utterance"
    },
    mockOutput: mockOutput ?? createMockDiscussionUtterance(context)
  });

  return {
    roleId: selectedReaction.role_id,
    output: result.data,
    agentRunId: result.agentRunId,
    context
  };
}

export async function buildDiscussionUtteranceContext(
  gameSessionId: string,
  latestMessageId: string,
  selectedReaction: ReactionIntent
): Promise<DiscussionUtteranceContext> {
  const [session, latestMessage, memory, board, allMessages, script] = await Promise.all([
    getGameSession(gameSessionId),
    getMessageInGame(gameSessionId, latestMessageId),
    getRoleMemory(gameSessionId, selectedReaction.role_id),
    getOrCreatePublicStoryBoard(gameSessionId),
    listMessages(gameSessionId),
    getScriptForGameSession(gameSessionId)
  ]);
  const reactionProfile = memory.reaction_profile ?? createEmptyReactionProfile();
  const roleName =
    script.roles.find((role) => role.role_id === selectedReaction.role_id)?.name ??
    selectedReaction.role_id;
  const definition = session.runtimeDefinitionId ? await getScriptRuntimeDefinition(session.runtimeDefinitionId) : null;
  const currentRoleBooklet = await getCurrentRoleBooklet({
    definition,
    gameSessionId,
    runtimeDefinitionId: session.runtimeDefinitionId ?? null,
    script,
    roleName,
    roleId: selectedReaction.role_id,
    currentActId: session.currentActId,
    memory
  });
  const readable = definition ? (await (await import("@/src/lib/services/runtimeDefinitionSessionService")).getRuntimeReadingSourcesForGameSession({
    gameSessionId, roleName: selectedReaction.role_id }))?.booklets ?? [] : [];
  const identitySources = readable.filter(b => hasCompletedPrivateReading({ ...b,
    actId: `runtime_act_${b.actIndex}`, definitionId: session.runtimeDefinitionId ?? null }, memory));

  const { publicChoiceContext, currentDMInteraction } = await import("../services/publicDiscussionContext");
  const interaction = currentDMInteraction(session, allMessages, latestMessage);
  const replyParent = allMessages.find(m => m.message_id === latestMessage.reply_to_message_id);
  return {
    public_choice_context: publicChoiceContext(session, definition, allMessages, selectedReaction.role_id),
    dm_interaction: interaction?.target_role_ids.includes(selectedReaction.role_id) ? interaction : null,
    reply_context: replyParent ? toCompactMessage(replyParent) : null,
    public_audience: (await import("../orchestration/addressingResolution")).publicDiscussionRoster(script.roles, allMessages),
    discussion_pacing: {
      mode: interaction ? "dm_performance" : discussionPacing(session, definition?.definition).mode,
      allow_followup_question: !interaction && discussionPacing(session, definition?.definition).mode === "discussion" &&
        (selectedReaction.speech_act === "question" || selectedReaction.trigger_type === "memory_connection") &&
        !(latestMessage.speaker_type === "ai_player" && isActualDiscussionQuestion(latestMessage))
    },
    identity_anchor: currentIdentityAnchor(identitySources.length ? identitySources : currentRoleBooklet ? [currentRoleBooklet] : [], selectedReaction.role_id),
    publication_mode: selectedReaction.speech_act === "clarify" && selectedReaction.trigger_type === "minor_relevance" ? "act_share" : "reply",
    own_act_messages: allMessages.filter(m => m.speaker_role_id === selectedReaction.role_id && m.speaker_type === "ai_player" && m.metadata.act_id === session.currentActId).map(m => m.content).slice(-8),
    game_session: {
      gameId: session.gameId,
      currentActId: session.currentActId,
      currentPhase: session.currentPhase,
      discussionTurnCount: session.discussionTurnCount,
      maxDiscussionTurns:
        session.currentPhase === "free_discussion"
          ? Math.max(session.maxDiscussionTurns, DEFAULT_MAX_DISCUSSION_TURNS)
          : session.maxDiscussionTurns
    },
    role: {
      role_id: selectedReaction.role_id,
      name: roleName
    },
    input_policy: (await (await import("@/src/lib/services/runtimeInputPolicy")).runtimeInputPolicy(gameSessionId))?.policy ?? null,
    latest_message: toCompactMessage(latestMessage),
    selected_reaction: {
      role_id: selectedReaction.role_id,
      target_role_ids: selectedReaction.target_role_ids,
      speech_act: selectedReaction.speech_act,
      brief_intent: selectedReaction.brief_intent,
      relevance_score: selectedReaction.relevance_score,
      urgency_score: selectedReaction.urgency_score,
      trigger_type: selectedReaction.trigger_type,
      emotional_intensity_score: selectedReaction.emotional_intensity_score,
      boundary_risk: selectedReaction.boundary_risk
    },
    direct_answer_mode: buildDirectAnswerMode(latestMessage, selectedReaction),
    current_role_booklet: currentRoleBooklet,
    runtime_clues: await (await import("@/src/lib/services/runtimeClueService")).getRoleRuntimeClues(gameSessionId, selectedReaction.role_id, session),
    clue_scope: session.runtimeDefinitionId && session.dmFlowCursor?.lifecycle ? { definitionId: session.runtimeDefinitionId,
      definitionVersion: session.dmFlowCursor.lifecycle.definitionVersion, actId: session.currentActId } : undefined,
    historical_private_knowledge: buildHistoricalPrivateKnowledge({
      booklets: definition ? readable.map(b => ({ ...b, actId: `runtime_act_${b.actIndex}`, definitionId: session.runtimeDefinitionId! })) :
        script.acts.flatMap((a, i) => a.booklets.filter(b => b.role_id === selectedReaction.role_id).map(b => ({
          roleName: roleName, actIndex: i + 1, actId: a.act_id, definitionId: null, sourceRoleActBookletId: `${a.act_id}:${b.role_id}`,
          privateText: b.private_text, mustShare: b.must_share, mayShare: b.may_share, mustNotShare: b.must_not_share,
          emotionalPoints: [], relationshipPoints: [], timelineFragments: []
        } satisfies PrivateBookletSource))),
      roleNames: [roleName, selectedReaction.role_id], currentActIndex: currentRoleBooklet?.actIndex ?? getRuntimeActIndex(session.currentActId) ?? script.acts.findIndex(a => a.act_id === session.currentActId) + 1, memory,
      query: [latestMessage.content, replyParent?.content ?? "", ...latestMessage.metadata.event_tags, ...latestMessage.metadata.topic_tags].join(" ")
    }),
    own_role_memory_summary: summarizeRoleMemory(memory),
    role_reaction_profile: reactionProfile,
    public_state_brief: buildPublicStateBrief({ ...board, known_facts: presentPublicFacts(board.known_facts, allMessages).facts }, latestMessage, reactionProfile, selectedReaction.role_id),
    recent_public_messages: allMessages.slice(-6).map(toCompactMessage)
  };
}

async function getCurrentRoleBooklet(input: {
  definition: Awaited<ReturnType<typeof getScriptRuntimeDefinition>> | null;
  gameSessionId: string;
  runtimeDefinitionId: string | null;
  script: Awaited<ReturnType<typeof getScriptForGameSession>>;
  roleName: string;
  roleId: RoleId;
  currentActId: string;
  memory: RoleMemory;
}): Promise<DiscussionUtteranceContext["current_role_booklet"]> {
  const actIndex = getRuntimeActIndex(input.currentActId);

  if (input.runtimeDefinitionId && actIndex) {
    const sources = await (await import("@/src/lib/services/runtimeDefinitionSessionService")).getRuntimeReadingSourcesForGameSession({
      gameSessionId: input.gameSessionId, roleName: input.roleId, actIndex });
    const booklet = (await import("@/src/lib/services/runtimeReadingSources")).combineReadingBooklets((sources?.booklets ?? [])
      .filter(b => hasCompletedPrivateReading({ ...b, actId: input.currentActId, definitionId: input.runtimeDefinitionId }, input.memory)));

    if (booklet) {
      return {
        roleName: booklet.roleName,
        actIndex: booklet.actIndex,
        privateText: booklet.privateText,
        mustShare: booklet.mustShare,
        mayShare: booklet.mayShare,
        mustNotShare: booklet.mustNotShare,
        emotionalPoints: booklet.emotionalPoints,
        relationshipPoints: booklet.relationshipPoints,
        timelineFragments: booklet.timelineFragments
      };
    }
    // Never fall back to the unfiltered Script adapter for an unread or
    // unauthorized runtime source (including an unselected branch).
    return null;
  }

  const act = input.script.acts.find((candidate) => candidate.act_id === input.currentActId);
  const booklet = act?.booklets.find((candidate) => candidate.role_id === input.roleId);

  if (!booklet) {
    return null;
  }
  const fallbackActIndex = act ? input.script.acts.indexOf(act) + 1 : 1;

  return {
    roleName: input.roleName,
    actIndex: actIndex ?? fallbackActIndex,
    privateText: booklet.private_text,
    mustShare: booklet.must_share,
    mayShare: booklet.may_share,
    mustNotShare: booklet.must_not_share,
    emotionalPoints: [],
    relationshipPoints: [],
    timelineFragments: []
  };
}

function buildDirectAnswerMode(
  latestMessage: Message,
  selectedReaction: ReactionIntent
): DiscussionUtteranceContext["direct_answer_mode"] {
  const speechAct = getDirectAnswerSpeechAct(latestMessage, selectedReaction);

  return {
    enabled: speechAct !== null,
    speech_act: speechAct,
    question_topic: latestMessage.content,
    mentioned_entities: extractMentionedEntities(latestMessage.content),
    requested_time_or_event: extractMatches(latestMessage.content, /(?:\d{4}\s*年|\d+\s*月|\d+\s*日|那天|当时|过去|小时候|第.+幕|坠楼案|七氟烷|赵恒诚)/g),
    requested_object: extractMatches(latestMessage.content, /(?:信|照片|镜子|记事本|药瓶|房间|书房|储物间|道具|录音|视频|天台|别墅)/g)
  };
}

function getDirectAnswerSpeechAct(
  latestMessage: Message,
  selectedReaction: ReactionIntent
): DiscussionUtteranceContext["direct_answer_mode"]["speech_act"] {
  if (
    selectedReaction.speech_act === "answer_dm_question" ||
    selectedReaction.speech_act === "answer_user_question" ||
    selectedReaction.speech_act === "answer_group_question"
  ) {
    return selectedReaction.speech_act;
  }

  if (
    selectedReaction.trigger_type !== "direct_question_to_self" &&
    selectedReaction.speech_act !== "answer"
  ) {
    return null;
  }

  if (latestMessage.speaker_type === "dm") {
    return "answer_dm_question";
  }

  if (latestMessage.speaker_type === "user") {
    return latestMessage.target_role_ids?.length ? "answer_user_question" : "answer_group_question";
  }
  if (latestMessage.speaker_type === "ai_player") return "answer_group_question";

  return null;
}

function extractMentionedEntities(text: string): string[] {
  return extractMatches(text, /[\u4e00-\u9fa5A-Za-z0-9]{2,12}/g)
    .filter((item) => !/你们|大家|有没有|是不是|为什么|怎么看|说说|一下|这个|那个|自己|时候/.test(item))
    .slice(0, 12);
}

function extractMatches(text: string, pattern: RegExp): string[] {
  return Array.from(new Set(text.match(pattern) ?? [])).slice(0, 12);
}

function getRuntimeActIndex(actId: string): number | null {
  const runtimeMatch = actId.match(/runtime_act_(\d+)/);
  const genericMatch = actId.match(/act_(\d+)/);
  const value = runtimeMatch?.[1] ?? genericMatch?.[1];

  return value ? Number(value) : null;
}

function createMockDiscussionUtterance(
  context: DiscussionUtteranceContext
): AiPlayerDiscussionUtteranceOutput {
  const target = context.latest_message.speaker_name ?? "你";
  const question =
    context.selected_reaction.speech_act === "question" ||
    context.selected_reaction.speech_act === "challenge";

  return {
    content: context.direct_answer_mode.enabled
      ? `我不清楚更多细节，但我直接回应你：${context.selected_reaction.brief_intent}`
      : question
        ? `${target}，我想追问一下：${context.selected_reaction.brief_intent}`
        : `我补充一句，${context.selected_reaction.brief_intent}`,
    metadata: {
      revealed_facts: [],
      emotional_points: question ? [] : [context.selected_reaction.brief_intent],
      questions_raised: question ? [context.selected_reaction.brief_intent] : [],
      mentioned_role_ids: context.selected_reaction.target_role_ids,
      event_tags: context.latest_message.metadata.event_tags,
      topic_tags: context.latest_message.metadata.topic_tags
    },
    self_check: {
      follows_brief_intent: true,
      uses_only_allowed_context: true,
      avoids_forbidden_boundaries: true
    }
  };
}

function summarizeRoleMemory(memory: RoleMemory): DiscussionUtteranceContext["own_role_memory_summary"] {
  return {
    beliefs: memory.beliefs.slice(-5),
    emotional_state: memory.emotional_state,
    unresolved_questions: (memory.unresolved_questions ?? []).slice(-5)
  };
}

function buildPublicStateBrief(
  board: PublicStoryBoard,
  latestMessage: Message,
  reactionProfile: ReactionProfile,
  roleId: RoleId
): DiscussionUtteranceContext["public_state_brief"] {
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
  return items.filter((item) => hasOverlap(item, signals)).slice(-4);
}

function hasOverlap(item: string, signals: string[]): boolean {
  const normalizedItem = normalize(item);

  return signals.some((signal) => {
    const normalizedSignal = normalize(signal);

    return (
      normalizedSignal.length > 0 &&
      (normalizedItem.includes(normalizedSignal) || normalizedSignal.includes(normalizedItem))
    );
  });
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function toCompactMessage(message: Message): CompactMessage {
  return {
    id: message.message_id,
    speaker_role_id: message.speaker_role_id,
    speaker_name: message.speaker_name,
    target_role_ids: message.target_role_ids ?? [],
    speech_act: message.speech_act,
    content: message.content,
    metadata: message.metadata
  };
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
