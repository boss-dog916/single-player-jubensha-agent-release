import type { ReactionIntent } from "@/src/lib/schemas/reactionIntentSchema";
import type { Message } from "@/src/lib/types/game";

export type TurnSchedulerInput = {
  reactionIntents: ReactionIntent[];
  latestMessage: Message;
  discussionTurnCount: number;
  maxDiscussionTurns: number;
  maxAiReactionsPerTrigger?: number;
  minRelevanceScore?: number;
  recentSpeakerRoleIds?: string[];
  publicSpeakingCounts?: Record<string, number>;
};

export type TurnSchedulerResult = {
  selected_reactions: ReactionIntent[];
  should_dm_intervene: boolean;
  reason: string;
};

export function scheduleReactionTurns({
  reactionIntents,
  latestMessage,
  discussionTurnCount,
  maxDiscussionTurns,
  maxAiReactionsPerTrigger = 2,
  minRelevanceScore = 3,
  recentSpeakerRoleIds = [],
  publicSpeakingCounts = {}
}: TurnSchedulerInput): TurnSchedulerResult {
  if (discussionTurnCount >= maxDiscussionTurns) {
    return {
      selected_reactions: [],
      should_dm_intervene: true,
      reason: "讨论轮次已达到上限，应由 DM 收束。"
    };
  }

  const forced = reactionIntents
    .filter((intent) => intent.wants_to_speak)
    .filter((intent) => intent.role_id !== latestMessage.speaker_role_id)
    .filter(isForcedByDirectAddress)
    .slice(0, maxAiReactionsPerTrigger);

  if (forced.length > 0) {
    return {
      selected_reactions: forced,
      should_dm_intervene: false,
      reason: `${latestMessage.speaker_type === "dm" ? "DM" : "用户"} 点名触发，绕过普通相关性阈值，选出 ${forced.length} 个被点名 AI。`
    };
  }

  const selected = reactionIntents
    .filter((intent) => intent.wants_to_speak)
    .filter(
      (intent) =>
        intent.relevance_score >= Math.max(minRelevanceScore, 4) ||
        isTriggeredByGroupQuestion(intent)
    )
    .filter(
      (intent) =>
        intent.trigger_type !== "none" &&
        (intent.trigger_type !== "minor_relevance" || isTriggeredByGroupQuestion(intent))
    )
    .filter((intent) => intent.role_id !== latestMessage.speaker_role_id)
    .filter(
      (intent) =>
        intent.speech_act !== "challenge" ||
        intent.relevance_score >= 5 ||
        intent.trigger_type === "negative_or_partial_portrayal_of_self" ||
        intent.trigger_type === "contradiction_with_own_knowledge" ||
        isTargeted(intent, latestMessage)
    )
    .sort((left, right) => {
      if (isTriggeredByGroupQuestion(left) && isTriggeredByGroupQuestion(right)) {
        const informationRank = right.relevance_score - left.relevance_score ||
          boundaryPenalty(left) - boundaryPenalty(right) ||
          (publicSpeakingCounts[left.role_id] ?? 0) - (publicSpeakingCounts[right.role_id] ?? 0) ||
          Number(recentSpeakerRoleIds.includes(left.role_id)) - Number(recentSpeakerRoleIds.includes(right.role_id));
        if (informationRank) return informationRank;
      }
      const leftTargeted = isTargeted(left, latestMessage) ? 1 : 0;
      const rightTargeted = isTargeted(right, latestMessage) ? 1 : 0;

      return (
        triggerPriority(right) - triggerPriority(left) ||
        rightTargeted - leftTargeted ||
        right.emotional_intensity_score - left.emotional_intensity_score ||
        emotionalValue(right) - emotionalValue(left) ||
        right.relevance_score - left.relevance_score ||
        right.urgency_score - left.urgency_score ||
        challengePenalty(left) - challengePenalty(right) ||
        boundaryPenalty(left) - boundaryPenalty(right)
      );
    })
    .slice(0, shouldLimitToOne(reactionIntents, discussionTurnCount, maxDiscussionTurns) ? 1 : maxAiReactionsPerTrigger);

  return {
    selected_reactions: selected,
    should_dm_intervene: false,
    reason:
      selected.length > 0
        ? `选出 ${selected.length} 个最相关 AI 反应候选。`
        : reactionIntents.some(isTriggeredByGroupQuestion)
          ? "用户向全桌提问，但 group_question fallback 未能通过调度。"
        : "没有强触发的 AI 反应候选；轻微相关不发言。"
  };
}

function triggerPriority(intent: ReactionIntent): number {
  if (isTriggeredByGroupQuestion(intent)) {
    return 20;
  }

  const priorities: Record<ReactionIntent["trigger_type"], number> = {
    direct_question_to_self: 50,
    negative_or_partial_portrayal_of_self: 40,
    contradiction_with_own_knowledge: 35,
    memory_connection: 33,
    strong_emotional_trigger: 34,
    minor_relevance: 0,
    none: 0
  };

  return priorities[intent.trigger_type];
}

function emotionalValue(intent: ReactionIntent): number {
  const values: Record<ReactionIntent["speech_act"], number> = {
    empathy: 4,
    emotion: 4,
    clarify: 3,
    question: 2,
    answer: 2,
    answer_dm_question: 3,
    answer_user_question: 3,
    answer_group_question: 2,
    challenge: 0,
    none: 0
  };

  return values[intent.speech_act];
}

function challengePenalty(intent: ReactionIntent): number {
  const justified =
    intent.trigger_type === "negative_or_partial_portrayal_of_self" ||
    intent.trigger_type === "contradiction_with_own_knowledge" ||
    intent.relevance_score >= 5;

  return intent.speech_act === "challenge" && !justified ? 5 : 0;
}

function boundaryPenalty(intent: ReactionIntent): number {
  const penalties: Record<ReactionIntent["boundary_risk"], number> = {
    none: 0,
    low: 0,
    medium: 2,
    high: 5
  };

  return penalties[intent.boundary_risk];
}

function shouldLimitToOne(
  intents: ReactionIntent[],
  discussionTurnCount: number,
  maxDiscussionTurns: number
): boolean {
  const speakable = intents.filter(
    (intent) =>
      intent.wants_to_speak &&
      (intent.relevance_score >= 4 || isTriggeredByGroupQuestion(intent)) &&
      (intent.trigger_type !== "minor_relevance" || isTriggeredByGroupQuestion(intent)) &&
      intent.trigger_type !== "none"
  );
  const hasVeryStrongEmotion = speakable.some(
    (intent) =>
      intent.trigger_type === "strong_emotional_trigger" &&
      intent.emotional_intensity_score >= 4
  );
  const nearDiscussionLimit = discussionTurnCount >= Math.max(0, maxDiscussionTurns - 1);

  return (
    hasVeryStrongEmotion ||
    nearDiscussionLimit ||
    (speakable.length > 0 &&
      speakable.every((intent) => intent.speech_act === "question" || intent.speech_act === "challenge"))
  );
}

function isTargeted(intent: ReactionIntent, latestMessage: Message): boolean {
  return (latestMessage.target_role_ids ?? []).includes(intent.role_id);
}

function isForcedByDirectAddress(intent: ReactionIntent): boolean {
  return Boolean((intent as ReactionIntent & { forced_by_direct_address?: boolean }).forced_by_direct_address);
}

function isTriggeredByGroupQuestion(intent: ReactionIntent): boolean {
  return Boolean((intent as ReactionIntent & { triggered_by_group_question?: boolean }).triggered_by_group_question);
}
