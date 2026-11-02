import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/db/prisma";
import { getGameSession } from "@/src/lib/services/gameService";
import { getScriptRuntimeDefinition, type ScriptRuntimeDefinitionView } from "@/src/lib/services/scriptRuntimeDefinitionService";
import { getRuntimeMode } from "@/src/lib/services/runtimeMode";
import { validateDMLifecycle, isStageOperation, isSensitiveRecoveryNode, type DMLifecycleScope } from "@/src/lib/services/dmLifecycleValidation";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import { assertDMTransactionFence, withConversation, adoptAuthorizedDMAct } from "@/src/lib/services/conversationService";
import { createAgentRun, completeAgentRun, failAgentRun } from "@/src/lib/services/agentRunService";
import { runInTraceContext, getTraceContext } from "@/src/lib/observability/traceContext";
import { getMessage } from "@/src/lib/services/messageService";
import { getDmFallbackContent, type DmFallbackTrigger } from "@/src/lib/agents/dmFallbackTemplates";
import { realizeNodeForOutput, getDMMessageSpeechAct, extractExpectedTopics, type ExecuteDMFlowCursorNodeResult, type FlowLocation } from "@/src/lib/services/dmFlowCursorService";
import type { DMFlowCursor, GameSession, GamePhase, MessageMetadata } from "@/src/lib/types/game";

function scopeFor(session: GameSession, view: ScriptRuntimeDefinitionView): DMLifecycleScope {
  const saved = session.runtimeScope as Partial<DMLifecycleScope> | null;
  return { actRange: saved?.actRange ?? { start: 1, end: Math.max(...view.definition.acts.map(a => a.actIndex)) },
    roleNames: saved?.roleNames ?? view.definition.roles.map(r => r.roleName) };
}

export function lifecycleLocations(view: ScriptRuntimeDefinitionView, scope: DMLifecycleScope): FlowLocation[] {
  const flow = view.definition.dmFlow ?? { openingNodes: [], actFlows: [] };
  return [
    ...flow.openingNodes.map((node, nodeIndex) => ({ phase: "opening" as const, actIndex: scope.actRange.start, nodeIndex, node })),
    ...flow.actFlows.filter(f => f.actIndex >= scope.actRange.start && f.actIndex <= scope.actRange.end)
      .flatMap(f => f.nodes.map((node, nodeIndex) => ({ phase: "act" as const, actIndex: f.actIndex, nodeIndex, node })))
  ];
}

export function initialLifecycleCursor(view: ScriptRuntimeDefinitionView, scope: DMLifecycleScope): DMFlowCursor {
  const issues = validateDMLifecycle(view.definition, scope);
  const first = lifecycleLocations(view, scope)[0];
  const reason = issues.filter(i => i.fatal).map(i => `${i.code}: ${i.message}`).join("；");
  return { actIndex: first?.actIndex ?? scope.actRange.start, nodeIndex: first?.nodeIndex ?? 0,
    nodeId: reason ? undefined : first?.node.nodeId, phase: first?.phase ?? "act", waitingFor: reason ? "manual_continue" : "none",
    consumedNodeIds: [], completedNodeIds: [], triggeredRuleIds: [], warnings: issues.map(i => `${i.code}: ${i.message}`),
    lifecycle: { version: 1, definitionId: view.id, definitionVersion: view.version,
      recoveryKey: `${view.id}:${view.version}:initial`, recoveryStatus: reason ? "attention_required" : "healthy",
      recoveryNeedsAttention: reason || undefined } };
}

const entryType: Partial<Record<GamePhase, string>> = { role_selection: "opening", reading: "reading_start",
  ai_internal_reading: "reading_start", share_round: "sharing_round", free_discussion: "free_discussion", dm_question: "dm_prompt", act_summary: "act_summary" };

export async function ensureDMLifecycle(gameId: string): Promise<void> {
  const saved = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId }, select: { runtimeDefinitionId: true, dmFlowCursorJson: true } });
  if (!saved.runtimeDefinitionId) return;
  const savedCursor = fromJsonValue<DMFlowCursor | null>(saved.dmFlowCursorJson, null);
  if (savedCursor?.lifecycle?.definitionId === saved.runtimeDefinitionId) {
    const version = await prisma.scriptRuntimeDefinition.findUnique({ where: { id: saved.runtimeDefinitionId }, select: { version: true } });
    if (version?.version === savedCursor.lifecycle.definitionVersion) return;
  }
  await withConversation(gameId, "", async () => {
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    if (!row.runtimeDefinitionId) return;
    const session = await getGameSession(gameId);
    const view = await getScriptRuntimeDefinition(row.runtimeDefinitionId);
    const scope = scopeFor(session, view);
    const old = session.dmFlowCursor;
    if (old?.lifecycle?.definitionId === view.id && old.lifecycle.definitionVersion === view.version) return;
    let cursor = initialLifecycleCursor(view, scope);
    const locations = lifecycleLocations(view, scope);
    const actIndex = Number(session.currentActId.replace("runtime_act_", ""));
    const messages = await prisma.message.findMany({ where: { gameSessionId: gameId }, orderBy: { createdAt: "asc" } });
    const existingIds = messages.filter(m => m.speakerType === "dm").flatMap(m => {
      const meta = fromJsonValue<MessageMetadata>(m.metadata, {} as MessageMetadata);
      if (meta.runtimeDefinitionId && meta.runtimeDefinitionId !== view.id) return [];
      return typeof meta.sourceNodeId === "string" ? [meta.sourceNodeId] : [];
    });
    let attention = cursor.lifecycle!.recoveryNeedsAttention;
    const candidate = old?.nodeId ? locations.find(l => l.node.nodeId === old.nodeId) : locations.find(l =>
      l.actIndex === actIndex && (session.currentPhase === "role_selection" ? l.phase === "opening" : l.node.type === entryType[session.currentPhase]));
    if (old?.lifecycle && old.lifecycle.definitionId !== view.id) attention = "definition_changed_requires_explicit_recovery";
    if (!candidate && session.currentPhase !== "finished") attention ||= "no_unambiguous_phase_entry";
    if (!old?.nodeId && candidate && !["reading_start", "sharing_round", "free_discussion"].includes(candidate.node.type) && session.currentPhase !== "role_selection") attention ||= "unsafe_recovery_entry";
    if (!old?.nodeId && session.currentPhase === "share_round" && !session.userReadActIds.includes(session.currentActId)) attention ||= "reading_completion_not_confirmed";
    if (!old?.nodeId && session.currentPhase === "free_discussion") {
      const boundary = messages.filter(m => {
        const meta = fromJsonValue<MessageMetadata>(m.metadata, {} as MessageMetadata);
        return m.speakerType === "dm" && meta.act_id === session.currentActId && meta.sourceNodeType === "reading_start";
      }).at(-1)?.createdAt;
      const shared = new Set(messages.filter(m => {
        const meta = fromJsonValue<MessageMetadata>(m.metadata, {} as MessageMetadata);
        return m.phase === "share_round" && m.speechAct === "share" && (meta.act_id === session.currentActId ||
          !meta.act_id && (boundary ? m.createdAt >= boundary : scope.actRange.start === scope.actRange.end));
      }).map(m => m.speakerRoleId));
      // Older messages did not store act_id. Only single-act recovery may use them.
      const scopedActs = view.definition.acts.filter(a => a.actIndex >= scope.actRange.start && a.actIndex <= scope.actRange.end);
      const freePolicy = view.definition.acts.find(a => a.actIndex === actIndex)?.control?.conversationPolicy.mode === "free_discussion_after_reading";
      if (freePolicy ? !session.userReadActIds.includes(session.currentActId) : scopedActs.length > 1 && !boundary || !scope.roleNames.every(r => shared.has(r))) attention ||= freePolicy ? "reading_completion_not_confirmed" : "all_shares_not_confirmed_for_current_act";
    }
    if (candidate && (isStageOperation(candidate.node) || isSensitiveRecoveryNode(candidate.node))) attention ||= "high_risk_recovery_node";
    if (old?.pendingDMQuestion?.status === "waiting" && !old.nodeId) attention ||= "pending_question_without_owner";
    cursor = { ...cursor, ...(old ?? {}), lifecycle: { ...cursor.lifecycle!, recoveryKey: `${view.id}:${view.version}:${session.currentActId}:${session.currentPhase}`,
      recoveryStatus: attention ? "attention_required" : "recovered", recoveryNeedsAttention: attention },
      warnings: [...new Set([...cursor.warnings, ...(old?.warnings ?? []), ...(attention ? [attention] : [])])] };
    if (!attention && candidate) {
      cursor = { ...cursor, nodeId: candidate.node.nodeId, nodeIndex: candidate.nodeIndex, phase: candidate.phase, actIndex: candidate.actIndex,
        waitingFor: old?.waitingFor ?? waitingFor(candidate.node.type), consumedNodeIds: [...new Set([...cursor.consumedNodeIds, ...existingIds])],
        completedNodeIds: cursor.completedNodeIds };
    }
    const id = randomUUID();
    cursor.lifecycle!.lastEvaluation = { id, trigger: "recovery", source: "snapshot_or_request", evaluatedAt: new Date().toISOString(),
      result: "recovery", reason: attention ?? "safe_phase_cursor_restored_no_history_replay", beforeNode: old?.nodeId ?? null,
      afterNode: cursor.nodeId ?? null, messageId: null };
    const restored = await prisma.$transaction(async tx => {
      await assertDMTransactionFence(tx, gameId);
      const changed = await tx.gameSession.updateMany({ where: { id: gameId, dmFlowCursorJson: row.dmFlowCursorJson,
        currentActId: row.currentActId, currentPhase: row.currentPhase, runtimeDefinitionId: view.id }, data: { dmFlowCursorJson: toJsonInput(cursor) } });
      if (!changed.count) return false;
      await tx.agentRun.create({ data: { id, gameSessionId: gameId, agentType: "dm_lifecycle_evaluation", runKind: "span",
        actId: row.currentActId, phase: row.currentPhase, input: toJsonInput({ trigger: "recovery", definitionId: view.id, definitionVersion: view.version,
          executionMode: getRuntimeMode(session), scope }), output: toJsonInput(cursor.lifecycle!.lastEvaluation), status: "success", finishedAt: new Date() } });
      return true;
    });
    if (restored && !attention && !old?.nodeId && candidate &&
      (candidate.node.fixedLine || ["reading_start", "sharing_round"].includes(candidate.node.type) && candidate.node.text)) {
      const trigger = ({ reading_start: "enter_reading", sharing_round: "enter_share_round", free_discussion: "enter_free_discussion" } as const)[candidate.node.type as "reading_start"];
      if (trigger) await executeEvent({ gameSessionId: gameId, trigger });
    }
  }, true);
}

function waitingFor(type: string): DMFlowCursor["waitingFor"] {
  return ({ reading_start: "player_read_done", sharing_round: "all_shares_done", free_discussion: "discussion_close", dm_prompt: "discussion_close",
    act_summary: "manual_continue", transition: "act_transition" } as const)[type as "reading_start"] ?? "none";
}

function phaseFor(location: FlowLocation, current: GamePhase): GamePhase {
  if (location.phase === "opening") return current;
  return ({ reading_start: "reading", sharing_round: "share_round", free_discussion: "free_discussion", dm_prompt: "free_discussion", act_summary: "act_summary" } as const)[location.node.type as "reading_start"] ?? current;
}

export async function runDMLifecycle(input: { gameSessionId: string; trigger: DmFallbackTrigger; targetRoleId?: string | null }): Promise<ExecuteDMFlowCursorNodeResult> {
  await (await import("./modelAvailabilityService")).assertModelAvailable(input.gameSessionId);
  await ensureDMLifecycle(input.gameSessionId);
  const locked = await withConversation(input.gameSessionId, "", () => executeEvent(input), true);
  if (locked) {
    void (await import("./dmTextFlowService")).scheduleTextDMTick(input.gameSessionId).catch(() => null);
    return locked;
  }
  const session = await getGameSession(input.gameSessionId);
  const run = await createAgentRun({ gameSessionId: input.gameSessionId, agentType: "dm_lifecycle_evaluation", runKind: "span",
    actId: session.currentActId, phase: session.currentPhase, inputJson: { trigger: input.trigger, source: "fsm_event", executionMode: getRuntimeMode(session),
      definitionId: session.runtimeDefinitionId, definitionVersion: session.dmFlowCursor?.lifecycle?.definitionVersion } });
  await completeAgentRun({ agentRunId: run.id, outputJson: { result: "skipped", reason: "active_conversation_lease", beforeNode: session.dmFlowCursor?.nodeId,
    afterNode: session.dmFlowCursor?.nodeId, messageId: null, waitingFor: session.dmFlowCursor?.waitingFor }, latencyMs: Date.now() - run.startedAt.getTime() });
  return { handled: true, trigger: input.trigger, nodeKey: "busy", source: "system_fallback", dmOutput: "", message: null,
    nextAction: "none", cursor: session.dmFlowCursor ?? null };
}

async function executeEvent(input: { gameSessionId: string; trigger: DmFallbackTrigger; targetRoleId?: string | null }): Promise<ExecuteDMFlowCursorNodeResult> {
  const gameId = input.gameSessionId;
  const session = await getGameSession(gameId);
  if (session.currentPhase === "finished") return { handled: true, trigger: input.trigger, nodeKey: "finished",
    source: "script_fixed", dmOutput: "", message: null, nextAction: "none", cursor: session.dmFlowCursor ?? null };
  let row = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId!);
  const locations = lifecycleLocations(view, scopeFor(session, view));
  let cursor = session.dmFlowCursor!;
  const beforeNode = cursor.nodeId ?? null;
  const mode = getRuntimeMode(session);
  const entry = locations.find(l => l.node.nodeId === cursor.nodeId);
  if (input.trigger === "enter_reading" && entry?.node.type === "reading_start" && entry.node.clueAction) {
    await (await import("./runtimeClueService")).executeRuntimeClueNode(gameId, { definitionId: view.id, definitionVersion: view.version, actId: session.currentActId, nodeId: entry.node.nodeId });
    cursor = (await getGameSession(gameId)).dmFlowCursor!;
    row = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  }
  const textResult = await (await import("./dmTextFlowService")).executeTextDMFlow(input);
  if (textResult) return textResult;
  if (input.trigger === "discussion_turn_limit_reached" && mode === "runtime_auto") {
    const monitored = await (await import("./dmPublicPointService")).monitorPublicDiscussion(gameId);
    if (monitored) return { handled: true, trigger: input.trigger, nodeKey: cursor.nodeId ?? "public_discussion",
      source: "conditional_rule", dmOutput: monitored.message?.content ?? "", message: monitored.message,
      nextAction: "wait_for_user", cursor: (await getGameSession(gameId)).dmFlowCursor ?? null };
  }
  const run = await createAgentRun({ gameSessionId: gameId, agentType: "dm_lifecycle_evaluation", runKind: "span", actId: session.currentActId,
    phase: session.currentPhase, inputJson: { trigger: input.trigger, source: "fsm_event", definitionId: view.id, definitionVersion: view.version,
      executionMode: mode, beforeNode, waitingFor: cursor.waitingFor } });
  const started = Date.now();
  let result: "executed" | "waiting" | "advanced" | "skipped" = "waiting";
  let reason = "waiting_for_lifecycle_event";
  let content = "";
  let source: ExecuteDMFlowCursorNodeResult["source"] = "script_fixed";
  let location = locations.find(l => l.node.nodeId === cursor.nodeId);
  let messageId: string | null = null;
  let outputPhase: GamePhase = session.currentPhase;
  let fallback = false;
  try {
    const attention = cursor.lifecycle?.recoveryNeedsAttention;
    if (attention || mode === "runtime_manual_debug") {
      result = "skipped"; reason = attention ?? "explicit_manual_debug";
    } else if (input.trigger === "before_next_share") {
      const key = `${view.id}:${session.currentActId}:share:${session.currentShareIndex}:${input.targetRoleId}`;
      const duplicate = await prisma.message.findFirst({ where: { gameSessionId: gameId, metadata: { contains: key } } });
      if (!duplicate && input.targetRoleId && session.currentPhase === "share_round") {
        content = getDmFallbackContent({ trigger: input.trigger, roleId: input.targetRoleId, roleName: input.targetRoleId });
        fallback = true; reason = key; result = "executed";
      } else { result = "skipped"; reason = "share_prompt_already_sent_or_not_in_share_phase"; }
    } else if (cursor.pendingDMQuestion?.status === "waiting") {
      reason = "pending_question_must_not_be_overwritten";
    } else if (location) {
      const currentType = location.node.type;
      const freePolicy = view.definition.acts.find(a => a.actIndex === location!.actIndex)?.control?.conversationPolicy.mode === "free_discussion_after_reading";
      if (input.trigger === "discussion_turn_limit_reached" && ["free_discussion", "dm_prompt"].includes(currentType) && !cursor.completedNodeIds.includes(location.node.nodeId)) {
        const context = getTraceContext();
        const realized = await runInTraceContext({ traceId: context?.traceId ?? run.id, parentRunId: run.id }, () => realizeNodeForOutput({
          gameSessionId: gameId, node: location!.node, trigger: input.trigger, phase: session.currentPhase }));
        content = realized.speech.text; source = realized.speech.sourceMode;
        result = "executed"; reason = realized.speech.shouldAdvanceAfterSpeaking ? "discussion_closed" : "discussion_still_waiting";
        cursor = { ...cursor, waitingFor: realized.speech.shouldAdvanceAfterSpeaking ? "none" : "user_input",
          lastAdvanceReason: realized.speech.shouldAdvanceAfterSpeaking ? "discussion_closed" : "dm_cued_missing_point" };
        if (realized.speech.shouldAdvanceAfterSpeaking) {
          cursor = { ...cursor, completedNodeIds: [...new Set([...cursor.completedNodeIds, location.node.nodeId])] };
        }
      }
      const releases = input.trigger === "enter_reading" && location.phase === "opening" ||
        input.trigger === "enter_share_round" && currentType === "reading_start" ||
        input.trigger === "enter_free_discussion" && currentType === "reading_start" && freePolicy ||
        (input.trigger === "all_shares_completed" || input.trigger === "enter_free_discussion") && currentType === "sharing_round" ||
        input.trigger === "enter_act_summary" && currentType === "free_discussion";
      if (releases && cursor.consumedNodeIds.includes(location.node.nodeId)) {
        cursor = { ...cursor, completedNodeIds: [...new Set([...cursor.completedNodeIds, location.node.nodeId])] };
        if (cursor.lifecycle) cursor.lifecycle = { ...cursor.lifecycle, authorizedTrigger: input.trigger };
        location = locations[locations.indexOf(location) + 1];
        if (location) cursor = { ...cursor, nodeId: location.node.nodeId, actIndex: location.actIndex, nodeIndex: location.nodeIndex,
          phase: location.phase, waitingFor: waitingFor(location.node.type) };
      }
      const eventTypes: Partial<Record<DmFallbackTrigger, string[]>> = { game_started: ["opening"], enter_reading: ["reading_start"],
        enter_share_round: ["sharing_round"], all_shares_completed: ["free_discussion"], enter_free_discussion: ["free_discussion"],
        enter_act_summary: ["act_summary"], advance_to_next_act: ["transition"], finished: ["transition"] };
      const allowed = location && (eventTypes[input.trigger]?.includes(location.phase === "opening" ? "opening" : location.node.type) ||
        location.node.type === "fixed_line" && cursor.lifecycle?.authorizedTrigger === input.trigger);
      if (content) { /* Discussion close uses the current node, not a type-search jump. */ }
      else if (!location) { result = "skipped"; reason = "no_next_node_no_implicit_reveal"; }
      else if (isStageOperation(location.node) || ["unknown", "clue_release", "performance_instruction", "ending_reveal"].includes(location.node.type)) {
        reason = "stage_or_reveal_node_requires_explicit_developer_action";
        if (cursor.lifecycle) cursor.lifecycle = { ...cursor.lifecycle, recoveryStatus: "attention_required", recoveryNeedsAttention: reason };
      } else if (cursor.consumedNodeIds.includes(location.node.nodeId)) { result = "skipped"; reason = "node_already_consumed"; }
      else if (allowed) {
        outputPhase = phaseFor(location, session.currentPhase);
        const deterministic = location.node.fixedLine?.trim() || (["reading_start", "sharing_round", "transition"].includes(location.node.type) ? location.node.text?.trim() : null);
        content = deterministic || "";
        if (!content) {
          const context = getTraceContext();
          const realized = await runInTraceContext({ traceId: context?.traceId ?? run.id, parentRunId: run.id }, () => realizeNodeForOutput({
            gameSessionId: gameId, node: location!.node, trigger: input.trigger, phase: outputPhase }));
          content = realized.speech.text; source = realized.speech.sourceMode;
        }
        result = "executed"; reason = "current_cursor_node_authorized_by_fsm_event";
      } else { reason = "event_does_not_release_current_node"; }
    } else { result = "skipped"; reason = "no_current_node"; }
    const id = content ? randomUUID() : null;
    await prisma.$transaction(async tx => {
      await assertDMTransactionFence(tx, gameId);
      if (content && !fallback && location) {
        cursor = { ...cursor, consumedNodeIds: [...new Set([...cursor.consumedNodeIds, location.node.nodeId])],
          lastExecutedNodeId: location.node.nodeId, waitingFor: input.trigger === "discussion_turn_limit_reached" ? cursor.waitingFor : waitingFor(location.node.type) };
      }
      if (cursor.lifecycle) cursor.lifecycle.lastEvaluation = { id: run.id, trigger: input.trigger, source: "fsm_event", evaluatedAt: new Date().toISOString(),
        result, reason, beforeNode, afterNode: cursor.nodeId ?? null, messageId: id };
      const changed = await tx.gameSession.updateMany({ where: { id: gameId, runtimeDefinitionId: view.id, dmFlowCursorJson: row.dmFlowCursorJson,
        currentActId: row.currentActId, currentPhase: row.currentPhase }, data: { dmFlowCursorJson: toJsonInput(cursor), currentPhase: content && !fallback ? outputPhase : row.currentPhase } });
      if (!changed.count) throw new Error("DM lifecycle cursor changed before commit");
      if (content && id) {
        const node = fallback ? null : location?.node ?? null;
        const targets = [...new Set([...(node?.targetRoleNames ?? []), ...(node?.expectedSpeakerRoleNames ?? [])])];
        const speechAct = getDMMessageSpeechAct(node, content, targets);
        const last = await tx.message.findFirst({ where: { gameSessionId: gameId }, orderBy: { createdAt: "desc" } });
        await tx.message.create({ data: { id, gameSessionId: gameId, speakerType: "dm", speakerRoleId: "dm", speakerName: "DM",
          phase: outputPhase, speechAct, targetRoleIds: toJsonInput(targets), content, createdAt: new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)),
          metadata: toJsonInput({ revealed_facts: [], emotional_points: [], questions_raised: [], mentioned_role_ids: targets, event_tags: [], topic_tags: [],
            runtimeDefinitionId: view.id, runtimeDefinitionVersion: view.version, act_id: session.currentActId, sourceNodeId: node?.nodeId,
            sourceNodeType: node?.type, sourceMode: fallback ? "system_fallback" : source, source: fallback ? "system_fallback" : source,
            storyBoardEligible: node?.type === "act_summary", next_action: "wait_for_user",
            trigger: input.trigger, executionMode: mode, dmRunId: run.id, traceId: run.traceId ?? run.id, lifecycleKey: fallback ? reason : `${view.id}:${view.version}:${node?.nodeId}` }) } });
        if (["dm_directed_question", "group_question", "dm_prompt", "question"].includes(speechAct) && node) {
          cursor.pendingDMQuestion = { messageId: id, nodeId: node.nodeId, actIndex: cursor.actIndex, questionText: content,
            targetRoleNames: targets, expectedTopics: extractExpectedTopics(node, content), askedAt: new Date().toISOString(), answeredByRoleNames: [], cueCount: 0, status: "waiting" };
          await tx.gameSession.update({ where: { id: gameId }, data: { dmFlowCursorJson: toJsonInput(cursor) } });
        }
        messageId = id;
      }
    });
    await completeAgentRun({ agentRunId: run.id, outputJson: { ...cursor.lifecycle?.lastEvaluation, definitionId: view.id,
      definitionVersion: view.version, executionMode: mode, sourceNodeId: fallback ? null : location?.node.nodeId,
      waitingFor: cursor.waitingFor }, latencyMs: Date.now() - started });
    const answer: ExecuteDMFlowCursorNodeResult = { handled: true, trigger: input.trigger, nodeKey: fallback ? "share_prompt_fallback" : cursor.nodeId ?? "attention_required",
      source: fallback ? "system_fallback" : source, dmOutput: content, message: messageId ? await getMessage(messageId) : null,
      nextAction: "wait_for_user", cursor };
    if (reason === "discussion_closed" && cursor.pendingDMQuestion?.status !== "waiting") {
      const next = locations[locations.findIndex(l => l.node.nodeId === cursor.nodeId) + 1];
      if (next?.node.type === "act_summary") {
        const follow = await executeEvent({ gameSessionId: gameId, trigger: "enter_act_summary" });
        answer.autoExecutedMessage = follow.autoExecutedMessage ?? follow.message;
        answer.cursor = follow.cursor;
      }
    }
    if (content && !fallback && location?.node.type === "fixed_line" && location.node.fixedLine && cursor.pendingDMQuestion?.status !== "waiting") {
      const next = locations[locations.indexOf(location) + 1];
      if (next && (location.phase === "opening" && next.phase === "opening" || cursor.lifecycle?.authorizedTrigger === input.trigger)) {
        const { updateGameSession } = await import("@/src/lib/services/gameService");
        await updateGameSession(gameId, { dmFlowCursor: { ...cursor, nodeId: next.node.nodeId, nodeIndex: next.nodeIndex, actIndex: next.actIndex,
          phase: next.phase, waitingFor: waitingFor(next.node.type), completedNodeIds: [...new Set([...cursor.completedNodeIds, location.node.nodeId])] } });
        const follow = await executeEvent(input);
        answer.autoExecutedMessage = follow.autoExecutedMessage ?? follow.message;
        answer.cursor = follow.cursor;
      }
    }
    if (input.trigger === "enter_act_summary" && content && location?.node.fixedLine && cursor.pendingDMQuestion?.status !== "waiting") {
      const next = locations[locations.indexOf(location) + 1];
      if (next?.node.type === "transition" && (next.node.fixedLine || next.node.text) && !isStageOperation(next.node)) {
        const { updateGameSession } = await import("@/src/lib/services/gameService");
        await updateGameSession(gameId, { dmFlowCursor: { ...cursor, nodeId: next.node.nodeId, nodeIndex: next.nodeIndex,
          actIndex: next.actIndex, phase: next.phase, completedNodeIds: [...new Set([...cursor.completedNodeIds, location.node.nodeId])], waitingFor: "act_transition" } });
        await advanceRuntimeTransition(gameId);
        answer.cursor = (await getGameSession(gameId)).dmFlowCursor ?? null;
      }
    }
    return answer;
  } catch (error) {
    await failAgentRun({ agentRunId: run.id, error: error instanceof Error ? error.message : String(error), outputJson: {
      trigger: input.trigger, result: "failed", beforeNode, afterNode: cursor.nodeId ?? null, messageId, sourceNodeId: location?.node.nodeId }, latencyMs: Date.now() - started });
    throw error;
  }
}

export async function advanceRuntimeTransition(gameId: string): Promise<void> {
  await (await import("./modelAvailabilityService")).assertModelAvailable(gameId);
  const result = await withConversation(gameId, "", async () => { await advanceTransitionLocked(gameId); return true; }, true);
  if (!result) throw new Error("后台对话仍在处理中，暂不能转场。");
}

async function advanceTransitionLocked(gameId: string): Promise<void> {
  const session = await getGameSession(gameId);
  if (session.currentPhase === "finished") return;
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId!);
  const locations = lifecycleLocations(view, scopeFor(session, view));
  const cursor = session.dmFlowCursor;
  const index = locations.findIndex(l => l.node.nodeId === cursor?.nodeId);
  const current = locations[index];
  if (current?.node.type === "reading_start" && session.currentPhase === "reading" && cursor?.lastAdvanceReason === "legal_act_transition") return;
  const currentActNodes = locations.filter(l => l.actIndex === current?.actIndex && l.phase === "act");
  if (current?.node.type === "transition" && currentActNodes.some(l => l.node.textExecution) &&
    !(cursor?.textPresentation?.kind === "transition" && cursor.textPresentation.nodeId === current.node.nodeId && cursor.textPresentation.confirmed)) {
    throw new Error("请先点击进入下一幕，确认本幕演绎已读完。");
  }
  if (current?.node.type === "transition" && currentActNodes.some(l => (l.node.textExecution || l.node.discussionExit || l.node.choice || l.node.choiceRecap || l.node.choiceEnding || l.node.matchingReveal || l.node.clueAction || l.node.knowledgeRelease) && !cursor?.completedNodeIds.includes(l.node.nodeId))) {
    throw new Error("Required text/interaction nodes have not completed");
  }
  if (cursor?.lifecycle?.recoveryNeedsAttention || current?.node.type !== "transition" || cursor?.pendingDMQuestion?.status === "waiting") {
    throw new Error("当前 DMFlow 尚未到达合法转场点，不能进入下一幕。强制跳过仅用于开发调试。");
  }
  if (current.node.continuationRequired && !locations[index + 1])
    throw new Error("后续幕尚未包含在已校验运行范围内。当前进度已保留，不能将范围结束当作整局完成。");
  await runDMLifecycle({ gameSessionId: gameId, trigger: "advance_to_next_act" });
  const fresh = await getGameSession(gameId);
  if (!fresh.dmFlowCursor?.consumedNodeIds.includes(current.node.nodeId)) throw new Error("转场节点尚未成功执行。");
  const next = locations[index + 1];
  const fullEnding = !next && scopeFor(session, view).actRange.start === view.definition.acts[0]?.actIndex &&
    current.actIndex === view.definition.acts.at(-1)?.actIndex && currentActNodes.some(l => l.node.choiceEnding || l.node.choice?.type !== "group_matching" && l.node.choice?.endsGame);
  const endTrigger = fullEnding ? "game_completed" : "test_scope_end";
  if (next && (next.actIndex <= current.actIndex || next.node.type !== "reading_start")) throw new Error("下一幕入口不明确，停止转场。请检查 DMFlow 顺序。");
  const updated = { ...fresh.dmFlowCursor, completedNodeIds: [...new Set([...fresh.dmFlowCursor.completedNodeIds, current.node.nodeId])],
    textPresentation: undefined,
    waitingFor: next ? "player_read_done" as const : fullEnding ? "none" as const : "test_scope_end" as const,
    ...(next ? { nodeId: next.node.nodeId, nodeIndex: next.nodeIndex, actIndex: next.actIndex, phase: next.phase } : {}),
    lastAdvanceReason: next ? "legal_act_transition" : endTrigger };
  if (next) {
    const { updateGameSession } = await import("@/src/lib/services/gameService");
    await updateGameSession(gameId, { dmFlowCursor: updated, currentPhase: "reading", currentActId: `runtime_act_${next.actIndex}`,
      currentShareIndex: 0, discussionTurnCount: 0 });
    if (view.definition.acts.find(a => a.actIndex === next.actIndex)?.modelPolicy === "disabled")
      (await import("./runtimeModelPolicy")).cancelRuntimeModelCalls(gameId);
    adoptAuthorizedDMAct(gameId, `runtime_act_${next.actIndex}`);
    await runDMLifecycle({ gameSessionId: gameId, trigger: "enter_reading" });
  } else {
    const key = `${view.id}:${view.version}:${endTrigger}`;
    const run = await createAgentRun({ gameSessionId: gameId, agentType: "dm_lifecycle_evaluation", runKind: "span", actId: fresh.currentActId,
      phase: fresh.currentPhase, inputJson: { trigger: endTrigger, source: "legal_transition", definitionId: view.id, definitionVersion: view.version, executionMode: getRuntimeMode(fresh) } });
    const id = randomUUID();
    try {
      await prisma.$transaction(async tx => {
        await assertDMTransactionFence(tx, gameId);
        const row = await tx.gameSession.findUniqueOrThrow({ where: { id: gameId } });
        if (row.dmFlowCursorJson !== JSON.stringify(fresh.dmFlowCursor)) throw new Error("DM transition cursor changed");
        if (updated.lifecycle) updated.lifecycle.lastEvaluation = { id: run.id, trigger: endTrigger, source: "legal_transition",
          evaluatedAt: new Date().toISOString(), result: "advanced", reason: fullEnding ? "full_game_completed" : "authorized_scope_completed", beforeNode: current.node.nodeId, afterNode: current.node.nodeId, messageId: id };
        await tx.gameSession.update({ where: { id: gameId }, data: { dmFlowCursorJson: toJsonInput(updated), currentPhase: "finished", currentShareIndex: 0, discussionTurnCount: 0 } });
        if (!await tx.message.findFirst({ where: { gameSessionId: gameId, metadata: { contains: key } } })) await tx.message.create({ data: {
          id, gameSessionId: gameId, speakerType: "dm", speakerRoleId: "dm", speakerName: "DM", phase: "finished", speechAct: "notice", targetRoleIds: "[]",
          content: fullEnding ? "故事已经结束。所有选择与最终记录已保存。" : "当前运行范围已完成。不会打开范围外的下一幕或结局内容。",
          metadata: toJsonInput({ revealed_facts: [], emotional_points: [], questions_raised: [], mentioned_role_ids: [], event_tags: [], topic_tags: [],
            source: "system_fallback", sourceMode: "system_fallback", trigger: endTrigger, runtimeDefinitionId: view.id,
            runtimeDefinitionVersion: view.version, executionMode: getRuntimeMode(fresh), lifecycleKey: key, act_id: fresh.currentActId, dmRunId: run.id, traceId: run.traceId ?? run.id }) } });
      });
      (await import("./runtimeModelPolicy")).cancelRuntimeModelCalls(gameId);
      await completeAgentRun({ agentRunId: run.id, outputJson: updated.lifecycle?.lastEvaluation, latencyMs: Date.now() - run.startedAt.getTime() });
    } catch (error) {
      await failAgentRun({ agentRunId: run.id, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
