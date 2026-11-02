import "server-only";
import { randomUUID } from "node:crypto";
import type { DMFlowNode } from "@/src/lib/schemas/dmFlowSchema";
import type { Message, DMFlowCursor, PendingDMQuestionEvaluation } from "@/src/lib/types/game";
import { prisma } from "@/src/lib/db/prisma";
import { getGameSession } from "./gameService";
import { getScriptRuntimeDefinition } from "./scriptRuntimeDefinitionService";
import { getMessage, listMessages } from "./messageService";
import { assertDMTransactionFence, withConversation, conversationCheckpoint, conversationStage } from "./conversationService";
import { toJsonInput } from "./jsonFields";
import { getRuntimeMode } from "./runtimeMode";
import { observeSemanticPublicPoints, observeSemanticCondition } from "./dmSemanticObserverService";

// These rules must link to a required point. publicPointClaims are completion
// requirements, not phrases players must repeat verbatim.
// Other legacy conditional rules retain their existing behavior.
export function publicPointRules(node: DMFlowNode) {
  return node.conditionalRules.filter(r => r.triggerType === "missing_public_point" &&
    r.responseType === "fixed_answer" && r.publicPointClaims !== undefined && node.requiredPublicPoints.includes(r.conditionText));
}

const compact = (s: string) => s.replace(/[\s，。！？、：；,.!?:;“”"'（）()]/g, "");
const uncertain = /不确定|不清楚|不记得|没记起|没想起|不知道|没有|不是|并非|未曾|不认为|不对|说错|收回|否认|不能确认|好像|似乎|可能|也许|大概|猜|假如|如果|听说|是否|梦见|梦到|梦境|梦里|梦中|做.{0,6}梦|引用|原话|[“”「」『』"]|[？?]|吗|呢/;

export function observePublicPoints(node: DMFlowNode, messages: Message[], actId: string): NonNullable<DMFlowCursor["publicPointCoverage"]> {
  const publicMessages = messages.filter(m => m.metadata.act_id === actId &&
    ["share_round", "free_discussion", "dm_question"].includes(m.phase) &&
    (m.speaker_type === "user" || m.speaker_type === "ai_player"));
  return { nodeId: node.nodeId, points: publicPointRules(node).map(rule => {
    const eligible = publicMessages.filter(m => !rule.targetRoleNames.length || rule.targetRoleNames.includes(m.speaker_role_id ?? ""));
    const evidence = new Set<string>();
    const claims = rule.publicPointClaims ?? [];
    const complete = claims.length > 0 && claims.every(claim => compact(claim).length >= 4) && claims.every(claim => {
      // A later contradictory/uncertain mention cannot silently reuse stale proof.
      const mention = eligible.filter(m => compact(m.content).includes(compact(claim))).at(-1);
      if (!mention || uncertain.test(mention.content) || ["question", "challenge"].includes(mention.speech_act)) return false;
      evidence.add(mention.message_id);
      return true;
    });
    return { ruleId: rule.ruleId, status: complete ? "mentioned" as const : eligible.length ? "unknown" as const : "missing" as const,
      evidenceMessageIds: complete ? [...evidence] : [] };
  }) };
}

// The runtime consumes evidence-bearing observations, not matching algorithms.
// The literal observer remains an explicit regression fixture adapter. The
// production semantic adapter judges ONLY supplied public messages and fails to
// unknown; it never authorizes a reveal or reads private booklets.
export type PublicObservationContext = {
  gameSessionId: string; definitionId: string; definitionVersion: number; nodeId: string; actId: string; phase: string;
  targetRoleNames?: string[]; completionRequirement?: string; questionMessageId?: string; questionNodeId?: string;
  conditions?: Array<{ nodeId: string; predicate: string; completionRequirement?: string; roleName: string | null }>;
};
export type PublicDMObserver = {
  points: (node: DMFlowNode, messages: Message[], actId: string, context?: PublicObservationContext) => ReturnType<typeof observePublicPoints> | Promise<ReturnType<typeof observePublicPoints>>;
  condition: (predicate: string, messages: Message[], context?: PublicObservationContext) => Promise<NonNullable<DMFlowCursor["conditionObservations"]>[string]>;
};
const defaultObserver: PublicDMObserver = { points: observeSemanticPublicPoints, condition: observeSemanticCondition };
let testObserver: PublicDMObserver | null = null;
export function setPublicDMObserverForTests(observer: PublicDMObserver | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("Observation injection is test-only");
  testObserver = observer;
}
export async function observeDMCondition(predicate: string, messages: Message[], context?: PublicObservationContext) {
  try {
    const eligible = context ? messages.filter(m => m.metadata.act_id === context.actId && phasesForEvidence.includes(m.phase) &&
      ["user", "ai_player"].includes(m.speaker_type) && (!context.targetRoleNames?.length || context.targetRoleNames.includes(m.speaker_role_id ?? ""))) : messages;
    const result = await (testObserver ?? defaultObserver).condition(predicate, testObserver ? eligible : messages, context);
    const valid = result.evidenceMessageIds.every(id => eligible.some(m => m.message_id === id));
    return { ...result, verdict: valid && result.evidenceMessageIds.length && [true, false].includes(result.verdict as boolean) ? result.verdict : null,
      evidenceMessageIds: valid ? [...new Set(result.evidenceMessageIds)] : [] };
  } catch { return { verdict: null, evidenceMessageIds: [] }; }
}

const phasesForEvidence = ["share_round", "free_discussion", "dm_question"];

// Observe durable public messages, not private booklets or StoryBoard inference.
export async function monitorPublicDiscussion(gameId: string, latestMessageId = "") {
  return withConversation(gameId, latestMessageId, async () => {
    const session = await getGameSession(gameId);
    if (!session.runtimeDefinitionId || session.currentPhase !== "free_discussion" ||
      getRuntimeMode(session) !== "runtime_auto" || session.dmFlowCursor?.lifecycle?.recoveryNeedsAttention) return null;
    const view = await getScriptRuntimeDefinition(session.runtimeDefinitionId);
    const node = view.definition.dmFlow?.actFlows.find(f => f.actIndex === session.dmFlowCursor?.actIndex)?.nodes
      .find(n => n.nodeId === session.dmFlowCursor?.nodeId && n.type === "free_discussion");
    if (!node || !publicPointRules(node).length) return null;
    const readiness = await (await import("./discussionReadiness")).getDiscussionReadiness(gameId);
    // Authored cues are a closing aid, after baseline sharing and live questions.
    if (readiness && !readiness.canGuide) return null;
    const row = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    const cursor = session.dmFlowCursor!;
    const messages = await listMessages(gameId);
    const publicMessages = messages.filter(m => m.metadata.act_id === session.currentActId &&
      ["share_round", "free_discussion", "dm_question"].includes(m.phase) && ["user", "ai_player"].includes(m.speaker_type));
    await conversationStage("checking");
    let coverage: ReturnType<typeof observePublicPoints>;
    try {
      coverage = await (testObserver ?? defaultObserver).points(node, publicMessages, session.currentActId, {
        gameSessionId: gameId, definitionId: view.id, definitionVersion: view.version, nodeId: node.nodeId,
        actId: session.currentActId, phase: session.currentPhase });
    } catch { coverage = { nodeId: node.nodeId, points: publicPointRules(node).map(r => ({ ruleId: r.ruleId, status: "unknown", evidenceMessageIds: [] })) }; }
    // A human may have inserted a correction during observation. Yield and use
    // the next conversation turn; do not commit a cue/exit from an obsolete batch.
    if ((await conversationCheckpoint(gameId)).changed) return null;
    const rules = publicPointRules(node);
    if (coverage.nodeId !== node.nodeId || coverage.points.length !== rules.length ||
      new Set(coverage.points.map(p => p.ruleId)).size !== rules.length || coverage.points.some(p => {
        const rule = rules.find(r => r.ruleId === p.ruleId);
        return !rule || p.status === "mentioned" && !p.evidenceMessageIds.length ||
          p.evidenceMessageIds.some(id => !publicMessages.some(m => m.message_id === id &&
            (!rule!.targetRoleNames.length || rule!.targetRoleNames.includes(m.speaker_role_id ?? ""))));
      })) {
      throw new Error("Public observation has no valid in-scope evidence");
    }
    let pending = cursor.pendingDMQuestion;
    const oldPending = pending?.publicPointRuleId;
    if (oldPending && pending?.status !== "closed") {
      pending = { ...pending!, status: coverage.points.find(p => p.ruleId === oldPending)?.status === "mentioned" ? "answered" : "waiting" };
      if (pending.status === "waiting" && node.discussionExit?.onUnconfirmed === "continue" &&
        Date.now() >= Date.parse(pending.askedAt) + node.discussionExit.questionWaitMs) pending = { ...pending, status: "closed", closeReason: "soft_point_timeout" };
    }
    const waiting = pending && (pending.status === "waiting" || pending.status === "partial_answered");
    const rule = waiting ? null : publicPointRules(node).find(r => coverage.points.find(p => p.ruleId === r.ruleId)?.status !== "mentioned" &&
      !cursor.triggeredRuleIds.includes(r.ruleId) && !messages.some(m => m.speaker_type === "dm" &&
        m.metadata.act_id === session.currentActId && m.metadata.sourceNodeId === node.nodeId && m.metadata.conditionalRuleId === r.ruleId));
    const content = rule?.responseText?.trim();
    // Only source-approved cue text. A missing safe cue never falls back to private
    // facts or to LLM-generated instructions. Validation also blocks such definitions.
    const safe = content && content.length <= 240 && ![...node.forbiddenReveals, ...node.requiredPublicPoints, ...(rule!.publicPointClaims ?? []), ...rule!.keywords]
      .some(s => compact(s).length >= 4 && compact(content).includes(compact(s))) &&
      rule!.targetRoleNames.every(r => view.definition.roles.some(role => role.roleName === r));
    const id = safe ? randomUUID() : null;
    const evaluation: PendingDMQuestionEvaluation | null = oldPending ? {
      latestMessageId, answered: pending?.status === "answered", partial: false, answeredTopics: [], missingTopics: [],
      shouldCueAnotherRole: false, shouldAskFollowup: false, shouldAdvanceFlow: false,
      reason: pending?.status === "answered" ? "all_public_claims_observed" : "public_point_still_unconfirmed", evaluatedAt: new Date().toISOString()
    } : null;
    const next: DMFlowCursor = { ...cursor, publicPointCoverage: coverage, pendingDMQuestion: pending,
      ...(evaluation ? { lastPendingQuestionEvaluation: evaluation } : {}) };
    if (id && rule && content) {
      next.triggeredRuleIds = [...new Set([...cursor.triggeredRuleIds, rule.ruleId])];
      next.pendingDMQuestion = { publicPointRuleId: rule.ruleId, nodeId: node.nodeId, messageId: id, actIndex: cursor.actIndex,
        questionText: content, targetRoleNames: rule.targetRoleNames, expectedTopics: [], askedAt: new Date().toISOString(),
        answeredByRoleNames: [], cueCount: 0, status: "waiting" };
    }
    await prisma.$transaction(async tx => {
      await assertDMTransactionFence(tx, gameId);
      const changed = await tx.gameSession.updateMany({ where: { id: gameId, runtimeDefinitionId: view.id,
        currentActId: row.currentActId, currentPhase: "free_discussion", dmFlowCursorJson: row.dmFlowCursorJson },
        data: { dmFlowCursorJson: toJsonInput(next) } });
      if (!changed.count) throw new Error("Public discussion cursor changed before commit");
      if (id && rule && content) {
        const last = messages.at(-1)?.created_at?.getTime() ?? 0;
        await tx.message.create({ data: { id, gameSessionId: gameId, speakerType: "dm", speakerRoleId: "dm", speakerName: "DM",
          phase: "free_discussion", speechAct: rule.targetRoleNames.length ? "dm_directed_question" : "group_question",
          targetRoleIds: toJsonInput(rule.targetRoleNames), content, createdAt: new Date(Math.max(Date.now(), last + 1)),
          metadata: toJsonInput({ act_id: session.currentActId, runtimeDefinitionId: view.id, runtimeDefinitionVersion: view.version,
            sourceNodeId: node.nodeId, conditionalRuleId: rule.ruleId, source: "conditional_rule", sourceMode: "script_fixed",
            storyBoardEligible: false, revealed_facts: [], emotional_points: [], questions_raised: [content], mentioned_role_ids: rule.targetRoleNames,
            event_tags: [], topic_tags: [], next_action: "wait_for_user" }) } });
      }
    });
    return { coverage, evaluation, message: id ? await getMessage(id) : null };
  }, true);
}
