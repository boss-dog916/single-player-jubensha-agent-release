import "server-only";

import { getDmFallbackContent, type DmFallbackTrigger } from "@/src/lib/agents/dmFallbackTemplates";
import type { DMConditionalRule, DMFlowNode, DMFlowNodeType } from "@/src/lib/schemas/dmFlowSchema";
import { createMessage, getMessageInGame, listMessages, listRecentPublicMessages, type CreateMessageInput } from "@/src/lib/services/messageService";
import { listRecentAgentRuns } from "@/src/lib/services/agentRunService";
import { getGameSession, updateGameSession } from "@/src/lib/services/gameService";
import {
  analyzeDiscussionForDM,
  inferDMNodeOutputMode,
  realizeDMNodeSpeech,
  type DMDiscussionAnalysis,
  type DMNodeOutputMode,
  type DMRealizedSpeech
} from "@/src/lib/services/dmNodeRealizerService";
import { getScriptRuntimeDefinition } from "@/src/lib/services/scriptRuntimeDefinitionService";
import type {
  DMFlowCursor,
  DMFlowWaitingFor,
  GamePhase,
  Message,
  MessageMetadata,
  PendingDMQuestionEvaluation
} from "@/src/lib/types/game";

export type DMFlowCursorDebugView = {
  discussionReadiness?: Awaited<ReturnType<typeof import("./discussionReadiness").getDiscussionReadiness>>;
  groupMatching?: import("@/src/lib/schemas/runtimeChoiceSchema").GroupMatchingView | null;
  choice?: import("@/src/lib/schemas/runtimeChoiceSchema").RuntimeChoiceView | null;
  textConfirmation?: { token: string; label: string; ready: boolean; kind?: "start" | "continue" | "transition" } | null;
  manualContract?: {
    storedValidatorVersion: string; currentValidatorVersion: string;
    storedValidatedAt: string | null; currentValidatedAt: string | null;
    control: import("@/src/lib/services/manualControlCompiler").LogicalActControl | null;
    capabilities: readonly string[];
    source: import("@/src/lib/schemas/manualSemanticSchema").SourceEvidence | null;
  };
  lastLifecycleEvaluation?: { id: string; trigger: string; result: string; reason: string; time: string; status: string; latencyMs: number | null } | null;
  runtimeMode?: import("@/src/lib/services/runtimeMode").RuntimeMode;
  definitionId?: string | null;
  definitionVersion?: number | null;
  lastDmMessageSourceMode?: string | null;
  available: boolean;
  cursor: DMFlowCursor | null;
  currentNode: Pick<DMFlowNode, "nodeId" | "type" | "title" | "text" | "fixedLine" | "promptGoal" | "sourceQuote"> | null;
  nextNode: Pick<DMFlowNode, "nodeId" | "type" | "title"> | null;
  attachedConditionalRulesCount: number;
  triggeredRuleIds: string[];
  lastTriggeredRule: DMConditionalRule | null;
  lastDmMessageSourceNodeId: string | null;
  lastAnalysis: DMDiscussionAnalysis | null;
  lastRealizedSpeech: DMRealizedSpeech | null;
  currentNodeOutputMode: DMNodeOutputMode | null;
  pendingDMQuestion: DMFlowCursor["pendingDMQuestion"] | null;
  lastPendingQuestionEvaluation: DMFlowCursor["lastPendingQuestionEvaluation"] | null;
  nextNodeAutoExecuted: boolean;
  warnings: string[];
};

export type ExecuteDMFlowCursorNodeResult = {
  handled: boolean;
  trigger: DmFallbackTrigger;
  nodeKey: string;
  source: "script_fixed" | "script_guided" | "system_fallback" | "conditional_rule";
  dmOutput: string;
  message: Message | null;
  autoExecutedMessage?: Message | null;
  nextAction: "advance_phase" | "wait_for_user" | "none";
  cursor: DMFlowCursor | null;
};

export type FlowLocation = {
  phase: DMFlowCursor["phase"];
  actIndex: number;
  nodeIndex: number;
  node: DMFlowNode;
};

export async function executeDMFlowCursorNode(input: {
  gameSessionId: string;
  trigger: DmFallbackTrigger;
  targetRoleId?: string | null;
  nextAction?: "advance_phase" | "wait_for_user" | "none";
}): Promise<ExecuteDMFlowCursorNodeResult> {
  return (await import("@/src/lib/services/dmLifecycleService")).runDMLifecycle(input);
}

// Explicit development compatibility entry; normal runtime never dispatches here.
export async function executeLegacyDMFlowCursorNode(input: {
  gameSessionId: string; trigger: DmFallbackTrigger; targetRoleId?: string | null;
  nextAction?: "advance_phase" | "wait_for_user" | "none";
}): Promise<ExecuteDMFlowCursorNodeResult> {
  const session = await getGameSession(input.gameSessionId);

  if (!session.runtimeDefinitionId) {
    return unhandled(input.trigger);
  }

  if (input.trigger === "before_next_share") {
    return runSharePromptFallback(input);
  }

  if (input.trigger === "discussion_turn_limit_reached") {
    return runDiscussionCloseAndAdvance(input.gameSessionId, input.trigger);
  }

  await completeNodeForExternalTrigger(input.gameSessionId, input.trigger);

  const location = await findLocationForTrigger(input.gameSessionId, input.trigger);

  if (!location) {
    return runTriggerFallback(input);
  }

  const cursor = await setCursorToLocation(input.gameSessionId, location, inferWaitingFor(location.node));

  if (cursor.consumedNodeIds.includes(location.node.nodeId)) {
    const advanced = await advanceDMFlow(input.gameSessionId, "already_consumed");
    const next = advanced ? await executeLocation(input.gameSessionId, advanced, input.trigger, input.targetRoleId ?? null) : null;

    return next ?? {
      handled: true,
      trigger: input.trigger,
      nodeKey: location.node.nodeId,
      source: "system_fallback",
      dmOutput: "",
      message: null,
      nextAction: "none",
      cursor: (await getGameSession(input.gameSessionId)).dmFlowCursor ?? null
    };
  }

  return executeLocation(input.gameSessionId, location, input.trigger, input.targetRoleId ?? null);
}

async function completeNodeForExternalTrigger(
  gameSessionId: string,
  trigger: DmFallbackTrigger
): Promise<void> {
  const current = await getCurrentLocation(gameSessionId);

  if (!current) {
    return;
  }

  if (trigger === "enter_reading" && current.phase === "opening") {
    await completeCurrentDMNode(gameSessionId, "opening_completed");
  }

  if (trigger === "enter_share_round" && current.node.type === "reading_start") {
    await completeCurrentDMNode(gameSessionId, "reading_completed");
  }

  if (trigger === "all_shares_completed" && current.node.type === "sharing_round") {
    await completeCurrentDMNode(gameSessionId, "sharing_completed");
  }

  if (trigger === "enter_act_summary" && (current.node.type === "free_discussion" || current.node.type === "dm_prompt")) {
    await completeCurrentDMNode(gameSessionId, "discussion_completed");
  }

  if (trigger === "advance_to_next_act" && current.node.type === "act_summary") {
    await completeCurrentDMNode(gameSessionId, "act_summary_completed");
  }
}

// Legacy debug helpers must not manufacture completion of structured gates.
async function assertChoiceBarrier(gameSessionId: string, targetNodeId?: string) {
  const session = await getGameSession(gameSessionId);
  if (!session.dmFlowCursor) return;
  const locations = await getMainFlowLocations(gameSessionId);
  const index = locations.findIndex(l => l.node.nodeId === (targetNodeId ?? session.dmFlowCursor!.nodeId));
  if (locations.slice(0, index + 1).some(l => l.node.clueAction && !session.dmFlowCursor!.completedNodeIds.includes(l.node.nodeId)))
    throw new Error("必需线索动作尚未执行，不能跳过该节点。");
  if (locations.slice(0, index + 1).some(l => l.node.matchingReveal && !session.dmFlowCursor!.completedNodeIds.includes(l.node.nodeId)))
    throw new Error("匹配结果尚未正式公布，不能跳过该节点。");
  if (locations.slice(0, index + 1).some(l => l.node.choiceEnding && !session.dmFlowCursor!.completedNodeIds.includes(l.node.nodeId)))
    throw new Error("结局尚未完成，不能跳过该节点。");
  const { choiceComplete } = await import("./runtimeChoiceState");
  if (locations.slice(0, index + 1).some(l => l.node.choice && !choiceComplete(session.dmFlowCursor!, l.node, session)))
    throw new Error("必需选择尚未完成，不能跳过该节点。");
}

export async function completeCurrentDMNode(
  gameSessionId: string,
  reason: string
): Promise<DMFlowCursor | null> {
  const session = await getGameSession(gameSessionId);
  const cursor = session.dmFlowCursor;

  if (!cursor?.nodeId) {
    return cursor ?? null;
  }

  await assertChoiceBarrier(gameSessionId);
  const completedNodeIds = Array.from(new Set([...cursor.completedNodeIds, cursor.nodeId]));
  const nextCursor: DMFlowCursor = {
    ...cursor,
    waitingFor: "none",
    completedNodeIds,
    lastAdvanceReason: reason,
    lastAdvancedAt: new Date().toISOString()
  };

  await updateGameSession(gameSessionId, { dmFlowCursor: nextCursor });

  return nextCursor;
}

export async function executeCurrentMainFlowNode(
  gameSessionId: string
): Promise<ExecuteDMFlowCursorNodeResult> {
  const current = await getCurrentLocation(gameSessionId);
  const session = await getGameSession(gameSessionId);

  if (!session.runtimeDefinitionId) {
    return unhandled("enter_free_discussion");
  }

  if (!current) {
    const next = await advanceDMFlow(gameSessionId, "debug_execute_current");

    if (!next) {
      return {
        handled: true,
        trigger: "enter_free_discussion",
        nodeKey: "test_scope_end",
        source: "system_fallback",
        dmOutput: "",
        message: null,
        nextAction: "none",
        cursor: (await getGameSession(gameSessionId)).dmFlowCursor ?? null
      };
    }

    return executeLocation(gameSessionId, next, "enter_free_discussion", null);
  }

  if (current.node.matchingReveal || current.node.choice || current.node.choiceRecap || current.node.choiceEnding || current.node.whenChoice)
    return (await import("./dmLifecycleService")).runDMLifecycle({ gameSessionId, trigger: "discussion_turn_limit_reached" });
  return executeLocation(gameSessionId, current, "enter_free_discussion", null);
}

export async function completeAndAdvanceCurrentDMNode(
  gameSessionId: string,
  reason = "debug_complete_and_advance"
): Promise<{
  cursor: DMFlowCursor | null;
  nextLocation: FlowLocation | null;
  executed: ExecuteDMFlowCursorNodeResult | null;
  message: Message | null;
  autoExecutedMessage: Message | null;
}> {
  await completeCurrentDMNode(gameSessionId, reason);
  const advanceResult = await advanceAndMaybeExecuteDMFlow({
    gameSessionId,
    reason,
    autoExecute: await shouldAutoExecuteForSession(gameSessionId)
  });
  const message = advanceResult.executed?.message ?? null;
  const autoExecutedMessage =
    advanceResult.executed?.autoExecutedMessage ?? advanceResult.executed?.message ?? null;

  return {
    cursor: (await getGameSession(gameSessionId)).dmFlowCursor ?? null,
    nextLocation: advanceResult.nextLocation,
    executed: advanceResult.executed,
    message,
    autoExecutedMessage
  };
}

export async function resetDMFlowCursor(gameSessionId: string): Promise<void> {
  const session = await getGameSession(gameSessionId);
  if (session.dmFlowCursor?.choiceReceipts?.length || session.dmFlowCursor?.clueGrants?.length || (await getMainFlowLocations(gameSessionId)).some(l => l.node.choice || l.node.clueAction))
    throw new Error("包含结构化选择的游戏不能清空回执；请创建独立新局。");
  await updateGameSession(gameSessionId, { dmFlowCursor: null });
}

export async function jumpToDMFlowNode(
  gameSessionId: string,
  nodeId: string
): Promise<DMFlowCursor | null> {
  const location = (await getMainFlowLocations(gameSessionId)).find(
    (candidate) => candidate.node.nodeId === nodeId
  );

  if (!location) {
    throw new Error(`DMFlow node "${nodeId}" 不存在，无法跳转。`);
  }

  await assertChoiceBarrier(gameSessionId, nodeId);
  return setCursorToLocation(gameSessionId, location, inferWaitingFor(location.node), {
    lastAdvanceReason: "debug_jump_to_node",
    lastAdvancedAt: new Date().toISOString()
  });
}

export async function advanceDMFlow(
  gameSessionId: string,
  reason: string
): Promise<FlowLocation | null> {
  const [session, locations] = await Promise.all([
    getGameSession(gameSessionId),
    getMainFlowLocations(gameSessionId)
  ]);
  await assertChoiceBarrier(gameSessionId);
  const cursor = session.dmFlowCursor ?? createInitialCursor(session.currentActIndex + 1);
  const currentIndex = locations.findIndex((location) => location.node.nodeId === cursor.nodeId);
  const completedNodeIds = cursor.nodeId
    ? Array.from(new Set([...cursor.completedNodeIds, cursor.nodeId]))
    : cursor.completedNodeIds;
  const consumedNodeIds = cursor.nodeId
    ? Array.from(new Set([...cursor.consumedNodeIds, cursor.nodeId]))
    : cursor.consumedNodeIds;
  const next =
    locations
      .slice(Math.max(0, currentIndex + 1))
      .find((location) => !completedNodeIds.includes(location.node.nodeId)) ?? null;

  if (!next) {
    const nextCursor: DMFlowCursor = {
      ...cursor,
      waitingFor: "test_scope_end",
      consumedNodeIds,
      completedNodeIds,
      lastAdvanceReason: reason,
      lastAdvancedAt: new Date().toISOString(),
      stopReason: "test_scope_end"
    };

    await updateGameSession(gameSessionId, {
      currentPhase: "finished",
      dmFlowCursor: nextCursor
    });

    await createDMMessage({
      gameSessionId,
      phase: session.currentPhase,
      content: "当前测试剧本只配置到这里。后续幕内容尚未完整解析，暂时停止在本阶段。",
      source: "system_fallback",
      trigger: reason,
      node: null,
      nextAction: "none"
    });

    return null;
  }

  await setCursorToLocation(gameSessionId, next, "none", {
    completedNodeIds,
    consumedNodeIds,
    lastAdvanceReason: reason,
    lastAdvancedAt: new Date().toISOString(),
    lastAutoExecutedNodeId: null,
    lastAutoExecutedAt: null
  });

  return next;
}

export async function advanceAndMaybeExecuteDMFlow(input: {
  gameSessionId: string;
  reason: string;
  autoExecute: boolean;
  trigger?: DmFallbackTrigger;
  depth?: number;
}): Promise<{
  nextLocation: FlowLocation | null;
  executed: ExecuteDMFlowCursorNodeResult | null;
}> {
  const nextLocation = await advanceDMFlow(input.gameSessionId, input.reason);
  const depth = input.depth ?? 0;

  if (
    !nextLocation ||
    !input.autoExecute ||
    depth >= 5 ||
    !shouldAutoExecuteNode(nextLocation.node)
  ) {
    return { nextLocation, executed: null };
  }

  const executed = await executeLocation(
    input.gameSessionId,
    nextLocation,
    input.trigger ?? "enter_free_discussion",
    null,
    depth + 1
  );
  const session = await getGameSession(input.gameSessionId);
  const cursor = session.dmFlowCursor;

  if (cursor) {
    await updateGameSession(input.gameSessionId, {
      dmFlowCursor: {
        ...cursor,
        lastAutoExecutedNodeId: nextLocation.node.nodeId,
        lastAutoExecutedAt: new Date().toISOString()
      }
    });
  }

  return { nextLocation, executed };
}

export async function getDMFlowCursorDebugView(
  gameSessionId: string
): Promise<DMFlowCursorDebugView> {
  const session = await getGameSession(gameSessionId);

  if (!session.runtimeDefinitionId) {
    return {
      available: false,
      cursor: null,
      currentNode: null,
      nextNode: null,
      attachedConditionalRulesCount: 0,
      triggeredRuleIds: [],
      lastTriggeredRule: null,
      lastDmMessageSourceNodeId: null,
      lastAnalysis: null,
      lastRealizedSpeech: null,
      currentNodeOutputMode: null,
      pendingDMQuestion: null,
      lastPendingQuestionEvaluation: null,
      nextNodeAutoExecuted: false,
      warnings: []
    };
  }

  const [locations, recentMessages] = await Promise.all([
    getMainFlowLocations(gameSessionId),
    listRecentPublicMessages(gameSessionId, 5)
  ]);
  const cursor = session.dmFlowCursor;
  const currentLocation = cursor?.nodeId
    ? locations.find((location) => location.node.nodeId === cursor.nodeId) ?? null
    : null;
  const currentIndex = currentLocation ? locations.indexOf(currentLocation) : -1;
  const nextLocation = locations.slice(currentIndex + 1).find(
    (location) => !cursor?.completedNodeIds.includes(location.node.nodeId)
  ) ?? null;
  const lastTriggeredRule =
    currentLocation?.node.conditionalRules.find((rule) => rule.ruleId === cursor?.lastTriggeredRuleId) ?? null;
  const allMessages = await (await import("@/src/lib/services/messageService")).listMessages(gameSessionId);
  const lastDm = allMessages.filter(m => m.speaker_type === "dm").at(-1);
  const presentation = cursor?.textPresentation;
  const discussionReadiness = await (await import("./discussionReadiness")).getDiscussionReadiness(gameSessionId);
  const endsTestScope = session.testMode && cursor?.actIndex ===
    (session.runtimeScope as import("./runtimeDefinitionSessionService").RuntimeSessionScope | null)?.actRange?.end;
  const endsFullGame = currentLocation?.node.type === "transition" && locations.some(l => l.actIndex === cursor?.actIndex && (l.node.choiceEnding || l.node.choice?.type !== "group_matching" && l.node.choice?.endsGame));
  const textConfirmation = presentation && !presentation.confirmed ? { token: presentation.token, kind: presentation.kind,
    label: presentation.kind === "start" ? "开始剧情演绎" : presentation.kind === "transition" ? endsFullGame ? "结束游戏" : endsTestScope && currentLocation?.node.continuationRequired ? "后续尾声尚未就绪" : endsTestScope ? "结束本次测试" : `进入第${["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"][cursor!.actIndex + 1] ?? cursor!.actIndex + 1}幕` : currentLocation?.node.choice?.type === "group_matching" ? "继续剧情" : "继续演绎",
    ready: !(endsTestScope && currentLocation?.node.continuationRequired) && (presentation.kind !== "start" || !discussionReadiness || discussionReadiness.ready) && (await import("./dmTextPresentation")).textConfirmationReady(cursor!, currentLocation?.node ?? null, allMessages, session.currentActId) } : null;
  const lastDmMessageSourceNodeId = lastDm?.metadata.sourceNodeId ?? null;
  const [lastAnalysisRun, lastRealizerRun] = await Promise.all([
    getLatestDMRealizerRunOutput(gameSessionId, "dm_discussion_analyzer"),
    getLatestDMRealizerRunOutput(gameSessionId, "dm_node_realizer")
  ]);
  const [evaluation] = await listRecentAgentRuns(gameSessionId, ["dm_lifecycle_evaluation"], 1);
  const evaluationInput = isRecord(evaluation?.inputJson) ? evaluation.inputJson : {};
  const evaluationOutput = isRecord(evaluation?.outputJson) ? evaluation.outputJson : {};
  const definition = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const { RUNTIME_CAPABILITIES } = await import("@/src/lib/services/manualControlCompiler");

  return {
    available: true,
    manualContract: {
      storedValidatorVersion: definition.storedValidationReport.validatorVersion ?? "legacy_unknown",
      currentValidatorVersion: definition.validationReport.validatorVersion ?? "legacy_unknown",
      storedValidatedAt: definition.storedValidationReport.validatedAt ?? null,
      currentValidatedAt: definition.validationReport.validatedAt ?? null,
      control: definition.definition.acts.find(a => a.actIndex === session.currentActIndex + 1)?.control ?? null,
      capabilities: RUNTIME_CAPABILITIES, source: currentLocation?.node.sourceEvidence ?? null
    },
    lastLifecycleEvaluation: evaluation ? { id: evaluation.id, trigger: String(evaluationInput.trigger ?? "-"),
      result: String(evaluationOutput.result ?? evaluation.status), reason: String(evaluation.errorMessage ?? evaluation.error ?? evaluationOutput.reason ?? "-"),
      time: evaluation.createdAt.toISOString(), status: evaluation.status, latencyMs: evaluation.latencyMs } : null,
    runtimeMode: session.runtimeMode,
    definitionId: session.runtimeDefinitionId,
    definitionVersion: session.dmFlowCursor?.lifecycle?.definitionVersion ?? null,
    lastDmMessageSourceMode: lastDm?.metadata.sourceMode ?? lastDm?.metadata.source ?? null,
    cursor: cursor ?? null,
    currentNode: currentLocation ? compactNode(currentLocation.node) : null,
    nextNode: nextLocation ? {
      nodeId: nextLocation.node.nodeId,
      type: nextLocation.node.type,
      title: nextLocation.node.title
    } : null,
    attachedConditionalRulesCount: currentLocation?.node.conditionalRules.length ?? 0,
    triggeredRuleIds: cursor?.triggeredRuleIds ?? [],
    lastTriggeredRule,
    lastDmMessageSourceNodeId,
    lastAnalysis: isDMDiscussionAnalysis(lastAnalysisRun) ? lastAnalysisRun : null,
    lastRealizedSpeech: isDMRealizedSpeech(lastRealizerRun) ? lastRealizerRun : null,
    currentNodeOutputMode: currentLocation ? inferDMNodeOutputMode(currentLocation.node) : null,
    textConfirmation,
    discussionReadiness,
    choice: await (await import("./runtimeChoiceService")).getRuntimeChoiceView(gameSessionId),
    groupMatching: await (await import("./groupMatchingService")).getGroupMatchingView(gameSessionId),
    pendingDMQuestion: cursor?.pendingDMQuestion ?? null,
    lastPendingQuestionEvaluation: cursor?.lastPendingQuestionEvaluation ?? null,
    nextNodeAutoExecuted: Boolean(cursor?.lastAutoExecutedNodeId),
    warnings: cursor?.warnings ?? []
  };
}

export async function findTriggeredDMRules(input: {
  gameSessionId: string;
  latestMessageId?: string;
}): Promise<{ triggeredRuleIds: string[]; reason: string; confidence: number }> {
  const session = await getGameSession(input.gameSessionId);

  if (!session.runtimeDefinitionId || !session.dmFlowCursor?.nodeId) {
    return { triggeredRuleIds: [], reason: "no_runtime_dm_flow_cursor", confidence: 0 };
  }

  const current = await getCurrentLocation(input.gameSessionId);
  const latestMessages = await listRecentPublicMessages(input.gameSessionId, 5);
  const text = latestMessages.map((message) => message.content).join("\n");
  const triggered = (current?.node.conditionalRules ?? []).filter((rule) => {
    if (session.dmFlowCursor?.triggeredRuleIds.includes(rule.ruleId)) {
      return false;
    }

    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      return true;
    }

    return rule.triggerType === "if_player_asks" && /吗|呢|？|\?/.test(text) && text.includes(rule.conditionText.slice(0, 8));
  });

  return {
    triggeredRuleIds: triggered.map((rule) => rule.ruleId),
    reason: triggered.length ? "matched_current_node_conditional_rules" : "no_current_node_rule_matched",
    confidence: triggered.length ? 0.72 : 0
  };
}

export type PostPublicMessageFlowResult = {
  handled: boolean;
  evaluation: PendingDMQuestionEvaluation | null;
  dmMessageId: string | null;
  autoDiscussionSeedMessageId: string | null;
  advanced: boolean;
  autoExecuted: boolean;
};

export async function handlePostPublicMessageFlow(input: {
  gameId: string;
  latestMessageId: string;
}): Promise<PostPublicMessageFlowResult> {
  const sessionBefore = await getGameSession(input.gameId);
  if (sessionBefore.runtimeDefinitionId) {
    const definition = await getScriptRuntimeDefinition(sessionBefore.runtimeDefinitionId);
    const current = definition.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === sessionBefore.dmFlowCursor?.nodeId);
    if (current?.textExecution || current?.discussionExit) {
      const latest = await getMessageInGame(input.gameId, input.latestMessageId);
      const pending = sessionBefore.dmFlowCursor?.pendingDMQuestion;
      const addressesDM = /(?:^|[，,。\s])DM\s*[，,？?你]/i.test(latest.content);
      const answersDM = Boolean(current.textExecution?.wait && pending?.nodeId === current.nodeId &&
        pending.textInteraction && ["waiting", "partial_answered"].includes(pending.status) &&
        (!pending.targetRoleNames.length || pending.targetRoleNames.includes(latest.speaker_role_id ?? "")) &&
        (latest.created_at?.getTime() ?? 0) > Date.parse(pending.askedAt));
      // A short receipt is an aside, not a new story node. It cannot alter
      // Cursor, settle semantic goals, or reveal anything from the manual.
      if (latest.speaker_type === "user" && latest.metadata.act_id === sessionBefore.currentActId &&
        !(latest.target_role_ids ?? []).some(id => sessionBefore.aiRoleIds.includes(id)) &&
        !await (await import("./runtimeInputPolicy")).isRuntimeChoiceOnly(input.gameId) && (answersDM || addressesDM)) {
        const { prisma } = await import("@/src/lib/db/prisma");
        if (!await prisma.message.count({ where: { gameSessionId: input.gameId, speakerType: "dm", replyToMessageId: latest.message_id } })) {
          const fallback = addressesDM ? `${latest.speaker_name}，你的问题我听到了。先听完眼前这一段，再继续谈。` : `${latest.speaker_name}，你的回答我听到了。`;
          const feedback = answersDM ? await (await import("./dmNodeRealizerService")).realizeDMAnswerFeedback({
            gameId: input.gameId, actId: sessionBefore.currentActId, phase: sessionBefore.currentPhase,
            question: pending?.questionText ?? "", answer: latest,
            publicMessages: (await listMessages(input.gameId)).filter(m => (m.created_at?.getTime() ?? 0) <= (latest.created_at?.getTime() ?? 0)),
            fallback, forbiddenReveals: current.forbiddenReveals
          }) : { text: fallback, generated: false };
          const now = await getGameSession(input.gameId);
          if (now.currentActId !== sessionBefore.currentActId || now.dmFlowCursor?.nodeId !== current.nodeId) return emptyPostPublicMessageFlowResult();
          await createMessage({ gameSessionId: input.gameId, speakerType: "dm", speakerRoleId: "dm", speakerName: "DM",
            phase: sessionBefore.currentPhase, speechAct: "statement", replyToMessageId: latest.message_id,
            content: feedback.text,
            metadata: { revealed_facts: [], emotional_points: [], questions_raised: [], mentioned_role_ids: [], event_tags: [], topic_tags: [],
              storyBoardEligible: false, source: feedback.generated ? "script_guided" : "system_fallback", trigger: "dm_text_acknowledgement" } });
        }
      }
      const result = await (await import("./dmLifecycleService")).runDMLifecycle({ gameSessionId: input.gameId, trigger: "discussion_turn_limit_reached" });
      return { handled: true, evaluation: null, dmMessageId: result.message?.message_id ?? null,
        autoDiscussionSeedMessageId: result.message?.message_id ?? null, advanced: result.cursor?.nodeId !== current.nodeId, autoExecuted: Boolean(result.message) };
    }
  }
  const monitored = await (await import("./dmPublicPointService")).monitorPublicDiscussion(input.gameId, input.latestMessageId);
  if (monitored) return { handled: true, evaluation: monitored.evaluation, dmMessageId: monitored.message?.message_id ?? null,
    autoDiscussionSeedMessageId: monitored.message?.message_id ?? null, advanced: false, autoExecuted: false };
  const [session, latestMessage] = await Promise.all([
    getGameSession(input.gameId),
    getMessageInGame(input.gameId, input.latestMessageId)
  ]);
  const pending = session.dmFlowCursor?.pendingDMQuestion;

  // A busy/recovering checkpoint must never fall back to the permissive legacy
  // answer evaluator for a cumulative public-point question.
  if (pending?.publicPointRuleId || pending?.textInteraction) return emptyPostPublicMessageFlowResult();

  if (
    !pending ||
    pending.status === "closed" ||
    pending.status === "answered" ||
    latestMessage.speaker_type === "dm" ||
    (latestMessage.speaker_type !== "user" && latestMessage.speaker_type !== "ai_player")
  ) {
    return emptyPostPublicMessageFlowResult();
  }

  const evaluation = evaluateResponseToPendingDMQuestion(session, latestMessage);
  await storePendingQuestionEvaluation(input.gameId, latestMessage, evaluation);

  if (evaluation.shouldCueAnotherRole && evaluation.cueTargetRoleName) {
    const cueMessage = await createPendingQuestionCueMessage({
      gameSessionId: input.gameId,
      latestMessage,
      evaluation
    });

    return {
      handled: true,
      evaluation,
      dmMessageId: cueMessage.message_id,
      autoDiscussionSeedMessageId: cueMessage.message_id,
      advanced: false,
      autoExecuted: false
    };
  }

  if (evaluation.shouldAdvanceFlow) {
    const confirmMessage = await createPendingQuestionConfirmMessage(input.gameId, latestMessage.phase);
    await closePendingQuestion(input.gameId, evaluation);
    await completeCurrentDMNode(input.gameId, "pending_dm_question_answered");
    const advanceResult = await advanceAndMaybeExecuteDMFlow({
      gameSessionId: input.gameId,
      reason: "pending_dm_question_answered",
      autoExecute: await shouldAutoExecuteForSession(input.gameId),
      trigger: "enter_free_discussion"
    });

    return {
      handled: true,
      evaluation,
      dmMessageId: confirmMessage.message_id,
      autoDiscussionSeedMessageId:
        advanceResult.executed?.autoExecutedMessage?.message_id ??
        advanceResult.executed?.message?.message_id ??
        null,
      advanced: Boolean(advanceResult.nextLocation),
      autoExecuted: Boolean(advanceResult.executed?.autoExecutedMessage ?? advanceResult.executed?.message)
    };
  }

  return {
    handled: true,
    evaluation,
    dmMessageId: null,
    autoDiscussionSeedMessageId: null,
    advanced: false,
    autoExecuted: false
  };
}

function evaluateResponseToPendingDMQuestion(
  session: Awaited<ReturnType<typeof getGameSession>>,
  latestMessage: Message
): PendingDMQuestionEvaluation {
  const pending = session.dmFlowCursor?.pendingDMQuestion;
  const speakerName = latestMessage.speaker_name ?? latestMessage.speaker_role_id ?? "未知角色";
  const expectedTopics = pending?.expectedTopics ?? [];
  const answeredTopics = expectedTopics.filter((topic) => contentMatchesTopic(latestMessage.content, topic));
  const meaningful = hasSubstantiveAnswer(latestMessage.content);
  const targetRoleNames = pending?.targetRoleNames ?? [];
  const answeredBy = new Set([...(pending?.answeredByRoleNames ?? []), speakerName]);
  const missingTargets = targetRoleNames.filter((target) => !answeredBy.has(target));
  const answered =
    Boolean(meaningful &&
    (answeredTopics.length > 0 ||
      expectedTopics.length === 0 ||
      targetRoleNames.length === 0 ||
      latestMessage.target_role_ids?.some((roleId) => targetRoleNames.includes(roleId))));
  const partial = meaningful || answeredTopics.length > 0;
  const shouldCueAnotherRole =
    !answered &&
    (pending?.cueCount ?? 0) < 2 &&
    (missingTargets.length > 0 || targetRoleNames.length === 0);
  const cueTargetRoleName =
    missingTargets[0] ??
    session.aiRoleIds.find((roleId) => roleId !== latestMessage.speaker_role_id) ??
    undefined;
  const shouldAdvanceFlow =
    answered ||
    (partial && targetRoleNames.length === 0) ||
    (pending?.cueCount ?? 0) >= 2 ||
    (!shouldCueAnotherRole && partial);

  return {
    latestMessageId: latestMessage.message_id,
    answered,
    partial,
    answeredTopics,
    missingTopics: expectedTopics.filter((topic) => !answeredTopics.includes(topic)).slice(0, 6),
    shouldCueAnotherRole: shouldCueAnotherRole && Boolean(cueTargetRoleName),
    cueTargetRoleName,
    shouldAskFollowup: false,
    shouldAdvanceFlow,
    reason: answered
      ? "latest_message_answered_pending_dm_question"
      : partial
        ? "latest_message_partially_answered_pending_dm_question"
        : "latest_message_did_not_answer_pending_dm_question",
    evaluatedAt: new Date().toISOString()
  };
}

async function storePendingQuestionEvaluation(
  gameSessionId: string,
  latestMessage: Message,
  evaluation: PendingDMQuestionEvaluation
): Promise<void> {
  const session = await getGameSession(gameSessionId);
  const cursor = session.dmFlowCursor;

  if (!cursor?.pendingDMQuestion) {
    return;
  }

  const speakerName = latestMessage.speaker_name ?? latestMessage.speaker_role_id ?? "未知角色";

  await updateGameSession(gameSessionId, {
    dmFlowCursor: {
      ...cursor,
      pendingDMQuestion: {
        ...cursor.pendingDMQuestion,
        answeredByRoleNames: Array.from(
          new Set([...cursor.pendingDMQuestion.answeredByRoleNames, speakerName])
        ),
        status: evaluation.answered
          ? "answered"
          : evaluation.partial
            ? "partial_answered"
            : cursor.pendingDMQuestion.status
      },
      lastPendingQuestionEvaluation: evaluation
    }
  });
}

async function createPendingQuestionCueMessage(input: {
  gameSessionId: string;
  latestMessage: Message;
  evaluation: PendingDMQuestionEvaluation;
}): Promise<Message> {
  const session = await getGameSession(input.gameSessionId);
  const cursor = session.dmFlowCursor;
  const target = input.evaluation.cueTargetRoleName;
  const content = `${target}，你这边有没有更具体的内容可以补充？先说你能确认的事实，不确定的地方再说明。`;
  const message = await createMessage({
    gameSessionId: input.gameSessionId,
    speakerType: "dm",
    speakerRoleId: "dm",
    speakerName: "DM",
    targetRoleIds: target ? [target] : [],
    replyToMessageId: input.latestMessage.message_id,
    phase: input.latestMessage.phase,
    speechAct: "dm_directed_question",
    content,
    metadata: {
      revealed_facts: [],
      emotional_points: [],
      questions_raised: [content],
      mentioned_role_ids: target ? [target] : [],
      event_tags: [],
      topic_tags: [],
      source: "system_fallback",
      trigger: "pending_dm_question_cue",
      storyBoardEligible: false,
      next_action: "wait_for_user"
    }
  });

  if (cursor?.pendingDMQuestion) {
    await updateGameSession(input.gameSessionId, {
      dmFlowCursor: {
        ...cursor,
        pendingDMQuestion: {
          ...cursor.pendingDMQuestion,
          messageId: message.message_id,
          targetRoleNames: target ? [target] : cursor.pendingDMQuestion.targetRoleNames,
          cueCount: cursor.pendingDMQuestion.cueCount + 1,
          status: "waiting"
        }
      }
    });
  }

  return message;
}

async function createPendingQuestionConfirmMessage(
  gameSessionId: string,
  phase: GamePhase
): Promise<Message> {
  return createMessage({
    gameSessionId,
    speakerType: "dm",
    speakerRoleId: "dm",
    speakerName: "DM",
    phase,
    speechAct: "summary",
    content: "好，先到这里。刚才这个问题已经有回应了，我们继续往下推进。",
    metadata: {
      revealed_facts: [],
      emotional_points: [],
      questions_raised: [],
      mentioned_role_ids: [],
      event_tags: [],
      topic_tags: [],
      source: "system_fallback",
      trigger: "pending_dm_question_answered",
      storyBoardEligible: false,
      next_action: "advance_phase"
    }
  });
}

async function closePendingQuestion(
  gameSessionId: string,
  evaluation: PendingDMQuestionEvaluation
): Promise<void> {
  const session = await getGameSession(gameSessionId);
  const cursor = session.dmFlowCursor;

  if (!cursor?.pendingDMQuestion) {
    return;
  }

  await updateGameSession(gameSessionId, {
    dmFlowCursor: {
      ...cursor,
      pendingDMQuestion: {
        ...cursor.pendingDMQuestion,
        status: "closed"
      },
      lastPendingQuestionEvaluation: evaluation
    }
  });
}

function emptyPostPublicMessageFlowResult(): PostPublicMessageFlowResult {
  return {
    handled: false,
    evaluation: null,
    dmMessageId: null,
    autoDiscussionSeedMessageId: null,
    advanced: false,
    autoExecuted: false
  };
}

async function runDiscussionCloseAndAdvance(
  gameSessionId: string,
  trigger: DmFallbackTrigger
): Promise<ExecuteDMFlowCursorNodeResult> {
  const current = await getCurrentLocation(gameSessionId);
  const session = await getGameSession(gameSessionId);
  const realization = current
    ? await realizeNodeForOutput({
        gameSessionId,
        node: current.node,
        trigger,
        phase: session.currentPhase
      })
    : null;
  const content = realization?.speech.text ?? "先到这里。刚才大家已经围绕公开信息做了讨论，如果没有新的补充，我们继续往下推进。";
  const shouldAdvance = realization?.speech.shouldAdvanceAfterSpeaking ?? true;
  const message = await createDMMessage({
    gameSessionId,
    phase: session.currentPhase,
    content,
    source: realization?.speech.sourceMode ?? (current?.node ? "script_guided" : "system_fallback"),
    trigger,
    node: current?.node ?? null,
    nextAction: shouldAdvance ? "advance_phase" : "wait_for_user"
  });

  if (current && shouldAdvance) {
    await markNodeConsumed(gameSessionId, current.node.nodeId);
    await completeCurrentDMNode(gameSessionId, "discussion_closed");
  }

  if (shouldAdvance) {
    await advanceAndMaybeExecuteDMFlow({
      gameSessionId,
      reason: "discussion_closed",
      autoExecute: await shouldAutoExecuteForSession(gameSessionId),
      trigger
    });
  }

  if (current && !shouldAdvance) {
    const cursor = (await getGameSession(gameSessionId)).dmFlowCursor;

    if (cursor) {
      await updateGameSession(gameSessionId, {
        dmFlowCursor: {
          ...cursor,
          waitingFor: "user_input",
          lastAdvanceReason: "dm_cued_missing_point"
        }
      });
    }
  }

  return {
    handled: true,
    trigger,
    nodeKey: current?.node.nodeId ?? "discussion_close_fallback",
    source: current?.node ? "script_guided" : "system_fallback",
    dmOutput: content,
    message,
    nextAction: shouldAdvance ? "advance_phase" : "wait_for_user",
    cursor: (await getGameSession(gameSessionId)).dmFlowCursor ?? null
  };
}

async function executeLocation(
  gameSessionId: string,
  location: FlowLocation,
  trigger: DmFallbackTrigger,
  targetRoleId: string | null,
  autoDepth = 0
): Promise<ExecuteDMFlowCursorNodeResult> {
  const session = await getGameSession(gameSessionId);
  const realization = await realizeNodeForOutput({
    gameSessionId,
    node: location.node,
    trigger,
    phase: getPhaseForNode(location.node, session.currentPhase)
  });
  const source = realization.speech.sourceMode;
  const content = realization.speech.text;
  const nextAction = realization.speech.shouldAdvanceAfterSpeaking ? "advance_phase" : "wait_for_user";
  const message = await createDMMessage({
    gameSessionId,
    phase: getPhaseForNode(location.node, session.currentPhase),
    content,
    source,
    trigger,
    node: location.node,
    nextAction
  });

  await markNodeConsumed(gameSessionId, location.node.nodeId);
  await updatePhaseForNode(gameSessionId, location.node);
  let autoExecutedMessage: Message | null = null;

  if (shouldAutoComplete(location.node) && realization.speech.shouldAdvanceAfterSpeaking) {
    await completeCurrentDMNode(gameSessionId, `auto_completed_${location.node.type}`);
    const advanceResult = await advanceAndMaybeExecuteDMFlow({
      gameSessionId,
      reason: `auto_completed_${location.node.type}`,
      autoExecute: await shouldAutoExecuteForSession(gameSessionId),
      trigger,
      depth: autoDepth
    });
    autoExecutedMessage = advanceResult.executed?.autoExecutedMessage ?? advanceResult.executed?.message ?? null;
  }

  return {
    handled: true,
    trigger,
    nodeKey: location.node.nodeId,
    source,
    dmOutput: content,
    message,
    autoExecutedMessage,
    nextAction,
    cursor: (await getGameSession(gameSessionId)).dmFlowCursor ?? null
  };
}

export async function realizeNodeForOutput(input: {
  gameSessionId: string;
  node: DMFlowNode;
  trigger: string;
  phase: GamePhase;
}): Promise<{ analysis: DMDiscussionAnalysis; speech: DMRealizedSpeech; mode: DMNodeOutputMode }> {
  const mode = inferDMNodeOutputMode(input.node);
  const analysis =
    mode === "fixed_line"
      ? createEmptyDMDiscussionAnalysis()
      : await analyzeDiscussionForDM({
          gameId: input.gameSessionId,
          actIndex: input.node.actIndex ?? 0,
          currentNode: input.node,
          recentMessageLimit: 8
        });
  const speech = await realizeDMNodeSpeech({
    gameId: input.gameSessionId,
    currentNode: input.node,
    analysis,
    mode,
    phase: input.phase,
    trigger: input.trigger
  });

  return { analysis, speech, mode };
}

function createEmptyDMDiscussionAnalysis(): DMDiscussionAnalysis {
  return {
    publicSummary: [],
    mentionedPoints: [],
    missingPoints: [],
    speakerCoverage: [],
    openQuestions: [],
    contradictions: [],
    suggestedDmAction: "advance_flow",
    suggestedCueTargets: [],
    safetyWarnings: []
  };
}

async function findLocationForTrigger(
  gameSessionId: string,
  trigger: DmFallbackTrigger
): Promise<FlowLocation | null> {
  const session = await getGameSession(gameSessionId);
  const locations = await getMainFlowLocations(gameSessionId);
  const targetTypes = getTargetTypesForTrigger(trigger);

  if (targetTypes.length === 0) {
    return null;
  }

  if (trigger === "game_started") {
    return locations.find((location) => location.phase === "opening" && !session.dmFlowCursor?.completedNodeIds.includes(location.node.nodeId)) ?? null;
  }

  const currentActIndex = getRuntimeActIndex(session);

  return (
    locations.find(
      (location) =>
        location.actIndex === currentActIndex &&
        targetTypes.includes(location.node.type) &&
        !session.dmFlowCursor?.completedNodeIds.includes(location.node.nodeId)
    ) ?? null
  );
}

async function getCurrentLocation(gameSessionId: string): Promise<FlowLocation | null> {
  const session = await getGameSession(gameSessionId);

  if (!session.dmFlowCursor?.nodeId) {
    return null;
  }

  return (await getMainFlowLocations(gameSessionId)).find(
    (location) => location.node.nodeId === session.dmFlowCursor?.nodeId
  ) ?? null;
}

async function getMainFlowLocations(gameSessionId: string): Promise<FlowLocation[]> {
  const session = await getGameSession(gameSessionId);

  if (!session.runtimeDefinitionId) {
    return [];
  }

  const definition = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const scope = session.runtimeScope as { actRange?: { start: number; end: number }; roleNames?: string[] } | null;
  if (scope?.actRange && scope.roleNames && (await import("@/src/lib/services/dmLifecycleValidation")).validateDMLifecycle(definition.definition,
    { actRange: scope.actRange, roleNames: scope.roleNames }).some(i => i.fatal)) return [];
  const dmFlow = definition.definition.dmFlow
    ? definition.definition.dmFlow
    : null;

  if (!dmFlow) {
    return [];
  }

  const locations: FlowLocation[] = [];

  dmFlow.openingNodes.forEach((node, index) => {
    locations.push({ phase: "opening", actIndex: 0, nodeIndex: index, node });
  });

  dmFlow.actFlows
    .sort((left, right) => left.actIndex - right.actIndex)
    .forEach((actFlow) => {
      if (scope?.actRange && (actFlow.actIndex < scope.actRange.start || actFlow.actIndex > scope.actRange.end)) return;
      actFlow.nodes.forEach((node, index) => {
        locations.push({
          phase: "act",
          actIndex: actFlow.actIndex,
          nodeIndex: index,
          node: {
            ...node,
            actIndex: node.actIndex ?? actFlow.actIndex
          }
        });
      });
    });

  (session.dmFlowCursor?.lifecycle ? [] : dmFlow.endingNodes).forEach((node, index) => {
    locations.push({ phase: "ending", actIndex: Number.MAX_SAFE_INTEGER, nodeIndex: index, node });
  });

  return locations;
}

async function setCursorToLocation(
  gameSessionId: string,
  location: FlowLocation,
  waitingFor: DMFlowWaitingFor,
  overrides: Partial<DMFlowCursor> = {}
): Promise<DMFlowCursor> {
  const session = await getGameSession(gameSessionId);
  const previous = session.dmFlowCursor ?? createInitialCursor(location.actIndex);
  const cursor: DMFlowCursor = {
    ...previous,
    ...overrides,
    phase: location.phase,
    actIndex: location.actIndex,
    nodeIndex: location.nodeIndex,
    nodeId: location.node.nodeId,
    waitingFor,
    warnings: Array.from(new Set([...(previous.warnings ?? []), ...(overrides.warnings ?? [])]))
  };

  await updateGameSession(gameSessionId, { dmFlowCursor: cursor });

  return cursor;
}

async function markNodeConsumed(gameSessionId: string, nodeId: string): Promise<void> {
  const session = await getGameSession(gameSessionId);
  const cursor = session.dmFlowCursor ?? createInitialCursor(session.currentActIndex + 1);

  await updateGameSession(gameSessionId, {
    dmFlowCursor: {
      ...cursor,
      consumedNodeIds: Array.from(new Set([...cursor.consumedNodeIds, nodeId])),
      lastExecutedNodeId: nodeId
    }
  });
}

async function updatePhaseForNode(gameSessionId: string, node: DMFlowNode): Promise<void> {
  const session = await getGameSession(gameSessionId);
  const nextPhase = getPhaseForNode(node, session.currentPhase);
  const data: Parameters<typeof updateGameSession>[1] = {
    currentPhase: nextPhase
  };

  if (node.type === "sharing_round") {
    data.currentShareIndex = 0;
  }

  if (node.type === "free_discussion" || node.type === "dm_prompt") {
    data.discussionTurnCount = 0;
  }

  await updateGameSession(gameSessionId, data);
}

function createInitialCursor(actIndex: number): DMFlowCursor {
  return {
    actIndex,
    nodeIndex: 0,
    phase: "act",
    waitingFor: "none",
    consumedNodeIds: [],
    completedNodeIds: [],
    triggeredRuleIds: [],
    warnings: []
  };
}

function getTargetTypesForTrigger(trigger: DmFallbackTrigger): DMFlowNodeType[] {
  const map: Record<DmFallbackTrigger, DMFlowNodeType[]> = {
    game_started: ["fixed_line", "dm_prompt", "transition"],
    role_selected: ["fixed_line", "dm_prompt"],
    enter_reading: ["reading_start"],
    enter_share_round: ["sharing_round"],
    before_next_share: [],
    all_shares_completed: ["free_discussion", "dm_prompt"],
    enter_free_discussion: ["free_discussion"],
    discussion_turn_limit_reached: ["free_discussion", "dm_prompt"],
    enter_dm_question: ["dm_prompt"],
    enter_act_summary: ["act_summary"],
    advance_to_next_act: ["transition"],
    finished: ["ending_reveal", "fixed_line", "dm_prompt"]
  };

  return map[trigger] ?? [];
}

function inferWaitingFor(node: DMFlowNode): DMFlowWaitingFor {
  if (node.type === "reading_start") return "player_read_done";
  if (node.type === "sharing_round") return "all_shares_done";
  if (node.type === "free_discussion" || node.type === "dm_prompt") return "discussion_close";
  if (node.type === "clue_release") return "clue_release";
  if (node.type === "transition") return "act_transition";
  if (node.type === "performance_instruction" || node.type === "act_summary") return "manual_continue";
  return "none";
}

function getPhaseForNode(node: DMFlowNode, fallback: GamePhase): GamePhase {
  if (node.type === "reading_start") return "reading";
  if (node.type === "sharing_round") return "share_round";
  if (node.type === "free_discussion") return "free_discussion";
  if (node.type === "dm_prompt") return "free_discussion";
  if (node.type === "act_summary") return "act_summary";
  if (node.type === "ending_reveal") return "finished";
  return fallback;
}

function getNodeSource(node: DMFlowNode): ExecuteDMFlowCursorNodeResult["source"] {
  if (node.fixedLine?.trim() || node.type === "fixed_line") {
    return "script_fixed";
  }

  if (node.text?.trim() || node.promptGoal?.trim() || node.guidance?.discussionGoal?.trim()) {
    return "script_guided";
  }

  return "system_fallback";
}

function getNextActionForNode(node: DMFlowNode): ExecuteDMFlowCursorNodeResult["nextAction"] {
  return shouldAutoComplete(node) ? "advance_phase" : "wait_for_user";
}

function shouldAutoComplete(node: DMFlowNode): boolean {
  return node.type === "fixed_line" || node.type === "performance_instruction" || node.type === "clue_release";
}

function shouldAutoExecuteNode(node: DMFlowNode): boolean {
  return (
    node.type === "fixed_line" ||
    node.type === "dm_prompt" ||
    node.type === "act_summary" ||
    node.type === "transition" ||
    node.type === "free_discussion" ||
    node.type === "reading_start" ||
    node.type === "sharing_round"
  );
}

async function shouldAutoExecuteForSession(gameSessionId: string): Promise<boolean> {
  const session = await getGameSession(gameSessionId);

  return (await import("@/src/lib/services/runtimeMode")).getRuntimeMode(session) === "runtime_auto";
}

function renderNodeContent(node: DMFlowNode, trigger: DmFallbackTrigger, targetRoleId: string | null): string {
  const fixed = node.fixedLine?.trim() || (node.type === "fixed_line" ? node.text?.trim() : "");

  if (fixed) {
    return fixed;
  }

  const guidance = node.text?.trim() || node.promptGoal?.trim() || node.guidance?.discussionGoal?.trim();

  if (guidance) {
    return guidance;
  }

  return getDmFallbackContent({
    trigger,
    roleName: targetRoleId,
    roleId: targetRoleId
  });
}

function renderDiscussionClose(node: DMFlowNode | null | undefined): string {
  const summaryHint =
    node?.guidance?.fallbackHint ??
    node?.guidance?.discussionGoal ??
    node?.promptGoal ??
    node?.text ??
    null;

  if (summaryHint?.trim()) {
    return `先到这里。${summaryHint.trim()}`;
  }

  return "先到这里。刚才大家已经围绕公开信息做了讨论，如果没有新的补充，我们继续往下推进。";
}

async function createDMMessage(input: {
  gameSessionId: string;
  phase: GamePhase;
  content: string;
  source: ExecuteDMFlowCursorNodeResult["source"];
  trigger: string;
  node: DMFlowNode | null;
  nextAction: "advance_phase" | "wait_for_user" | "none";
}): Promise<Message> {
  const targetRoleIds = getDMMessageTargetRoleIds(input.node);
  const speechAct = getDMMessageSpeechAct(input.node, input.content, targetRoleIds);
  const metadata: MessageMetadata = {
    revealed_facts: [],
    emotional_points: [],
    questions_raised:
      speechAct === "question" || speechAct === "dm_directed_question" || speechAct === "group_question"
        ? [input.content]
        : [],
    mentioned_role_ids: targetRoleIds,
    event_tags: [],
    topic_tags: [],
    source: input.source,
    dm_flow_node: input.node?.nodeId ?? "system_fallback",
    sourceNodeId: input.node?.nodeId,
    sourceNodeType: input.node?.type,
    sourceMode: input.source,
    trigger: input.trigger,
    storyBoardEligible: input.node?.type === "act_summary" || input.node?.type === "ending_reveal",
    next_action: input.nextAction
  };
  const messageInput: CreateMessageInput = {
    gameSessionId: input.gameSessionId,
    speakerType: "dm",
    speakerRoleId: "dm",
    speakerName: "DM",
    targetRoleIds,
    phase: input.phase,
    speechAct,
    content: input.content,
    metadata
  };

  const message = await createMessage(messageInput);

  if (isDMQuestionSpeechAct(speechAct)) {
    await savePendingDMQuestion({
      gameSessionId: input.gameSessionId,
      message,
      node: input.node,
      targetRoleNames: targetRoleIds
    });
  }

  return message;
}

async function savePendingDMQuestion(input: {
  gameSessionId: string;
  message: Message;
  node: DMFlowNode | null;
  targetRoleNames: string[];
}): Promise<void> {
  const session = await getGameSession(input.gameSessionId);
  const cursor = session.dmFlowCursor ?? createInitialCursor(input.node?.actIndex ?? session.currentActIndex + 1);

  await updateGameSession(input.gameSessionId, {
    dmFlowCursor: {
      ...cursor,
      pendingDMQuestion: {
        messageId: input.message.message_id,
        nodeId: input.node?.nodeId,
        actIndex: input.node?.actIndex ?? cursor.actIndex,
        questionText: input.message.content,
        targetRoleNames: input.targetRoleNames,
        expectedTopics: extractExpectedTopics(input.node, input.message.content),
        askedAt: new Date().toISOString(),
        answeredByRoleNames: [],
        cueCount: 0,
        status: "waiting"
      },
      lastPendingQuestionEvaluation: null
    }
  });
}

function isDMQuestionSpeechAct(speechAct: Message["speech_act"]): boolean {
  return (
    speechAct === "question" ||
    speechAct === "dm_prompt" ||
    speechAct === "dm_directed_question" ||
    speechAct === "group_question"
  );
}

export function extractExpectedTopics(node: DMFlowNode | null, fallbackText: string): string[] {
  const values = [
    ...(node?.requiredPublicPoints ?? []),
    ...(node?.ifMissingPoints ?? []),
    ...(node?.guidance?.requiredPublicPoints ?? []),
    ...(node?.guidance?.ifMissingPoints ?? []),
    node?.guidance?.discussionGoal ?? "",
    node?.guidance?.fallbackHint ?? "",
    node?.promptGoal ?? "",
    node?.text ?? "",
    fallbackText
  ];

  return Array.from(
    new Set(
      values
        .flatMap((value) => splitTopicText(value))
        .map((value) => value.trim())
        .filter((value) => value.length >= 2)
    )
  ).slice(0, 8);
}

function splitTopicText(value: string): string[] {
  return value
    .split(/[，。；;、\n\r：:？?！!（）()【】\[\]\s]+/)
    .flatMap((part) => {
      const trimmed = part.trim();

      if (!trimmed) {
        return [];
      }

      const keywordMatches = trimmed.match(/(?:\d{4}\s*年|\d+\s*月|\d+\s*日|坠楼案|七氟烷|赵恒诚|记事本|镜子|照片|信|药瓶|书房|储物间|天台|别墅|重复|多少次)/g);

      return keywordMatches?.length ? keywordMatches : [trimmed];
    })
    .filter((part) => part.length >= 2 && !/你们|大家|有没有|是不是|为什么|怎么看|说说|一下|这个|那个|自己/.test(part));
}

function contentMatchesTopic(content: string, topic: string): boolean {
  const topicParts = splitTopicText(topic);

  return topicParts.some((part) => content.includes(part)) || content.includes(topic);
}

function hasSubstantiveAnswer(content: string): boolean {
  const normalized = content.trim();

  if (normalized.length < 2) {
    return false;
  }

  if (/^(不知道|不清楚|没想起来|没有|不记得|说不上来)[。！!？?\s]*$/.test(normalized)) {
    return false;
  }

  return true;
}

function getDMMessageTargetRoleIds(node: DMFlowNode | null): string[] {
  const explicitTargets = [
    ...(node?.targetRoleNames ?? []),
    ...(node?.expectedSpeakerRoleNames ?? [])
  ].filter((roleName) => roleName.trim().length > 0);

  if (explicitTargets.length > 0) {
    return Array.from(new Set(explicitTargets));
  }

  return [];
}

export function getDMMessageSpeechAct(
  node: DMFlowNode | null,
  content: string,
  targetRoleIds: string[]
): Message["speech_act"] {
  if (node?.type === "transition") {
    return "transition";
  }

  if (node?.type === "act_summary") {
    return "summary";
  }

  if (node?.type === "free_discussion" && /自由讨论|可以讨论|开始讨论|大家聊|大家可以/.test(content)) {
    return "discussion_invitation";
  }

  if (node?.type === "dm_prompt" && targetRoleIds.length > 0) {
    return "dm_directed_question";
  }

  if (
    node?.type === "dm_prompt" &&
    (/大家|你们|有没有人|有人|各位|都醒了|都记起来|记起来自己|自己是谁|2007年的事|自己都做过/.test(content) ||
      (targetRoleIds.length === 0 && isDmQuestionText(content)))
  ) {
    return "group_question";
  }

  if (node?.type === "dm_prompt") {
    return "question";
  }

  return "notice";
}

function isDmQuestionText(content: string): boolean {
  return /[?？]|吗|呢|有没有|记起来|想起来|怎么看|觉得|谁|哪位|要不要|注意到|补充|说说|说一下|聊聊|回答|回应/.test(
    content
  );
}

async function runSharePromptFallback(input: {
  gameSessionId: string;
  trigger: DmFallbackTrigger;
  targetRoleId?: string | null;
  nextAction?: "advance_phase" | "wait_for_user" | "none";
}): Promise<ExecuteDMFlowCursorNodeResult> {
  const session = await getGameSession(input.gameSessionId);
  const content = getDmFallbackContent({
    trigger: input.trigger,
    roleName: input.targetRoleId ?? null,
    roleId: input.targetRoleId ?? null
  });
  const message = await createDMMessage({
    gameSessionId: input.gameSessionId,
    phase: session.currentPhase,
    content,
    source: "system_fallback",
    trigger: input.trigger,
    node: null,
    nextAction: input.nextAction ?? "wait_for_user"
  });

  return {
    handled: true,
    trigger: input.trigger,
    nodeKey: "share_prompt_fallback",
    source: "system_fallback",
    dmOutput: content,
    message,
    nextAction: input.nextAction ?? "wait_for_user",
    cursor: session.dmFlowCursor ?? null
  };
}

async function runTriggerFallback(input: {
  gameSessionId: string;
  trigger: DmFallbackTrigger;
  targetRoleId?: string | null;
  nextAction?: "advance_phase" | "wait_for_user" | "none";
}): Promise<ExecuteDMFlowCursorNodeResult> {
  const session = await getGameSession(input.gameSessionId);
  const content = getDmFallbackContent({
    trigger: input.trigger,
    roleName: input.targetRoleId ?? null,
    roleId: input.targetRoleId ?? null
  });
  const message = await createDMMessage({
    gameSessionId: input.gameSessionId,
    phase: session.currentPhase,
    content,
    source: "system_fallback",
    trigger: input.trigger,
    node: null,
    nextAction: input.nextAction ?? "none"
  });

  return {
    handled: true,
    trigger: input.trigger,
    nodeKey: "system_fallback",
    source: "system_fallback",
    dmOutput: content,
    message,
    nextAction: input.nextAction ?? "none",
    cursor: session.dmFlowCursor ?? null
  };
}

function getRuntimeActIndex(session: Awaited<ReturnType<typeof getGameSession>>): number {
  const match = session.currentActId.match(/runtime_act_(\d+)/);

  return match ? Number(match[1]) : session.currentActIndex + 1;
}

function compactNode(node: DMFlowNode): DMFlowCursorDebugView["currentNode"] {
  return {
    nodeId: node.nodeId,
    type: node.type,
    title: node.title,
    text: node.text,
    fixedLine: node.fixedLine,
    promptGoal: node.promptGoal,
    sourceQuote: node.sourceQuote
  };
}

async function getLatestDMRealizerRunOutput(
  gameSessionId: string,
  agentType: "dm_discussion_analyzer" | "dm_node_realizer"
): Promise<unknown> {
  const [run] = await listRecentAgentRuns(gameSessionId, [agentType], 1);
  const output = run?.outputJson;

  if (isRecord(output) && isRecord(output.data)) {
    return output.data;
  }

  return output;
}

function isDMDiscussionAnalysis(value: unknown): value is DMDiscussionAnalysis {
  if (!isRecord(value)) {
    return false;
  }

  return (
    Array.isArray(value.publicSummary) &&
    Array.isArray(value.mentionedPoints) &&
    Array.isArray(value.missingPoints) &&
    typeof value.suggestedDmAction === "string" &&
    Array.isArray(value.suggestedCueTargets) &&
    Array.isArray(value.safetyWarnings)
  );
}

function isDMRealizedSpeech(value: unknown): value is DMRealizedSpeech {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.text === "string" &&
    typeof value.sourceMode === "string" &&
    typeof value.shouldAdvanceAfterSpeaking === "boolean" &&
    typeof value.shouldWaitForUser === "boolean" &&
    Array.isArray(value.safetyWarnings)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function unhandled(trigger: DmFallbackTrigger): ExecuteDMFlowCursorNodeResult {
  return {
    handled: false,
    trigger,
    nodeKey: "",
    source: "system_fallback",
    dmOutput: "",
    message: null,
    nextAction: "none",
    cursor: null
  };
}
