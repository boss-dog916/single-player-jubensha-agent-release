import "server-only";

import { randomUUID } from "node:crypto";
import {
  generateAiPlayerPublicShare,
  type GenerateAiPlayerPublicShareResult
} from "@/src/lib/agents/aiPlayerPublicShare";
import { checkAiPublicShare } from "@/src/lib/agents/shareChecker";
import { prisma } from "@/src/lib/db/prisma";
import { getTraceContext } from "@/src/lib/observability/traceContext";
import type { Act, Booklet, RoleId, Script } from "@/src/lib/script/scriptTypes";
import type { ShareCheckerOutput } from "@/src/lib/schemas/shareCheckerSchema";
import {
  completeAgentRun,
  createAgentRun,
  failAgentRun
} from "@/src/lib/services/agentRunService";
import { getGameSession } from "@/src/lib/services/gameService";
import { toJsonInput } from "@/src/lib/services/jsonFields";
import { getMessageInGame } from "@/src/lib/services/messageService";
import { hasActivePostShareTask } from "@/src/lib/services/postShareTaskService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import type { Message, MessageMetadata } from "@/src/lib/types/game";

type PublicShareMessageDraft = {
  content: string;
  metadata: MessageMetadata;
};

export type HandleAiPublicShareTurnInput = {
  gameSessionId: string;
  mockPublicShareOutput?: unknown;
  mockCheckerOutput?: unknown;
  useShareDraft?: boolean;
  draftWaitMs?: number;
};

export type HandleAiPublicShareTurnResult = {
  message: Message;
  publicShareAgentRunId: string;
  checkerAgentRunId: string;
  postShareTaskId: string;
  sharePersistLatencyMs: number;
  shareVisibleLatencyMs: number;
};

export class ShareTurnConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareTurnConflictError";
  }
}

export async function handleAiPublicShareTurn({
  gameSessionId,
  mockPublicShareOutput,
  mockCheckerOutput,
  useShareDraft = process.env.SHARE_DRAFT_ENABLED === "true",
  draftWaitMs
}: HandleAiPublicShareTurnInput): Promise<HandleAiPublicShareTurnResult> {
  const visibleStartedAt = Date.now();
  const visibleRun = await createAgentRun({
    gameSessionId,
    runKind: "span",
    agentType: "ai_share_visible",
    inputJson: { clickedAt: new Date(visibleStartedAt).toISOString() }
  });

  try {
    const session = await getGameSession(gameSessionId);
    const script = await getScriptForGameSession(gameSessionId);
    const act = findAct(script.acts, session.currentActId);
    const currentShareRoleId = getCurrentShareRoleId(act, session);

    if (session.currentPhase !== "share_round") {
      throw new Error(`AI public_share can only run during share_round phase.`);
    }
    if (await hasActivePostShareTask(gameSessionId)) {
      throw new ShareTurnConflictError("上一位分享后的讨论仍在处理中，请稍候。");
    }
    if (!currentShareRoleId || currentShareRoleId === session.userRoleId) {
      throw new Error("Current share turn does not belong to an AI player.");
    }

    const resolution = useShareDraft && mockPublicShareOutput === undefined && mockCheckerOutput === undefined
      ? await (await import("@/src/lib/services/shareDraftService")).obtainShareDraftForTurn(gameSessionId, currentShareRoleId, draftWaitMs)
      : null;
    const prepared = resolution?.prepared ?? await preparePublicShare({
      gameSessionId,
      roleId: currentShareRoleId,
      mockPublicShareOutput,
      mockCheckerOutput,
      booklet: findBookletInAct(act, currentShareRoleId)
    });
    const { finalAttempt, finalCandidate } = prepared;
    const persistStartedAt = Date.now();
    const committed = await commitShareAndPostTask({
      gameSessionId,
      session,
      act,
      roleId: currentShareRoleId,
      roleName: getRoleName(script, currentShareRoleId),
      shareVisibleRunId: visibleRun.id,
      draft: finalCandidate,
      draftClaim: resolution?.claim ?? null
    });
    const sharePersistLatencyMs = Date.now() - persistStartedAt;
    const shareVisibleLatencyMs = Date.now() - visibleStartedAt;

    await completeAgentRun({
      agentRunId: visibleRun.id,
      outputJson: {
        messageId: committed.message.message_id,
        roleId: currentShareRoleId,
        publicShareAgentRunId: finalAttempt.candidate.agentRunId,
        checkerAgentRunId: finalAttempt.checker.agentRunId,
        postShareTaskId: committed.postShareTaskId,
        sharePersistLatencyMs,
        shareVisibleLatencyMs,
        shareDraft: resolution?.metrics ?? null,
        postShareDiscussionTriggeredAt: committed.triggeredAt
      },
      latencyMs: shareVisibleLatencyMs
    });

    return {
      message: committed.message,
      publicShareAgentRunId: finalAttempt.candidate.agentRunId,
      checkerAgentRunId: finalAttempt.checker.agentRunId,
      postShareTaskId: committed.postShareTaskId,
      sharePersistLatencyMs,
      shareVisibleLatencyMs
    };
  } catch (error) {
    await failAgentRun({
      agentRunId: visibleRun.id,
      error: error instanceof ShareTurnConflictError ? "share_turn_conflict" : "ai_share_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - visibleStartedAt
    });
    throw error;
  }
}

export async function preparePublicShare(input: {
  gameSessionId: string;
  roleId: RoleId;
  booklet: Booklet;
  mockPublicShareOutput?: unknown;
  mockCheckerOutput?: unknown;
  preGeneration?: boolean;
  onStage?: (stage: "generating" | "checking") => Promise<void>;
}) {
  const firstAttempt = await runPublicShareAttempt({ ...input, attempt: 1 });
  const secondAttempt = isCheckerPassed(firstAttempt.checker.output) || !shouldRewritePublicShare(firstAttempt.checker.output)
    ? null : await runPublicShareAttempt({ ...input, attempt: 2,
      repairInstructions: buildPublicShareRepairInstructions(firstAttempt) });
  const finalAttempt = secondAttempt ?? firstAttempt;
  const finalCandidate = isCheckerPassed(finalAttempt.checker.output)
    ? sanitizePublicShareDraft(finalAttempt.candidate.output)
    : createFallbackPublicShare(input.booklet, finalAttempt.checker.output);
  return { finalAttempt, finalCandidate, passed: isCheckerPassed(finalAttempt.checker.output) };
}

async function runPublicShareAttempt(input: {
  gameSessionId: string;
  roleId: RoleId;
  attempt: 1 | 2;
  mockPublicShareOutput?: unknown;
  mockCheckerOutput?: unknown;
  repairInstructions?: unknown;
  preGeneration?: boolean;
  onStage?: (stage: "generating" | "checking") => Promise<void>;
}): Promise<{
  attempt: 1 | 2;
  candidate: GenerateAiPlayerPublicShareResult;
  checker: Awaited<ReturnType<typeof checkAiPublicShare>>;
}> {
  await input.onStage?.("generating");
  const candidate = await generateAiPlayerPublicShare({
    gameSessionId: input.gameSessionId,
    roleId: input.roleId,
    mockOutput: input.mockPublicShareOutput,
    preGeneration: input.preGeneration,
    repairInstructions: input.repairInstructions
      ? {
          attempt: input.attempt,
          ...asRecord(input.repairInstructions)
        }
      : null
  });
  await input.onStage?.("checking");
  const checker = await checkAiPublicShare({
    gameSessionId: input.gameSessionId,
    roleId: input.roleId,
    candidate: candidate.output,
    mockOutput: input.mockCheckerOutput,
    throwOnBlock: false
  });

  return {
    attempt: input.attempt,
    candidate,
    checker
  };
}

function isCheckerPassed(output: ShareCheckerOutput): boolean {
  return output.passed && output.safe_to_publish;
}

function shouldRewritePublicShare(output: ShareCheckerOutput): boolean {
  if (isCheckerPassed(output)) {
    return false;
  }

  const hasRewriteSignal =
    output.decision === "rewrite_required" ||
    Boolean(output.rewrite_advice) ||
    Boolean(output.missing_must_share?.length) ||
    Boolean(output.quality_issues?.length) ||
    !output.covered_must_share;
  const hasSevereLeakage =
    output.safe_to_publish === false ||
    Boolean(output.leakage_issues?.length) ||
    output.violations.some((violation) => violation.includes("leak"));

  return hasRewriteSignal && !hasSevereLeakage;
}

function buildPublicShareRepairInstructions(input: {
  attempt: 1 | 2;
  candidate: GenerateAiPlayerPublicShareResult;
  checker: Awaited<ReturnType<typeof checkAiPublicShare>>;
}) {
  const checker = input.checker.output;

  return {
    previous_attempt: input.attempt,
    previous_candidate: input.candidate.output,
    checker_result: checker,
    rewrite_advice: checker.rewrite_advice ?? null,
    missing_must_share: checker.missing_must_share ?? [],
    quality_issues: checker.quality_issues ?? [],
    leakage_issues: checker.leakage_issues ?? [],
    reasons: checker.reasons,
    violations: checker.violations
  };
}

export function createFallbackPublicShare(
  booklet: Booklet,
  checkerResult: ShareCheckerOutput
): PublicShareMessageDraft {
  const facts = booklet.must_share.filter(Boolean);
  const content =
    facts.length > 0
      ? `我先把我能确认、也适合现在同步给大家的情况说一下：${facts.join("；")}。`
      : "我这一幕暂时没有更多必须公开的信息，但我会继续听大家说。";

  return {
    content: sanitizePublicShareText(content),
    metadata: {
      revealed_facts: facts,
      emotional_points: [],
      questions_raised: [],
      mentioned_role_ids: [],
      event_tags: extractTags(facts),
      topic_tags: extractTags(facts),
      source: "fallback_must_share",
      checkerFailedBeforeFallback: true,
      checkerFailureReasons: checkerResult.reasons,
      checkerFailureViolations: checkerResult.violations
    }
  };
}

function sanitizePublicShareDraft(draft: PublicShareMessageDraft): PublicShareMessageDraft {
  return {
    ...draft,
    content: sanitizePublicShareText(draft.content)
  };
}

export function sanitizePublicShareText(text: string): string {
  return text
    .replace(/^我这一幕必须公开的信息是[:：]\s*/u, "")
    .replace(/^我必须公开的信息是[:：]\s*/u, "")
    .replace(/^我需要公开的信息是[:：]\s*/u, "")
    .replace(/^我需要分享的信息是[:：]\s*/u, "")
    .replace(/^我的\s*mustShare\s*是[:：]\s*/iu, "")
    .replace(/^以下是我需要分享的信息[:：]\s*/u, "")
    .replaceAll("mustShare", "我能确认的情况")
    .trim();
}

async function commitShareAndPostTask(input: {
  gameSessionId: string;
  session: Awaited<ReturnType<typeof getGameSession>>;
  act: Act;
  roleId: RoleId;
  roleName: string;
  shareVisibleRunId: string;
  draft: PublicShareMessageDraft;
  draftClaim: { id: string; fingerprint: string; status: string; leaseToken: string | null } | null;
}): Promise<{
  message: Message;
  postShareTaskId: string;
  triggeredAt: string;
}> {
  const nextShareIndex = getNextShareIndex(
    input.act,
    input.session,
    input.session.currentShareIndex + 1
  );
  const hasMoreShares = nextShareIndex !== -1;
  const committedShareIndex = hasMoreShares ? nextShareIndex : input.act.share_order.length;
  const nextRoleId = hasMoreShares ? input.act.share_order[nextShareIndex] ?? null : null;
  const messageId = randomUUID();
  const taskId = randomUUID();
  const taskRunId = randomUUID();
  const triggeredAt = new Date();
  const trace = getTraceContext();

  await prisma.$transaction(async (tx) => {
    if (input.draftClaim) {
      const claim = await tx.shareDraft.updateMany({
        where: input.draftClaim,
        data: { status: "consumed", consumedAt: new Date(), leaseToken: null }
      });
      if (claim.count !== 1) throw new ShareTurnConflictError("分享草稿已被消费或更新，请刷新重试。");
    }
    const activeTaskCount = await tx.postShareTask.count({
      where: {
        gameSessionId: input.gameSessionId,
        status: { in: ["pending", "running"] }
      }
    });
    if (activeTaskCount > 0) {
      throw new ShareTurnConflictError("上一位分享后的讨论仍在处理中，请稍候。");
    }

    const claimed = await tx.gameSession.updateMany({
      where: {
        id: input.gameSessionId,
        currentActId: input.session.currentActId,
        currentPhase: "share_round",
        currentShareIndex: input.session.currentShareIndex
      },
      data: {
        currentShareIndex: committedShareIndex
      }
    });
    if (claimed.count === 0) {
      throw new ShareTurnConflictError("分享顺序已经变化，请刷新后重试。");
    }

    await tx.message.create({
      data: {
        id: messageId,
        gameSessionId: input.gameSessionId,
        speakerType: "ai_player",
        speakerRoleId: input.roleId,
        speakerName: input.roleName,
        targetRoleIds: toJsonInput([]),
        replyToMessageId: null,
        phase: "share_round",
        speechAct: "share",
        content: input.draft.content,
        metadata: toJsonInput(input.draft.metadata)
      }
    });
    await tx.agentRun.create({
      data: {
        id: taskRunId,
        gameSessionId: input.gameSessionId,
        traceId: trace?.traceId ?? null,
        parentRunId: trace?.parentRunId ?? null,
        runKind: "span",
        agentType: "post_share_discussion",
        roleId: input.roleId,
        actId: input.session.currentActId,
        phase: "share_round",
        input: toJsonInput({
          shareVisibleRunId: input.shareVisibleRunId,
          seedMessageId: messageId,
          sharedRoleId: input.roleId,
          sourceShareIndex: input.session.currentShareIndex,
          committedShareIndex,
          hasMoreShares,
          nextRoleId,
          postShareDiscussionTriggeredAt: triggeredAt.toISOString()
        }),
        status: "pending",
        startedAt: triggeredAt
      }
    });
    await tx.postShareTask.create({
      data: {
        id: taskId,
        gameSessionId: input.gameSessionId,
        seedMessageId: messageId,
        sourceActId: input.session.currentActId,
        sourceShareIndex: input.session.currentShareIndex,
        committedShareIndex,
        sharedRoleId: input.roleId,
        hasMoreShares,
        nextRoleId,
        status: "pending",
        agentRunId: taskRunId,
        createdAt: triggeredAt
      }
    });
  });

  return {
    message: await getMessageInGame(input.gameSessionId, messageId),
    postShareTaskId: taskId,
    triggeredAt: triggeredAt.toISOString()
  };
}

function getCurrentShareRoleId(
  act: Act,
  session: Awaited<ReturnType<typeof getGameSession>>
): RoleId | null {
  const index = getNextShareIndex(act, session, session.currentShareIndex);

  return index === -1 ? null : act.share_order[index] ?? null;
}

function getNextShareIndex(
  act: Act,
  session: Awaited<ReturnType<typeof getGameSession>>,
  startIndex: number
): number {
  for (let index = startIndex; index < act.share_order.length; index += 1) {
    const roleId = act.share_order[index];

    if (roleId === session.userRoleId || session.aiRoleIds.includes(roleId)) {
      return index;
    }
  }

  return -1;
}

function getRoleName(script: Script, roleId: RoleId): string {
  return script.roles.find((role) => role.role_id === roleId)?.name ?? roleId;
}

function findAct(acts: Act[], actId: string): Act {
  const act = acts.find((candidate) => candidate.act_id === actId);

  if (!act) {
    throw new Error(`Act "${actId}" was not found in script.`);
  }

  return act;
}

function findBookletInAct(act: Act, roleId: RoleId): Booklet {
  const booklet = act.booklets.find((candidate) => candidate.role_id === roleId);

  if (!booklet) {
    throw new Error(`Booklet for role "${roleId}" was not found in act "${act.act_id}".`);
  }

  return booklet;
}

function extractTags(items: string[]): string[] {
  return Array.from(
    new Set(
      items
        .flatMap((item) => item.split(/[，。；、\s]+/))
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
        .slice(0, 8)
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
