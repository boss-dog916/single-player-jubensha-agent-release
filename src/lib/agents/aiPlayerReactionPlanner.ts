import "server-only";

import { generateStructured } from "@/src/lib/llm/llmClient";
import type { CompactReactionContext } from "@/src/lib/orchestration/discussionOrchestrator";
import { buildAiPlayerReactionPlannerPrompt } from "@/src/lib/prompts/aiPlayerReactionPlannerPrompt";
import {
  ReactionIntentSchema,
  type ReactionIntent
} from "@/src/lib/schemas/reactionIntentSchema";
import type { RoleId } from "@/src/lib/script/scriptTypes";
import { sanitizeAddressing } from "@/src/lib/orchestration/addressingResolution";

export type PlanAiPlayerReactionInput = {
  gameSessionId: string;
  roleId: RoleId;
  actId: string;
  phase: string;
  context: CompactReactionContext;
  mockOutput?: unknown;
};

export type PlanAiPlayerReactionResult = {
  roleId: RoleId;
  intent: ReactionIntent;
  agentRunId: string;
};

export async function planAiPlayerReaction({
  gameSessionId,
  roleId,
  actId,
  phase,
  context,
  mockOutput
}: PlanAiPlayerReactionInput): Promise<PlanAiPlayerReactionResult> {
  const result = await generateStructured<ReactionIntent>({
    gameSessionId,
    agentType: "ai_player_reaction_planner",
    roleId,
    actId,
    phase,
    schemaName: "reaction_intent",
    maxOutputTokens: 800,
    zodSchema: ReactionIntentSchema,
    messages: buildAiPlayerReactionPlannerPrompt(context),
    metadata: { compressionSafety: { protectedPublicMessageIds: context.knowledge?.public_messages.map(m => m.id) } },
    mockOutput: mockOutput ?? createMockReactionIntent(context)
  });

  if (result.data.role_id !== roleId) throw new Error(`Reaction Planner returned a different role: ${result.data.role_id}`);
  let intent: ReactionIntent = { ...result.data,
    ...(result.data.addressing && context.addressing_context ? {
      addressing: sanitizeAddressing(result.data.addressing, context.addressing_context.publicRoster)
    } : {}) };
  const incoming = context.addressing_context?.preAnalysis;
  const sender = context.latest_message.speaker_role_id;
  // A witnessed legacy-demo failure: "我是林安女朋友" was classified as
  // direct_question_to_self, with the reply recipient copied into directTargets.
  // Only repair this narrow statement case. Never redirect genuine questions,
  // group invitations, exclusions or authoritative explicit reply targets.
  if (incoming?.addressingMode === "none" && incoming.needsPlanner && !incoming.controlMessage &&
    incoming.directTargets.length === 0 && incoming.referencedRoles.includes(roleId) &&
    !incoming.excludedTargets.includes(roleId) && context.latest_message.speech_act === "statement" &&
    sender && sender !== roleId && intent.trigger_type === "direct_question_to_self" &&
    intent.addressing?.addressingMode === "direct" && intent.addressing.directTargets.length === 1 &&
    intent.addressing.directTargets[0] === sender && intent.target_role_ids.length === 1 && intent.target_role_ids[0] === sender) {
    intent = { ...intent, trigger_type: "minor_relevance", addressing: {
      addressingMode: "none", directTargets: [], referencedRoles: incoming.referencedRoles,
      excludedTargets: incoming.excludedTargets, topic: incoming.topic
    }, reason: `${intent.reason}；原消息为角色关联陈述，回复接收者不是原问题的提问对象。` };
  }
  return {
    roleId,
    intent,
    agentRunId: result.agentRunId
  };
}

function createMockReactionIntent(context: CompactReactionContext): ReactionIntent {
  const triggerType = inferTriggerType(context.prefilter.matchedSignals);
  const addressing = context.addressing_context?.preAnalysis;
  const topicHit = context.prefilter.matchedSignals.includes("own_topic_relevance");
  const memoryLink = Boolean(context.memory_connections?.length);
  const directed = addressing?.addressingMode === "direct" && addressing.directTargets.includes(context.role.role_id);
  const excluded = addressing?.excludedTargets.includes(context.role.role_id) ||
    addressing?.addressingMode === "direct" && !directed;
  const wantsToSpeak = !excluded && (directed || memoryLink || topicHit || context.prefilter.roughScore >= 4 && triggerType !== "minor_relevance");
  const relevanceScore = toScore(Math.min(5, Math.max(1, context.prefilter.roughScore)));

  return {
    role_id: context.role.role_id,
    wants_to_speak: wantsToSpeak,
    trigger_type: directed ? "direct_question_to_self" : memoryLink && wantsToSpeak ? "memory_connection" : wantsToSpeak ? triggerType : "minor_relevance",
    relevance_score: relevanceScore,
    urgency_score: wantsToSpeak ? 3 : 1,
    emotional_intensity_score: triggerType === "strong_emotional_trigger" ? 4 : 2,
    boundary_risk: context.role_reaction_profile.forbidden_boundaries_summary.length > 0 ? "medium" : "low",
    target_role_ids: context.latest_message.speaker_role_id
      ? [context.latest_message.speaker_role_id]
      : [],
    speech_act: wantsToSpeak ? directed ? "answer_user_question" : memoryLink ? "question" : topicHit ? "answer_group_question" : speechActForTrigger(triggerType) : "none",
    reason: context.prefilter.matchedSignals.join("；") || "没有明显相关信号。",
    brief_intent: memoryLink && wantsToSpeak ? "对照 memory_connections 中双方公开与本人经历的具体重合，提出仍待验证的同伴假设并向发言者询问一个能区分的细节；不要认定身份。" : wantsToSpeak ? "用克制的情绪或澄清回应最新公开消息。" : "没有相关已知信息，暂不回应。",
    ...(addressing ? { addressing: { addressingMode: addressing.addressingMode, directTargets: addressing.directTargets,
      referencedRoles: addressing.referencedRoles, excludedTargets: addressing.excludedTargets, topic: addressing.topic } } : {})
  };
}

function inferTriggerType(signals: string[]): ReactionIntent["trigger_type"] {
  const joined = signals.join("；");

  if (joined.includes("direct_question_to_self")) {
    return "direct_question_to_self";
  }

  if (joined.includes("negative_or_partial_portrayal_of_self")) {
    return "negative_or_partial_portrayal_of_self";
  }

  if (joined.includes("contradiction_with_own_knowledge")) {
    return "contradiction_with_own_knowledge";
  }

  if (joined.includes("strong_emotional_trigger")) {
    return "strong_emotional_trigger";
  }

  return "minor_relevance";
}

function speechActForTrigger(triggerType: ReactionIntent["trigger_type"]): ReactionIntent["speech_act"] {
  if (triggerType === "direct_question_to_self") {
    return "answer";
  }

  if (triggerType === "negative_or_partial_portrayal_of_self") {
    return "clarify";
  }

  if (triggerType === "strong_emotional_trigger") {
    return "emotion";
  }

  if (triggerType === "contradiction_with_own_knowledge") {
    return "clarify";
  }
  if (triggerType === "memory_connection") return "question";

  return "none";
}

function toScore(value: number): 1 | 2 | 3 | 4 | 5 {
  if (value <= 1) {
    return 1;
  }

  if (value === 2) {
    return 2;
  }

  if (value === 3) {
    return 3;
  }

  if (value === 4) {
    return 4;
  }

  return 5;
}
