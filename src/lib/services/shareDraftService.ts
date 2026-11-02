import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/src/lib/db/prisma";
import { getServerEnv } from "@/src/lib/env/serverEnv";
import { withLlmPriority } from "@/src/lib/llm/concurrencyBudget";
import { providerReasoningOptions } from "@/src/lib/llm/providerReasoning";
import { runInTraceContext } from "@/src/lib/observability/traceContext";
import { buildAiPlayerPublicSharePrompt } from "@/src/lib/prompts/aiPlayerPublicSharePrompt";
import { buildShareCheckerPrompt } from "@/src/lib/prompts/shareCheckerPrompt";
import { createAgentRun, completeAgentRun, failAgentRun, listAgentRunsByTraceId } from "@/src/lib/services/agentRunService";
import { buildAiPlayerContext, getGameSession } from "@/src/lib/services/gameService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import { ShareCheckerSchema } from "@/src/lib/schemas/shareCheckerSchema";
import type { preparePublicShare } from "@/src/lib/services/shareController";

type Prepared = Awaited<ReturnType<typeof preparePublicShare>>;
const jobs = new Map<string, Promise<void>>();
const drains = new Map<string, Promise<void>>();
const scheduled = new Set<string>();
const LEASE_MS = 10 * 60_000;
let draftWorkers = 0;
const workerWaiters: Array<{ id: string; priority: number; resolve: () => void }> = [];
const jobPriorities = new Map<string, number>();

export function shareDraftsEnabled() { return process.env.SHARE_DRAFT_ENABLED === "true"; }

export async function shareFingerprint(gameId: string, roleId: string) {
  const [session, context, script] = await Promise.all([
    getGameSession(gameId), buildAiPlayerContext(gameId, roleId), getScriptForGameSession(gameId)
  ]);
  const role = script.roles.find((r) => r.role_id === roleId);
  const memory = context.roleMemory;
  const fingerprint = createHash("sha256").update(stableJson({
    version: "share-draft-v1", generationPrompt: buildAiPlayerPublicSharePrompt.toString(),
    checkerPrompt: buildShareCheckerPrompt.toString(), model: getServerEnv().openaiModel,
    reasoning: providerReasoningOptions(getServerEnv().openaiModel, {}),
    gameId, actId: context.act_id, role, privateText: context.private_text,
    mustShare: context.must_share, mayShare: context.may_share, mustNotShare: context.must_not_share,
    sharePlan: memory.share_plan, intentions: memory.share_intentions,
    privateMemory: memory.private_memory_so_far, beliefs: memory.beliefs,
    emotionalState: memory.emotional_state, unresolvedQuestions: memory.unresolved_questions
  })).digest("hex");
  const booklet = script.acts.find((a) => a.act_id === context.act_id)!.booklets.find((b) => b.role_id === roleId)!;
  return { session, context, fingerprint, booklet, script };
}

export async function ensureShareDrafts(gameId: string): Promise<void> {
  if ((await (await import("@/src/lib/services/conversationPolicyService")).getActConversationPolicy(gameId))?.mode === "free_discussion_after_reading") return;
  const session = await getGameSession(gameId);
  await prisma.shareDraft.updateMany({
    where: { gameSessionId: gameId, actId: { not: session.currentActId }, status: { notIn: ["consumed", "stale"] } },
    data: { status: "stale", leaseToken: null, errorMessage: "act_changed" }
  });
  if (!["reading", "ai_internal_reading", "share_round"].includes(session.currentPhase)) return;
  for (const roleId of session.aiRoleIds) {
    const { context, fingerprint } = await shareFingerprint(gameId, roleId);
    if (context.roleMemory.internal_readings?.[context.act_id]?.status !== "completed") continue;
    const key = { gameSessionId: gameId, actId: context.act_id, roleId };
    const row = await prisma.shareDraft.upsert({
      where: { gameSessionId_actId_roleId: key }, create: { ...key, fingerprint }, update: {}
    });
    if (row.status === "consumed") continue;
    if (row.fingerprint !== fingerprint) {
      await prisma.shareDraft.updateMany({ where: { id: row.id, fingerprint: row.fingerprint, status: { not: "consumed" } },
        data: { fingerprint, status: "pending", leaseToken: null, generatedContent: null,
          metadataJson: null, checkerJson: null, preparationJson: null,
          errorMessage: "stale_fingerprint_replaced", attemptCount: 0, checkedAt: null,
          generationStartedAt: null, generationCompletedAt: null } });
    } else if (["generating", "checking"].includes(row.status) && row.generationStartedAt &&
      Date.now() - row.generationStartedAt.getTime() > LEASE_MS) {
      await prisma.shareDraft.updateMany({ where: { id: row.id, status: row.status, leaseToken: row.leaseToken },
        data: { status: "failed", leaseToken: null, errorMessage: "expired_lease" } });
    }
  }
}

export function scheduleShareDraftDrain(gameId: string): void {
  if (!shareDraftsEnabled() || scheduled.has(gameId) || process.env.NODE_ENV === "test") return;
  scheduled.add(gameId);
  setTimeout(() => {
    scheduled.delete(gameId);
    void ensureShareDrafts(gameId).then(() => drainShareDrafts(gameId)).catch((error) =>
      console.error("ShareDraft drain failed", error));
  }, 0);
}

export async function drainShareDrafts(gameId: string): Promise<void> {
  if (await (await import("./modelAvailabilityService")).getModelAvailability(gameId)) return;
  const existing = drains.get(gameId);
  if (existing) return existing;
  const operation = runDrain(gameId).finally(() => drains.delete(gameId));
  drains.set(gameId, operation);
  return operation;
}

async function runDrain(gameId: string) {
  const current = await getGameSession(gameId);
  if (!current.aiRoleIds.length) return;
  const { session, script } = await shareFingerprint(gameId, current.aiRoleIds[0]);
  const order = script.acts.find((a) => a.act_id === session.currentActId)!.share_order;
  while (true) {
    if (await (await import("./modelAvailabilityService")).getModelAvailability(gameId)) return;
    const pending = await prisma.shareDraft.findMany({
      where: { gameSessionId: gameId, actId: session.currentActId, status: "pending" }
    });
    if (!pending.length) return;
    pending.sort((a, b) => order.indexOf(a.roleId) - order.indexOf(b.roleId));
    let index = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (index < pending.length) await generateDraft(pending[index++].id);
    }));
  }
}

async function generateDraft(id: string, priority = 2): Promise<void> {
  jobPriorities.set(id, Math.min(jobPriorities.get(id) ?? priority, priority));
  const queued = workerWaiters.find((item) => item.id === id);
  if (queued) { queued.priority = jobPriorities.get(id)!; workerWaiters.sort((a, b) => a.priority - b.priority); }
  const existing = jobs.get(id);
  if (existing) return existing;
  const operation = withDraftWorker(id, priority, () => executeDraft(id)).finally(() => {
    jobs.delete(id); jobPriorities.delete(id);
  });
  jobs.set(id, operation);
  return operation;
}

async function withDraftWorker(id: string, priority: number, operation: () => Promise<void>) {
  await new Promise<void>((resolve) => {
    workerWaiters.push({ id, priority, resolve });
    workerWaiters.sort((a, b) => a.priority - b.priority);
    pumpWorkers();
  });
  try { await operation(); }
  finally { draftWorkers -= 1; pumpWorkers(); }
}
function pumpWorkers() {
  while (draftWorkers < 2 && workerWaiters.length) { draftWorkers += 1; workerWaiters.shift()!.resolve(); }
}

async function executeDraft(id: string): Promise<void> {
  const row = await prisma.shareDraft.findUniqueOrThrow({ where: { id } });
  if (row.status !== "pending") return;
  const leaseToken = randomUUID();
  const started = Date.now();
  const claimed = await prisma.shareDraft.updateMany({
    where: { id, status: "pending", fingerprint: row.fingerprint },
    data: { status: "generating", leaseToken, generationStartedAt: new Date(), attemptCount: { increment: 1 } }
  });
  if (claimed.count !== 1) return;
  const lease = { id, fingerprint: row.fingerprint, leaseToken };
  let runId: string | null = null;
  try {
    const run = await createAgentRun({ gameSessionId: row.gameSessionId, roleId: row.roleId,
      actId: row.actId, phase: "share_round", agentType: "share_draft", runKind: "span",
      inputJson: { fingerprint: row.fingerprint, queueWaitMs: started - row.createdAt.getTime() } });
    runId = run.id;
    const input = await shareFingerprint(row.gameSessionId, row.roleId);
    if (input.fingerprint !== row.fingerprint || input.context.act_id !== row.actId ||
      !["reading", "ai_internal_reading", "share_round"].includes(input.session.currentPhase)) throw new Error("stale_draft");
    await prisma.shareDraft.updateMany({ where: lease, data: { agentRunId: run.id } });
    const { preparePublicShare } = await import("@/src/lib/services/shareController");
    const prepared = await withLlmPriority(jobPriorities.get(id) ?? 2, () => runInTraceContext({ traceId: run.id, parentRunId: run.id }, () =>
      preparePublicShare({ gameSessionId: row.gameSessionId, roleId: row.roleId, booklet: input.booklet,
        preGeneration: true, onStage: async (status) => {
          const changed = await prisma.shareDraft.updateMany({ where: lease,
            data: { status, ...(status === "checking" ? { generationCompletedAt: new Date() } : {}) } });
          if (changed.count !== 1) throw new Error("draft_lease_superseded");
        } })));
    const current = await shareFingerprint(row.gameSessionId, row.roleId);
    if (current.fingerprint !== row.fingerprint || current.context.act_id !== row.actId ||
      !["reading", "ai_internal_reading", "share_round"].includes(current.session.currentPhase)) throw new Error("stale_draft");
    const saved = await prisma.shareDraft.updateMany({ where: lease,
      data: { status: prepared.passed ? "checked" : "failed", leaseToken: null,
        generatedContent: prepared.finalCandidate.content, metadataJson: JSON.stringify(prepared.finalCandidate.metadata),
        checkerJson: JSON.stringify(prepared.finalAttempt.checker.output), preparationJson: JSON.stringify(prepared),
        checkedAt: prepared.passed ? new Date() : null, errorMessage: prepared.passed ? null : "checker_rejected" } });
    await completeAgentRun({ agentRunId: run.id, latencyMs: Date.now() - started,
      outputJson: { passed: prepared.passed, saved: saved.count === 1,
        queueWaitMs: started - row.createdAt.getTime(), generationRunId: prepared.finalAttempt.candidate.agentRunId,
        checkerRunId: prepared.finalAttempt.checker.agentRunId } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const paused = await (await import("./modelAvailabilityService")).getModelAvailability(row.gameSessionId);
    await prisma.shareDraft.updateMany({ where: lease,
      data: { status: message === "stale_draft" ? "stale" : paused ? "pending" : "failed", leaseToken: null, errorMessage: message,
        ...(paused ? { attemptCount: row.attemptCount } : {}) } });
    if (runId) await failAgentRun({ agentRunId: runId, error: "share_draft_failed",
      errorMessage: message, latencyMs: Date.now() - started });
  }
}

export async function obtainShareDraftForTurn(gameId: string, roleId: string, waitMs = 15_000) {
  const started = Date.now();
  const initial = await shareFingerprint(gameId, roleId);
  const key = { gameSessionId: gameId, actId: initial.context.act_id, roleId };
  const before = await prisma.shareDraft.findUnique({ where: { gameSessionId_actId_roleId: key } });
  const statusAtTurn = !before ? "missing" : before.fingerprint !== initial.fingerprint ? "stale" : before.status;
  await ensureShareDrafts(gameId);
  let row = await prisma.shareDraft.findUnique({ where: { gameSessionId_actId_roleId: key } });
  if (!row) return null;
  if (row.status === "consumed") {
    const { ShareTurnConflictError } = await import("@/src/lib/services/shareController");
    throw new ShareTurnConflictError("该角色已经完成本幕分享。");
  }
  // A failed job may retry the unchanged original generation/checker pipeline once.
  if (row.status === "failed" && !row.preparationJson && row.attemptCount < 2) {
    await prisma.shareDraft.updateMany({ where: { id: row.id, status: "failed", attemptCount: row.attemptCount },
      data: { status: "pending", leaseToken: null } });
    row = await prisma.shareDraft.findUniqueOrThrow({ where: { id: row.id } });
  }
  if (row.status === "pending") void generateDraft(row.id, 1).catch(console.error);
  while (["pending", "generating", "checking"].includes(row.status) && Date.now() - started < waitMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    row = await prisma.shareDraft.findUniqueOrThrow({ where: { id: row!.id } });
  }
  const now = await shareFingerprint(gameId, roleId);
  if (row.fingerprint !== now.fingerprint || row.actId !== now.context.act_id) {
    const { ShareTurnConflictError } = await import("@/src/lib/services/shareController");
    throw new ShareTurnConflictError("草稿输入已变化，请刷新重试。");
  }
  const runs = row.agentRunId ? await listAgentRunsByTraceId(row.agentRunId) : [];
  const latency = (type: string) => runs.filter((r) => r.agentType === type && r.runKind === "llm")
    .reduce((total, r) => total + (r.latencyMs ?? 0), 0);
  const claim = { id: row.id, fingerprint: row.fingerprint, status: row.status, leaseToken: row.leaseToken };
  const preparations = await prisma.agentRun.findMany({ where: {
    gameSessionId: gameId, actId: row.actId, roleId, agentType: "share_draft", runKind: "span"
  }, orderBy: { startedAt: "asc" }, select: { input: true, startedAt: true, finishedAt: true } });
  const matching = preparations.filter((run) => {
    try { return JSON.parse(run.input).fingerprint === row!.fingerprint; } catch { return false; }
  });
  const duplicateGeneration = matching.filter((run, index) => matching.slice(0, index).some((earlier) =>
    !earlier.finishedAt || earlier.finishedAt.getTime() > run.startedAt.getTime())).length;
  const metrics = { draftId: row.id, statusAtTurn, readyAtTurn: statusAtTurn === "checked",
    draftHit: row.status === "checked", waitAtTurnMs: Date.now() - started,
    fallbackUsed: row.status !== "checked", duplicateGeneration, preparationAttempts: row.attemptCount,
    queueWaitMs: row.generationStartedAt ? row.generationStartedAt.getTime() - row.createdAt.getTime() : null,
    generationLatencyMs: latency("ai_player_public_share"), checkerLatencyMs: latency("share_checker"),
    agentRunId: row.agentRunId };
  if ((row.status === "checked" || row.status === "failed") && row.preparationJson) {
    const prepared = JSON.parse(row.preparationJson) as Prepared;
    const checker = ShareCheckerSchema.parse(prepared.finalAttempt.checker.output);
    if (row.status === "checked" && (!checker.passed || !checker.safe_to_publish)) throw new Error("invalid_checked_draft");
    return { prepared, claim, metrics };
  }
  // Fence any in-flight worker in the same transaction that commits this safe result.
  const checker = ShareCheckerSchema.parse({ passed: false, safe_to_publish: false,
    reasons: ["share_draft_not_ready"], violations: [], covered_must_share: false,
    decision: "block", rewrite_advice: null, missing_must_share: [], quality_issues: [], leakage_issues: [] });
  const { createFallbackPublicShare } = await import("@/src/lib/services/shareController");
  const finalCandidate = createFallbackPublicShare(now.booklet, checker);
  const prepared: Prepared = { passed: false, finalCandidate, finalAttempt: { attempt: 1,
    candidate: { roleId, agentRunId: "", output: { ...finalCandidate,
      metadata: { revealed_facts: now.context.must_share, emotional_points: [], questions_raised: [],
        mentioned_role_ids: [], event_tags: [], topic_tags: [] },
      self_check: { covered_must_share: true, avoided_must_not_share: true, used_only_allowed_context: true } } },
    checker: { roleId, agentRunId: "", output: checker } } };
  return { prepared, claim, metrics };
}

export async function listShareDraftStatus(gameId: string) {
  return prisma.shareDraft.findMany({ where: { gameSessionId: gameId },
    select: { id: true, actId: true, roleId: true, status: true, generationStartedAt: true,
      generationCompletedAt: true, checkedAt: true, consumedAt: true, attemptCount: true, errorMessage: true } });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
