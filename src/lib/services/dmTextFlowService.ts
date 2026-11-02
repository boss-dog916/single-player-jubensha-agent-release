import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/db/prisma";
import { getGameSession } from "./gameService";
import { getScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import { assertDMTransactionFence, withConversation, conversationCheckpoint, deferConversationSeed } from "./conversationService";
import { getRuntimeMode } from "./runtimeMode";
import { toJsonInput } from "./jsonFields";
import { listMessages, getMessage } from "./messageService";
import { monitorPublicDiscussion, publicPointRules, observeDMCondition } from "./dmPublicPointService";
import { validateDMLifecycle } from "./dmLifecycleValidation";
import { localPlaytestDMSpeech } from "./localPlaytestDMSpeech";
import type { ExecuteDMFlowCursorNodeResult } from "./dmFlowCursorService";
import type { DmFallbackTrigger } from "@/src/lib/agents/dmFallbackTemplates";
import type { DMFlowCursor, Message } from "@/src/lib/types/game";
import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import { nextTextUnit, textConfirmationReady, skippedResponsesSettleWait } from "./dmTextPresentation";
import { getDiscussionReadiness, activeDiscussionNode } from "./discussionReadiness";

import { choiceComplete, choiceEquals, choiceReceipts, choiceRoleIds, matchingReceipt, earlierChoiceNode } from "./runtimeChoiceState";

const publicResponse = (m: Message, actId: string) => m.metadata.act_id === actId &&
  ["user", "ai_player"].includes(m.speaker_type) && ["free_discussion", "dm_question", "share_round"].includes(m.phase);
const messageTime = (m: Message) => m.created_at?.getTime() ?? 0;

function matchingPublicationState(node: DMFlowNode, nodes: DMFlowNode[], cursor: DMFlowCursor,
  messages: Message[], actId: string, definitionId: string) {
  const prior = earlierChoiceNode(nodes, node, node.matchingReveal!);
  const receipt = prior ? matchingReceipt(cursor, prior) : undefined;
  const questionNode = nodes.find(n => n.nodeId === node.matchingReveal!.afterQuestionNodeId);
  const question = messages.find(m => m.speaker_type === "dm" && m.metadata.sourceNodeId === questionNode?.nodeId &&
    m.metadata.runtimeDefinitionId === definitionId && m.metadata.act_id === actId);
  const expected = questionNode?.expectedSpeakerRoleNames.length ? questionNode.expectedSpeakerRoleNames : questionNode?.targetRoleNames ?? [];
  const replies = question ? messages.filter(m => publicResponse(m, actId) && messageTime(m) > messageTime(question) &&
    (!expected.length || expected.includes(m.speaker_role_id ?? ""))) : [];
  return { receipt, ready: Boolean(receipt && prior && questionNode?.textExecution?.wait &&
    cursor.completedNodeIds.includes(prior.nodeId) && cursor.completedNodeIds.includes(questionNode.nodeId) &&
    (replies.length >= questionNode.textExecution.wait.maxResponses || cursor.pendingDMQuestion?.messageId === question?.message_id &&
      skippedResponsesSettleWait(expected, cursor.pendingDMQuestion, replies))) };
}

function discussionProgress(node: DMFlowNode, cursor: DMFlowCursor, messages: Message[], entered: Message, actId: string,
  participation?: Awaited<ReturnType<typeof import("@/src/lib/orchestration/discussionOrchestrator").getDiscussionParticipation>>,
  readiness?: Awaited<ReturnType<typeof getDiscussionReadiness>>) {
  const exit = node.discussionExit!, now = Date.now(), rules = publicPointRules(node);
  const pending = cursor.pendingDMQuestion;
  const waiting = pending?.nodeId === node.nodeId && ["waiting", "partial_answered"].includes(pending.status);
  const questionDeadline = waiting ? Date.parse(pending!.askedAt) + exit.questionWaitMs : null;
  const waitingDeadline = exit.onUnconfirmed === "block" && questionDeadline !== null && questionDeadline <= now ? null : questionDeadline;
  const limitAt = messageTime(entered) + exit.maxWaitMs;
  if (readiness && !readiness.ready) return { finished: false,
    deadline: readiness.pendingRoleIds.length ? participation?.pendingRoleIds.length ? now : null :
      !readiness.humanExpressed || readiness.pendingQuestions.length ? null : readiness.quietUntil,
    reason: readiness.reason };
  // Time is a wakeup/soft fallback, never proof of expression or information.
  // Exhausted model failures may settle only at the authored soft deadline;
  // their public information remains unconfirmed in the existing observer.
  if (participation?.pendingRoleIds.length) return { finished: false, deadline: waiting ? waitingDeadline : now, reason: "awaiting_role_expression" };
  if (participation?.exhaustedRoleIds.length && (now < limitAt || exit.onUnconfirmed === "block"))
    return { finished: false, deadline: exit.onUnconfirmed === "continue" ? limitAt : null, reason: "role_expression_failed" };
  if (!rules.length) {
    const count = messages.filter(m => publicResponse(m, actId) && messageTime(m) >= messageTime(entered)).length;
    const humanExpressed = participation?.humanExpressed === true;
    return { finished: !waiting && (humanExpressed && count >= exit.minMessages ||
      (now >= limitAt || count >= exit.maxMessages) && exit.onUnconfirmed === "continue"),
      deadline: waiting ? waitingDeadline : limitAt, reason: participation?.exhaustedRoleIds.length ? "soft_participation_failures_unconfirmed" : "participation_checked_no_authored_semantic_goals" };
  }
  const missing = rules.filter(r => cursor.publicPointCoverage?.points.find(p => p.ruleId === r.ruleId)?.status !== "mentioned");
  const cueDeadlines = missing.map(rule => {
    if (cursor.pendingDMQuestion?.publicPointRuleId === rule.ruleId && cursor.pendingDMQuestion.closeReason === "ai_response_skipped" && cursor.pendingDMQuestion.status === "closed")
      return Date.parse(cursor.pendingDMQuestion.askedAt);
    const cue = messages.find(m => m.speaker_type === "dm" && m.metadata.act_id === actId &&
      m.metadata.sourceNodeId === node.nodeId && m.metadata.conditionalRuleId === rule.ruleId);
    return cue ? messageTime(cue) + exit.questionWaitMs : null;
  });
  const offeredAll = cueDeadlines.every(deadline => deadline !== null);
  const softSettled = exit.onUnconfirmed === "continue" && offeredAll &&
    (cueDeadlines.every(deadline => deadline! <= now) || now >= limitAt);
  const finished = !waiting && (!missing.length || softSettled);
  // Authored information goals outrank fixture pacing counts. Unconfirmed soft
  // goals stay unconfirmed; each gets its existing safe cue and bounded wait.
  const deadline = waiting ? waitingDeadline : finished || !offeredAll ? now :
    exit.onUnconfirmed === "continue" ? Math.min(...cueDeadlines.filter((d): d is number => d !== null && d > now), limitAt) : null;
  return { finished, deadline, reason: missing.length ? "soft_goals_cued_and_expired" : "public_goals_observed" };
}

// A narrow extension of the existing node cursor: text nodes are persisted once,
// interactive nodes yield to the existing chat runner, and only authored gates
// advance the stage. No new planner, memory store or generated fixed text.
export async function executeTextDMFlow(input: { gameSessionId: string; trigger: DmFallbackTrigger }): Promise<ExecuteDMFlowCursorNodeResult | null> {
  const gameId = input.gameSessionId;
  await (await import("./modelAvailabilityService")).assertModelAvailable(gameId);
  let lastMessage: Message | null = null;
  let handled = false;
  for (let iteration = 0; iteration < 200; iteration++) {
    const session = await getGameSession(gameId);
    if (!session.runtimeDefinitionId || getRuntimeMode(session) !== "runtime_auto" || session.dmFlowCursor?.lifecycle?.recoveryNeedsAttention) return null;
    const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
    const flow = view.definition.dmFlow?.actFlows.find(f => f.actIndex === session.dmFlowCursor?.actIndex);
    const position = flow?.nodes.findIndex(n => n.nodeId === session.dmFlowCursor?.nodeId) ?? -1;
    const node = flow?.nodes[position];
    if (session.dmFlowCursor?.textPresentation && !session.dmFlowCursor.textPresentation.confirmed) { handled = true; break; }
    if (node?.type === "reading_start") return null;
    if (!node || !node.textExecution && !node.discussionExit && !node.choice && !node.choiceRecap && !node.choiceEnding && !node.matchingReveal && !node.clueAction && !node.knowledgeRelease) {
      // Transition is still owned by the existing legal-transition service.
      if (handled && node?.type === "transition") {
        await (await import("./dmLifecycleService")).advanceRuntimeTransition(gameId);
        const fresh = await getGameSession(gameId);
        return { handled: true, trigger: input.trigger, nodeKey: fresh.dmFlowCursor?.nodeId ?? "reading",
          source: "script_fixed", dmOutput: lastMessage?.content ?? "", message: lastMessage, nextAction: "wait_for_user", cursor: fresh.dmFlowCursor ?? null };
      }
      break;
    }
    // Entry/reading events must not accidentally close a newly opened discussion.
    if (input.trigger !== "discussion_turn_limit_reached") {
      // Only the existing initial discussion instruction uses the legacy path.
      // Other events cannot bypass an authored exit/wait or realize text nodes.
      handled = Boolean(node.textExecution || node.choice || node.choiceRecap || node.choiceEnding || node.matchingReveal || node.clueAction || node.knowledgeRelease || input.trigger !== "enter_free_discussion");
      break;
    }
    handled = true;
    const scope = session.runtimeScope as { actRange: { start: number; end: number }; roleNames: string[] };
    const errors = validateDMLifecycle(view.definition, scope).filter(i => i.fatal);
    if (errors.length) throw new Error(errors.map(e => e.message).join("；"));
    let cursor = session.dmFlowCursor!;
    let messages = await listMessages(gameId);
    let finished = false;
    let content: string | null = null;
    let condition: NonNullable<DMFlowCursor["conditionObservations"]>[string] | undefined;
    let closeReason: "response_received" | "timeout" | "ai_response_skipped" | undefined;
    let discussionReason: string | undefined;
    let revealReceipt: ReturnType<typeof matchingReceipt>;
    let deliveredEnd = 0;
    let deliveredAll = false;
    const emitted = messages.find(m => m.speaker_type === "dm" && m.metadata.sourceNodeId === node.nodeId &&
      m.metadata.runtimeDefinitionId === view.id && m.metadata.act_id === session.currentActId && !m.metadata.conditionalRuleId);

    if (node.knowledgeRelease) {
      // The receipt and node completion are committed together below under the
      // existing lease/CAS. No message or public-memory fact is manufactured.
      finished = true;
    } else if (node.clueAction) {
      await (await import("./runtimeClueService")).executeRuntimeClueNode(gameId, {
        definitionId: view.id, definitionVersion: view.version, actId: session.currentActId, nodeId: node.nodeId
      });
      finished = true;
    } else if (node.discussionExit) {
      if (session.currentPhase !== "free_discussion" || !emitted) break;
      const { runDiscussionParticipation, getDiscussionParticipation } = await import("@/src/lib/orchestration/discussionOrchestrator");
      const organized = await runDiscussionParticipation(gameId, emitted.message_id);
      if (organized?.interrupted) break;
      const checkpoint = await conversationCheckpoint(gameId);
      if (checkpoint.changed) {
        if (checkpoint.seedMessageId) await deferConversationSeed(gameId, checkpoint.seedMessageId);
        break;
      }
      const participation = await getDiscussionParticipation(gameId);
      const readiness = await getDiscussionReadiness(gameId);
      if (readiness && !readiness.canGuide) break;
      const monitored = await monitorPublicDiscussion(gameId);
      if (!monitored && publicPointRules(node).length) break;
      if (monitored?.message) lastMessage = monitored.message;
      cursor = (await getGameSession(gameId)).dmFlowCursor!;
      messages = await listMessages(gameId);
      const progress = discussionProgress(node, cursor, messages, emitted, session.currentActId, participation, readiness);
      finished = progress.finished; discussionReason = progress.reason;
      if (!finished) break;
    } else if (node.choice) {
      if (!["free_discussion", "dm_question"].includes(session.currentPhase)) break;
      if (!cursor.consumedNodeIds.includes(node.nodeId)) {
        content = node.choice.prompt; deliveredAll = true;
        if (node.choice.type === "group_matching") {
          const hint = await (await import("./groupMatchingKeyService")).authorizedMatchingHint(view.id, node.choice.choiceId, node.choice.round);
          content += `\n参与角色：${node.targetRoleNames.join("、")}。\n候选词条：${node.choice.options.map(o => o.label).join("；")}。`;
          const choice = node.choice;
          const previous = cursor.groupMatchingReceipts?.find(r => r.choiceId === choice.choiceId && r.round === choice.round - 1 &&
            r.definitionId === view.id && r.definitionVersion === view.version);
          if (previous) content += `\n上一轮团队分配（不代表正确关系）：${previous.assignments.map(a =>
            `${a.roleId}：${choice.options.find(o => o.optionId === a.optionId)!.label}`).join("；")}。${previous.resultStatus === "pending" ? "上一轮结果尚未公布。" : `上一轮答对${previous.correctCount}人。`}`;
          if (hint) content += `\n本轮提示：${hint}`;
          if (node.choice.inviteRoleNames.length) content += `\n${node.choice.inviteRoleNames.join("、")}，请先谈谈自己的依据。大家可以继续讨论，最终由真人代表提交完整分配。`;
        }
      } else if (choiceComplete(cursor, node, session)) finished = true;
      else break;
    } else if (node.matchingReveal) {
      if (!["free_discussion", "dm_question"].includes(session.currentPhase)) break;
      const nodes = view.definition.dmFlow!.actFlows.flatMap(f => f.nodes);
      // A timeout is not an answer. Late public replies may satisfy this same
      // durable question; no new question or fabricated response is needed.
      const { receipt, ready } = matchingPublicationState(node, nodes, cursor, messages, session.currentActId, view.id);
      if (!ready || !receipt) break;
      if (!cursor.consumedNodeIds.includes(node.nodeId)) {
        if (receipt.resultStatus !== "pending") throw new Error("匹配结果公布回执与节点状态不一致。");
        revealReceipt = receipt;
        content = `第${receipt.round}轮：本轮答对${receipt.correctCount}人。`;
        deliveredEnd = content.length; deliveredAll = true;
      } else finished = true;
    } else if (node.choiceEnding) {
      if (!["free_discussion", "dm_question"].includes(session.currentPhase)) break;
      const nodes = view.definition.dmFlow!.actFlows.flatMap(f => f.nodes);
      const prior = earlierChoiceNode(nodes, node, node.choiceEnding)!;
      // Completion is required before applying either outcome. Never turn an
      // unknown/missing/failed vote into a default retained ending.
      if (!choiceComplete(cursor, prior, session) || nodes.slice(0, nodes.indexOf(node)).some(n =>
        !cursor.completedNodeIds.includes(n.nodeId))) break;
      const unanimous = choiceRoleIds(prior, session).every(roleId => choiceReceipts(cursor, prior)
        .some(r => r.roleId === roleId && r.optionId === node.choiceEnding!.unanimousOptionId));
      if (!cursor.consumedNodeIds.includes(node.nodeId)) {
        const full = (unanimous ? node.choiceEnding.unanimous : node.choiceEnding.otherwise).text;
        const offset = cursor.textPresentation?.nodeId === node.nodeId ? cursor.textPresentation.offset : 0;
        content = nextTextUnit(full, offset); deliveredEnd = offset + content.length; deliveredAll = deliveredEnd >= full.length;
      } else finished = true;
    } else if (node.choiceRecap) {
      if (!["free_discussion", "dm_question"].includes(session.currentPhase)) break;
      const prior = earlierChoiceNode(view.definition.dmFlow!.actFlows.flatMap(f => f.nodes), node, node.choiceRecap)!;
      if (!cursor.completedNodeIds.includes(prior.nodeId) || !choiceComplete(cursor, prior, session)) break;
      if (!cursor.consumedNodeIds.includes(node.nodeId)) {
        const group = matchingReceipt(cursor, prior);
        const receipts = group?.assignments ?? choiceReceipts(cursor, prior);
        const roles = group ? prior.targetRoleNames : choiceRoleIds(prior, session);
        const full = [node.choiceRecap.title, ...roles.map(roleId =>
          `${roleId}：${prior.choice!.options.find(o => o.optionId === receipts.find(r => r.roleId === roleId)!.optionId)!.label}`),
          ...(group ? [group.resultStatus === "pending" ? "本轮分配已保存，结果尚未公布。" : `第${group.round}轮答对${group.correctCount}人；这是团队提交记录，不是逐人判定。`] : [])].join("\n");
        const offset = cursor.textPresentation?.nodeId === node.nodeId ? cursor.textPresentation.offset : 0;
        content = nextTextUnit(full, offset); deliveredEnd = offset + content.length; deliveredAll = deliveredEnd >= full.length;
      } else finished = true;
    } else {
      if (session.currentPhase !== "free_discussion" && session.currentPhase !== "dm_question") break;
      if (node.whenChoice && !cursor.consumedNodeIds.includes(node.nodeId)) {
        const prior = earlierChoiceNode(view.definition.dmFlow!.actFlows.flatMap(f => f.nodes), node, node.whenChoice)!;
        if (!cursor.completedNodeIds.includes(prior.nodeId) || !choiceComplete(cursor, prior, session)) break;
        finished = !choiceEquals(cursor, node, prior, session);
      }
      if (node.textExecution!.when && !cursor.consumedNodeIds.includes(node.nodeId)) {
        const when = node.textExecution!.when;
        const question = messages.find(m => m.speaker_type === "dm" && m.metadata.sourceNodeId === when.questionNodeId && m.metadata.act_id === session.currentActId);
        const candidates = question ? messages.filter(m => publicResponse(m, session.currentActId) && messageTime(m) > messageTime(question)) : [];
        condition = await observeDMCondition(when.predicate, candidates, { gameSessionId: gameId, definitionId: view.id, definitionVersion: view.version,
          nodeId: node.nodeId, actId: session.currentActId, phase: session.currentPhase, questionMessageId: question?.message_id,
          questionNodeId: when.questionNodeId, targetRoleNames: when.roleName ? [when.roleName] : [], completionRequirement: when.completionRequirement,
          conditions: flow!.nodes.filter(n => n.textExecution?.when?.questionNodeId === when.questionNodeId)
            .map(n => ({ nodeId: n.nodeId, ...n.textExecution!.when! })) });
        // The observer's unknown fallback must not turn a service outage into a
        // completed/skipped story condition. Retry this node after explicit resume.
        await (await import("./modelAvailabilityService")).assertModelAvailable(gameId);
        if (condition.verdict === null && condition.expiresAt && Date.parse(condition.expiresAt) > Date.now()) {
          const recovery = await prisma.agentRun.findFirst({ where: { gameSessionId: gameId, agentType: "model_availability" }, orderBy: { startedAt: "desc" } });
          if (recovery?.status === "success" && condition.observedAt && Date.parse(condition.observedAt) <= recovery.startedAt.getTime()) {
            // Keep the Observer's existing failure cache intact. Its pre-resume
            // unknown result must not consume a story branch after recovery.
            await prisma.$transaction(async tx => {
              await assertDMTransactionFence(tx, gameId);
              const changed = await tx.gameSession.updateMany({ where: { id: gameId, dmFlowCursorJson: JSON.stringify(cursor) },
                data: { dmFlowCursorJson: JSON.stringify({ ...cursor, conditionObservations: { ...cursor.conditionObservations, [node.nodeId]: condition } }) } });
              if (!changed.count) throw new Error("观察等待状态已变化，请刷新。");
            });
            handled = true; break;
          }
        }
        finished = condition.verdict !== true; // Unknown is preserved, never treated as true.
      }
      if (!finished && !cursor.consumedNodeIds.includes(node.nodeId)) {
        const offset = cursor.textPresentation?.nodeId === node.nodeId ? cursor.textPresentation.offset : 0;
        const full = node.textExecution!.fidelity === "fixed" ? node.fixedLine! : await localPlaytestDMSpeech(gameId, session.currentActId, session.currentPhase, node);
        content = node.textExecution!.fidelity === "fixed" ? nextTextUnit(full, offset) : full;
        deliveredEnd = offset + content.length;
        deliveredAll = deliveredEnd >= full.length;
        finished = false;
      } else if (!finished && node.textExecution!.wait) {
        const pending = cursor.pendingDMQuestion;
        if (!emitted || pending?.nodeId !== node.nodeId || !pending.textInteraction) throw new Error("Text interaction lost its durable question receipt");
        const expected = node.expectedSpeakerRoleNames.length ? node.expectedSpeakerRoleNames : pending.targetRoleNames;
        const replies = messages.filter(m => publicResponse(m, session.currentActId) && messageTime(m) > messageTime(emitted) &&
          (!expected.length || expected.includes(m.speaker_role_id ?? "")));
        const answered = replies.length >= node.textExecution!.wait.maxResponses;
        const expired = Date.now() >= Date.parse(pending.askedAt) + node.textExecution!.wait.maxWaitMs;
        const skipped = skippedResponsesSettleWait(expected, pending, replies);
        finished = answered || expired || skipped;
        if (finished) closeReason = answered ? "response_received" : skipped ? "ai_response_skipped" : "timeout";
        else break;
      } else if (cursor.consumedNodeIds.includes(node.nodeId)) finished = true;
    }

    // Yield to queued human input before committing any new stage. A later tick
    // reevaluates using the new public messages and the current lease revision.
    await (await import("./modelAvailabilityService")).assertModelAvailable(gameId);
    if ((await conversationCheckpoint(gameId)).changed) break;
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    // The observer updated the same cursor under this lease; refresh its CAS base.
    cursor = (await getGameSession(gameId)).dmFlowCursor!;
    const messageId = content ? randomUUID() : null;
    let next: DMFlowCursor = { ...cursor };
    if (node.knowledgeRelease && finished && !next.knowledgeReleaseReceipts?.some(r => r.nodeId === node.nodeId && r.definitionId === view.id))
      next.knowledgeReleaseReceipts = [...(next.knowledgeReleaseReceipts ?? []), { definitionId: view.id, definitionVersion: view.version,
        nodeId: node.nodeId, actId: session.currentActId, releasedAt: new Date().toISOString() }];
    if (condition) next.conditionObservations = { ...next.conditionObservations, [node.nodeId]: condition };
    if (content) {
      if (revealReceipt) next.groupMatchingReceipts = cursor.groupMatchingReceipts!.map(r => r.requestId === revealReceipt!.requestId ? {
        ...r, resultStatus: "published", publishedAt: new Date().toISOString(), publicationNodeId: node.nodeId
      } : r);
      if (deliveredAll) next.consumedNodeIds = [...new Set([...next.consumedNodeIds, node.nodeId])];
      next.lastExecutedNodeId = node.nodeId;
      if (!node.choice) next.textPresentation = { nodeId: node.nodeId, token: randomUUID(), kind: "continue", offset: deliveredEnd, confirmed: false };
      if (node.textExecution?.wait && deliveredAll) next.pendingDMQuestion = { messageId: messageId!, nodeId: node.nodeId, actIndex: cursor.actIndex,
        textInteraction: true, questionText: content, targetRoleNames: node.expectedSpeakerRoleNames.length ? node.expectedSpeakerRoleNames : node.targetRoleNames, expectedTopics: [],
        askedAt: new Date().toISOString(), answeredByRoleNames: [], cueCount: 0, status: "waiting" };
    }
    if (closeReason && next.pendingDMQuestion?.nodeId === node.nodeId) next.pendingDMQuestion = {
      ...next.pendingDMQuestion, status: "closed", closeReason };
    if (finished) {
      delete next.textPresentation;
      next.completedNodeIds = [...new Set([...next.completedNodeIds, node.nodeId])];
      const following = flow!.nodes[position + 1];
      if (!following) throw new Error("Text flow has no authored next node");
      next = { ...next, nodeId: following.nodeId, nodeIndex: position + 1, waitingFor: following.type === "transition" ? "act_transition" : "none" };
      if (node.discussionExit && (following.textExecution || following.choiceRecap) || following.type === "transition") next.textPresentation = { nodeId: following.nodeId, token: randomUUID(),
        kind: following.type === "transition" ? "transition" : "start", offset: 0, confirmed: false };
    } else next.waitingFor = "user_input";
    if (next.lifecycle) next.lifecycle = { ...next.lifecycle, lastEvaluation: { id: randomUUID(), trigger: input.trigger,
      source: "text_node", evaluatedAt: new Date().toISOString(), result: finished ? "advanced" : "executed",
      reason: closeReason ?? (discussionReason ?? (condition?.verdict !== undefined && condition.verdict !== true ? "conditional_not_confirmed" : "reviewed_text")),
      beforeNode: node.nodeId, afterNode: next.nodeId ?? null, messageId } };
    await prisma.$transaction(async tx => {
      await assertDMTransactionFence(tx, gameId);
      const changed = await tx.gameSession.updateMany({ where: { id: gameId, runtimeDefinitionId: view.id, currentActId: session.currentActId,
        currentPhase: row.currentPhase, dmFlowCursorJson: row.dmFlowCursorJson }, data: { dmFlowCursorJson: toJsonInput(next),
          currentPhase: node.discussionExit ? "dm_question" : row.currentPhase } });
      if (!changed.count) throw new Error("Text DM cursor changed before commit");
      if (messageId && content) {
        const last = messages.at(-1)?.created_at?.getTime() ?? 0;
        await tx.message.create({ data: { id: messageId, gameSessionId: gameId, speakerType: "dm", speakerRoleId: "dm", speakerName: "DM",
          phase: "dm_question", speechAct: node.choice?.type === "group_matching" && node.choice.inviteRoleNames.length ? "dm_directed_question" : node.textExecution?.wait && deliveredAll ? node.targetRoleNames.length || node.expectedSpeakerRoleNames.length ? "dm_directed_question" : "group_question" : "statement",
          targetRoleIds: toJsonInput(node.choice?.type === "group_matching" ? node.choice.inviteRoleNames : node.expectedSpeakerRoleNames.length ? node.expectedSpeakerRoleNames : node.targetRoleNames), content, createdAt: new Date(Math.max(Date.now(), last + 1)),
          metadata: toJsonInput({ act_id: session.currentActId, runtimeDefinitionId: view.id, runtimeDefinitionVersion: view.version,
            sourceNodeId: node.nodeId, sourceNodeType: node.type, groupMatchingResult: Boolean(node.matchingReveal),
            choiceId: node.matchingReveal?.choiceId, round: node.matchingReveal?.round, groupMatchingDiscussion: node.choice?.type === "group_matching" && node.choice.inviteRoleNames.length > 0,
            sourceMode: node.matchingReveal || node.choice || node.choiceRecap || node.choiceEnding || node.textExecution?.fidelity === "fixed" ? "script_fixed" : "script_guided",
            source: node.matchingReveal || node.choice || node.choiceRecap || node.choiceEnding || node.textExecution?.fidelity === "fixed" ? "script_fixed" : "script_guided", storyBoardEligible: false,
            lifecycleKey: `${view.id}:${view.version}:${node.nodeId}`, textUnitEnd: node.choice?.type === "group_matching" ? undefined : deliveredEnd, textInteraction: Boolean(node.textExecution?.wait && deliveredAll),
            revealed_facts: [], emotional_points: [], questions_raised: node.textExecution?.wait && deliveredAll ? [content] : [],
            mentioned_role_ids: node.targetRoleNames, event_tags: [], topic_tags: [] }) } });
      }
    });
    if (messageId) lastMessage = await getMessage(messageId);
    if (finished && flow!.nodes[position + 1]?.type === "free_discussion") {
      await (await import("./dmLifecycleService")).runDMLifecycle({ gameSessionId: gameId, trigger: "enter_free_discussion" });
      break;
    }
    if (!finished || next.textPresentation && !next.textPresentation.confirmed) break;
  }
  if (!handled) return null;
  const fresh = await getGameSession(gameId);
  return { handled: true, trigger: input.trigger, nodeKey: fresh.dmFlowCursor?.nodeId ?? "text_flow",
    source: lastMessage?.metadata.sourceMode === "script_guided" ? "script_guided" : "script_fixed",
    dmOutput: lastMessage?.content ?? "", message: lastMessage, cursor: fresh.dmFlowCursor ?? null, nextAction: "wait_for_user" };
}

const scheduled = new Map<string, { key: string; timer: ReturnType<typeof setTimeout> }>();

export async function confirmDMText(gameId: string, token: string) {
  await (await import("./modelAvailabilityService")).assertModelAvailable(gameId);
  const result = await withConversation(gameId, "", async () => {
    const session = await getGameSession(gameId), cursor = session.dmFlowCursor, gate = cursor?.textPresentation;
    if (!gate || gate.token !== token || gate.confirmed) return { applied: false };
    if (gate.nodeId !== cursor?.nodeId) throw new Error("演绎确认位置已变化，请刷新后继续。");
    const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId!);
    const node = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === gate.nodeId) ?? null;
    const readiness = gate.kind === "start" ? await getDiscussionReadiness(gameId) : null;
    if (readiness && !readiness.ready) throw new Error("自由讨论尚未收束：请先完成保底分享和待回应的提问，留出继续核对的时间。");
    const scope = session.runtimeScope as import("./runtimeDefinitionSessionService").RuntimeSessionScope | null;
    if (gate.kind === "transition" && node?.continuationRequired && (scope?.actRange.end ?? 0) <= cursor!.actIndex)
      throw new (await import("./runtimeInputPolicy")).RuntimeInputPolicyError("后续尾声尚未就绪，当前进度已保留；不能将测试范围结束当作整局完成。");
    if (!textConfirmationReady(cursor!, node, await listMessages(gameId), session.currentActId)) throw new Error("请先等待对应玩家回应，或等待该问题的原定期限。");
    if ((await conversationCheckpoint(gameId)).changed) return { applied: false };
    await prisma.$transaction(async tx => {
      await assertDMTransactionFence(tx, gameId);
      const changed = await tx.gameSession.updateMany({ where: { id: gameId, currentActId: session.currentActId,
        dmFlowCursorJson: JSON.stringify(cursor) }, data: { dmFlowCursorJson: toJsonInput({ ...cursor!, textPresentation: { ...gate, confirmed: true } }) } });
      if (!changed.count) throw new Error("演绎状态已变化，请刷新后继续。");
    });
    try {
      if (gate.kind === "transition") await (await import("./dmLifecycleService")).advanceRuntimeTransition(gameId);
      else {
        const next = await (await import("./dmLifecycleService")).runDMLifecycle({ gameSessionId: gameId, trigger: "discussion_turn_limit_reached" });
        const pending = next.cursor?.pendingDMQuestion;
        if (next.message && pending?.status === "waiting" && pending.messageId === next.message.message_id)
          await (await import("@/src/lib/orchestration/autoDiscussionRunner")).runAutoDiscussionAfterMessage({ gameId, seedMessageId: next.message.message_id });
      }
    } catch (error) {
      // The confirmation already committed. Pending story/AI work remains at its
      // durable cursor; report the outage separately, not as a failed user click.
      if (!await (await import("./modelAvailabilityService")).getModelAvailability(gameId)) throw error;
    }
    return { applied: true };
  }, true);
  if (!result) throw new Error("当前对话仍在处理中，请稍后继续。");
  return result;
}

export async function runScheduledTextDMTick(input: { gameId: string; definitionId: string; actId: string; nodeId: string; trigger: DmFallbackTrigger }) {
  return withConversation(input.gameId, "", async () => {
    const fresh = await getGameSession(input.gameId);
    if (fresh.currentPhase === "finished") return;
    if (fresh.currentActId !== input.actId || fresh.runtimeDefinitionId !== input.definitionId || fresh.dmFlowCursor?.nodeId !== input.nodeId) return;
    const view = await getScriptRuntimeDefinition(input.definitionId);
    const node = view.definition.dmFlow?.actFlows.find(f => f.actIndex === fresh.dmFlowCursor?.actIndex)?.nodes.find(n => n.nodeId === input.nodeId);
    const recovery = await (await import("./discussionQuestionRecovery")).nextResponseRecovery(input.gameId);
    if (recovery) {
      await (await import("./discussionQuestionRecovery")).retryDiscussionQuestion(input.gameId, recovery.messageId, recovery.roleId);
      return;
    }
    if (fresh.dmFlowCursor?.textPresentation && !fresh.dmFlowCursor.textPresentation.confirmed && fresh.dmFlowCursor.textPresentation.kind !== "start") return;
    const discussion = activeDiscussionNode(fresh, view.definition);
    if (discussion) {
      if (fresh.dmFlowCursor?.textPresentation?.kind === "start" && !fresh.dmFlowCursor.textPresentation.confirmed) {
        const invitation = (await listMessages(input.gameId)).find(m => m.speaker_type === "dm" && m.metadata.act_id === fresh.currentActId &&
          m.metadata.sourceNodeId === discussion.nodeId && !m.metadata.conditionalRuleId);
        if (invitation) await (await import("@/src/lib/orchestration/discussionOrchestrator")).runDiscussionParticipation(input.gameId, invitation.message_id);
        return;
      }
    }
    if (node?.type === "transition") await (await import("./dmLifecycleService")).advanceRuntimeTransition(input.gameId);
    else {
      const result = await (await import("./dmLifecycleService")).runDMLifecycle({ gameSessionId: input.gameId, trigger: input.trigger });
      await (await import("./runtimeChoiceService")).runRuntimeAIChoices(input.gameId);
      if (node?.choice?.type === "group_matching") await (await import("./groupMatchingService")).runGroupMatchingDiscussion(input.gameId);
      const question = result.cursor?.pendingDMQuestion;
      if (result.message && question?.status === "waiting" && question.messageId === result.message.message_id) {
        await (await import("@/src/lib/orchestration/autoDiscussionRunner")).runAutoDiscussionAfterMessage({ gameId: input.gameId, seedMessageId: result.message.message_id });
      }
    }
  }, true);
}
// Timers are only wakeups. Durable message receipts/deadlines + lease/CAS are the
// authority. Snapshot/request scheduling restores them after a server restart.
export async function scheduleTextDMTick(gameId: string) {
  if (process.env.NODE_ENV === "test") return;
  if (await (await import("./conversationService")).hasActiveConversation(gameId)) {
    const prior = scheduled.get(gameId); if (prior) clearTimeout(prior.timer); scheduled.delete(gameId); return;
  }
  if ((await import("@/src/lib/llm/localPlaytestGuard")).localPlaytestMode() === "blocked" ||
    await (await import("./modelAvailabilityService")).getModelAvailability(gameId)) {
    const prior = scheduled.get(gameId); if (prior) clearTimeout(prior.timer); scheduled.delete(gameId); return;
  }
  const session = await getGameSession(gameId);
  if (session.currentPhase === "finished") {
    const prior = scheduled.get(gameId); if (prior) clearTimeout(prior.timer); scheduled.delete(gameId); return;
  }
  if (!session.runtimeDefinitionId || getRuntimeMode(session) !== "runtime_auto" || session.dmFlowCursor?.lifecycle?.recoveryNeedsAttention) return;
  const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
  const node = view.definition.dmFlow?.actFlows.flatMap(f => f.nodes).find(n => n.nodeId === session.dmFlowCursor?.nodeId);
  const pending = session.dmFlowCursor?.pendingDMQuestion;
  const messages = await listMessages(gameId);
  const entered = messages.find(m => m.speaker_type === "dm" && m.metadata.sourceNodeId === node?.nodeId && !m.metadata.conditionalRuleId);
  let deadline: number | null = null;
  let trigger: DmFallbackTrigger = "discussion_turn_limit_reached";
  const readiness = await getDiscussionReadiness(gameId);
  const recovery = await (await import("./discussionQuestionRecovery")).nextResponseRecovery(gameId);
  if (recovery) deadline = Date.now();
  else if (session.dmFlowCursor?.textPresentation && !session.dmFlowCursor.textPresentation.confirmed && session.dmFlowCursor.textPresentation.kind !== "start") deadline = null;
  else if (readiness?.pendingQuestions.length) deadline = null;
  else if (session.dmFlowCursor?.textPresentation?.kind === "start" && !session.dmFlowCursor.textPresentation.confirmed) {
    const participation = await (await import("@/src/lib/orchestration/discussionOrchestrator")).getDiscussionParticipation(gameId);
    deadline = participation.pendingRoleIds.length ? Date.now() : readiness && readiness.humanExpressed && !readiness.ready ? readiness.quietUntil : null;
  }
  else if (node?.discussionExit && entered) {
    const participation = await (await import("@/src/lib/orchestration/discussionOrchestrator")).getDiscussionParticipation(gameId);
    deadline = discussionProgress(node, session.dmFlowCursor!, messages, entered, session.currentActId, participation, readiness).deadline;
  }
  else if (node?.choice) {
    const choiceView = await (await import("./runtimeChoiceService")).getRuntimeChoiceView(gameId);
    if (!session.dmFlowCursor!.consumedNodeIds.includes(node.nodeId) ||
      choiceView?.participants.some(p => session.aiRoleIds.includes(p.roleId) && !p.completed && p.attempts < 2) ||
      choiceComplete(session.dmFlowCursor!, node, session) || node.choice.type === "group_matching" &&
        node.choice.inviteRoleNames.some(r => session.aiRoleIds.includes(r)) && !session.dmFlowCursor!.groupMatchingDiscussionNodeIds?.includes(node.nodeId)) deadline = Date.now();
  }
  else if (node?.matchingReveal) {
    // After an unanswered timeout, wait for normal chat/snapshot wakeups rather
    // than creating a permanent immediate-timer polling loop.
    if (matchingPublicationState(node, view.definition.dmFlow!.actFlows.flatMap(f => f.nodes), session.dmFlowCursor!, messages,
      session.currentActId, view.id).ready) deadline = Date.now();
  }
  else if (node?.choiceRecap || node?.choiceEnding || node?.clueAction || node?.knowledgeRelease) deadline = Date.now();
  else if (node?.textExecution) deadline = node.textExecution.wait && pending?.nodeId === node.nodeId ?
    skippedResponsesSettleWait(node.expectedSpeakerRoleNames.length ? node.expectedSpeakerRoleNames : pending.targetRoleNames, pending,
      messages.filter(m => publicResponse(m, session.currentActId) && messageTime(m) > Date.parse(pending.askedAt))) ? Date.now() : Date.parse(pending.askedAt) + node.textExecution.wait.maxWaitMs :
    Math.max(Date.now(), Date.parse(session.dmFlowCursor?.conditionObservations?.[node.nodeId]?.expiresAt ?? "") || 0);
  else if (node?.type === "transition" && messages.some(m => m.metadata.act_id === session.currentActId && m.metadata.sourceNodeType === "performance_instruction")) deadline = Date.now();
  else if (node?.type === "reading_start" && session.dmFlowCursor?.lastAdvanceReason === "legal_act_transition" && !session.dmFlowCursor.consumedNodeIds.includes(node.nodeId)) { deadline = Date.now(); trigger = "enter_reading"; }
  const prior = scheduled.get(gameId);
  if (deadline === null) { if (prior) clearTimeout(prior.timer); scheduled.delete(gameId); return; }
  const key = `${view.id}:${view.version}:${session.currentActId}:${node!.nodeId}:${deadline}`;
  if (prior?.key === key) return;
  if (prior) clearTimeout(prior.timer);
  const timer = setTimeout(() => {
    if (scheduled.get(gameId)?.key !== key) return;
    scheduled.delete(gameId);
    void runScheduledTextDMTick({ gameId, definitionId: view.id, actId: session.currentActId, nodeId: node!.nodeId, trigger })
      .catch(() => null).finally(() => { void scheduleTextDMTick(gameId).catch(() => null); });
  }, Math.max(250, deadline - Date.now()));
  timer.unref();
  scheduled.set(gameId, { key, timer });
}
