import type { ActId, RoleId } from "@/src/lib/script/scriptTypes";
import { getGameSession, getUserBookletView, type UserBookletView } from "@/src/lib/services/gameService";
import { listRecentAgentRuns } from "@/src/lib/services/agentRunService";
import { listMessages } from "@/src/lib/services/messageService";
import { getRoleMemory } from "@/src/lib/services/roleMemoryService";
import { getOrCreatePublicStoryBoard } from "@/src/lib/services/storyBoardService";
import {
  getPlayerPdfReadingForSnapshot,
  type PlayerPdfReadingSnapshotView
} from "@/src/lib/services/playerPdfReadingService";
import type {
  GameSession,
  InternalReadingStatus,
  Message,
  PublicStoryBoard
} from "@/src/lib/types/game";
import type { ReactionIntent } from "@/src/lib/schemas/reactionIntentSchema";
import type { DiscussionCheckerOutput } from "@/src/lib/schemas/discussionCheckerSchema";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import type {
  AutoDiscussionBudget,
  AutoDiscussionStopReason
} from "@/src/lib/orchestration/autoDiscussionRunner";
import {
  getDMFlowCursorDebugView,
  type DMFlowCursorDebugView
} from "@/src/lib/services/dmFlowCursorService";
import { getLatestScriptRuntimeDefinition } from "@/src/lib/services/scriptRuntimeDefinitionService";
import {
  getLatestPostShareTask,
  type PostShareTaskView
} from "@/src/lib/services/postShareTaskService";

export type PublicRoleView = {
  role_id: RoleId;
  name: string;
  personality: string;
};

export type PublicActView = {
  act_id: ActId;
  title: string;
  bgm: string;
  share_order: RoleId[];
};

export type GameClientView = {
  title: string;
  roles: PublicRoleView[];
  acts: PublicActView[];
};

export type GameRuntimeSnapshot = {
  modelAvailability?: Awaited<ReturnType<typeof import("./modelAvailabilityService").getModelAvailability>>;
  clues: import("@/src/lib/schemas/runtimeClueSchema").VisibleRuntimeClue[];
  game: GameClientView;
  session: GameSession;
  messages: Message[];
  storyBoard: PublicStoryBoard;
  userBooklet: UserBookletView | null;
  playerPdfReading: PlayerPdfReadingSnapshotView | null;
  readBooklets: UserBookletView[];
  aiInternalReadingStatus: AiInternalReadingStatusView;
  userReadingStatus: UserReadingStatusView;
  recentAgentRuns: AgentRunDebugView[];
  latestReactionPlan: ReactionPlanDebugView | null;
  latestReactionExecution: ReactionExecutionDebugView | null;
  latestAutoDiscussion: AutoDiscussionDebugView | null;
  postShareDiscussion: PostShareTaskView | null;
  shareDrafts: Awaited<ReturnType<typeof import("@/src/lib/services/shareDraftService").listShareDraftStatus>>;
  conversation: Awaited<ReturnType<typeof import("@/src/lib/services/conversationService").getConversationView>>;
  dmFlowCursor: DMFlowCursorDebugView;
  restoreWarnings: GameSessionRestoreWarning[];
};

export type GameSessionRestoreWarning = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
};

export type AiInternalReadingRoleStatusView = {
  roleId: RoleId;
  roleName: string;
  status: InternalReadingStatus;
  agentRunId?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type AiInternalReadingStatusView = {
  actId: ActId;
  overallStatus: InternalReadingStatus;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  idleCount: number;
  roles: AiInternalReadingRoleStatusView[];
};

export type UserReadingStatusView = {
  actId: ActId;
  status: "reading" | "completed";
};

export type AgentRunDebugView = {
  id: string;
  traceId: string | null;
  runKind: string;
  agentType: string;
  roleId: RoleId | null;
  model: string | null;
  provider?: string | null;
  status: string;
  latencyMs: number | null;
  ttftMs: number | null;
  promptChars: number | null;
  outputChars: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  retryCount: number | null;
  startedAt: string;
  errorMessage: string | null;
  detail?: string | null;
};

export type ReactionPlanDebugView = {
  addressing?: import("@/src/lib/orchestration/addressingResolution").AddressingResolution;
  addressingTrace?: import("@/src/lib/orchestration/discussionOrchestrator").DiscussionReactionPlan["addressingTrace"];
  plannerCandidates?: import("@/src/lib/orchestration/reactionPrefilter").ReactionCandidate[];
  latestMessage: {
    message_id: string;
    speaker_role_id: string | null;
    speaker_name: string | null;
    speech_act: string;
    target_role_ids?: string[];
    content: string;
  };
  triggerClassification?: {
    triggerType: string;
    targetRoleIds: string[];
    targetRoleNames: string[];
    confidence: number;
  };
  prefilterCandidates: Array<{
    roleId: RoleId;
    roughScore: number;
    matchedSignals: string[];
  }>;
  reactionIntents: ReactionIntent[];
  schedulerResult: {
    selected_reactions: ReactionIntent[];
    should_dm_intervene: boolean;
    reason: string;
  };
};

export type ReactionExecutionDebugView = {
  latestMessage: {
    message_id: string;
    speaker_role_id: string | null;
    speaker_name: string | null;
    speech_act: string;
    content: string;
  };
  selectedReactions: ReactionIntent[];
  createdMessages: Message[];
  checkerResults: DiscussionCheckerOutput[];
  attempts?: Array<{
    roleId: RoleId;
    attempt: 1 | 2;
    checkerMode?: string;
    checkerLlmInvoked?: boolean;
    checkerDeterministicLatencyMs?: number;
    candidate: {
      content: string;
    };
    checkerResult: DiscussionCheckerOutput;
  }>;
  blockedReactions: Array<{
    selectedReaction: ReactionIntent;
    checkerResult?: DiscussionCheckerOutput;
    reason: string;
  }>;
};

export type AutoDiscussionDebugView = {
  mode: string;
  seedMessageId: string;
  phase: string;
  budget: AutoDiscussionBudget;
  waves: Array<{
    waveIndex: number;
    seedMessageId: string;
    phase: string;
    selectedReactions: ReactionIntent[];
    createdMessageIds: string[];
    blockedCount: number;
    stopReason?: AutoDiscussionStopReason;
  }>;
  totalAiReplies: number;
  stopReason: AutoDiscussionStopReason;
  dmCloseTriggered: boolean;
  dmCloseMessageId?: string | null;
};

export type { UserBookletView } from "@/src/lib/services/gameService";
export type { PlayerPdfReadingSnapshotView } from "@/src/lib/services/playerPdfReadingService";
export type { DMFlowCursorDebugView } from "@/src/lib/services/dmFlowCursorService";
export type { PostShareTaskView } from "@/src/lib/services/postShareTaskService";

export function getGameClientView(script: Awaited<ReturnType<typeof getScriptForGameSession>>): GameClientView {
  return {
    title: script.title,
    roles: script.roles.map((role) => ({
      role_id: role.role_id,
      name: role.name,
      personality: role.personality
    })),
    acts: script.acts.map((act) => ({
      act_id: act.act_id,
      title: act.title,
      bgm: act.bgm,
      share_order: act.share_order
    }))
  };
}

export async function getGameRuntimeSnapshot(
  gameSessionId: string
): Promise<GameRuntimeSnapshot> {
  await (await import("@/src/lib/services/dmLifecycleService")).ensureDMLifecycle(gameSessionId);
  void (await import("./dmTextFlowService")).scheduleTextDMTick(gameSessionId).catch(() => null);
  const [session, storyBoard] = await Promise.all([
    getGameSession(gameSessionId),
    getOrCreatePublicStoryBoard(gameSessionId)
  ]);
  const script = await getScriptForGameSession(gameSessionId);
  const userBooklet = session.userRoleId ? await getUserBookletView(gameSessionId) : null;
  const [
    playerPdfReading,
    aiInternalReadingStatus,
    recentAgentRuns,
    latestReactionPlan,
    latestReactionExecution,
    latestAutoDiscussion,
    postShareDiscussion,
    dmFlowCursor
  ] = await Promise.all([
    session.userRoleId ? getPlayerPdfReadingForSnapshot(gameSessionId) : Promise.resolve(null),
    getAiInternalReadingStatusView(session),
    getRecentAgentRunDebugView(gameSessionId),
    getLatestReactionPlanDebugView(gameSessionId),
    getLatestReactionExecutionDebugView(gameSessionId),
    getLatestAutoDiscussionDebugView(gameSessionId),
    getLatestPostShareTask(gameSessionId),
    getDMFlowCursorDebugView(gameSessionId)
  ]);

  // Keep completion state and its committed messages in the same database snapshot.
  const { getConversationView } = await import("@/src/lib/services/conversationService");
  const { prisma } = await import("@/src/lib/db/prisma");
  const [messages, conversation] = await prisma.$transaction(async (tx) => Promise.all([
    listMessages(gameSessionId, tx), getConversationView(gameSessionId, tx)
  ]));

  return {
    game: getGameClientView(script),
    modelAvailability: await (await import("./modelAvailabilityService")).getModelAvailability(gameSessionId),
    clues: await (await import("./runtimeClueService")).getPlayerRuntimeClues(gameSessionId, session),
    conversation,
    session,
    messages,
    storyBoard,
    userBooklet,
    playerPdfReading,
    readBooklets: getReadBooklets(session, script),
    aiInternalReadingStatus,
    userReadingStatus: {
      actId: session.currentActId,
      status: session.userReadActIds.includes(session.currentActId) ? "completed" : "reading"
    },
    recentAgentRuns,
    latestReactionPlan,
    latestReactionExecution,
    latestAutoDiscussion,
    postShareDiscussion,
    dmFlowCursor,
    shareDrafts: await (await import("@/src/lib/services/shareDraftService")).listShareDraftStatus(gameSessionId),
    restoreWarnings: await buildRestoreWarnings(session, dmFlowCursor)
  };
}

async function buildRestoreWarnings(
  session: GameSession,
  dmFlowCursor: DMFlowCursorDebugView
): Promise<GameSessionRestoreWarning[]> {
  const warnings: GameSessionRestoreWarning[] = [];

  if (session.runtimeDefinitionId && session.scriptPackageId) {
    const latest = await getLatestScriptRuntimeDefinition(session.scriptPackageId);

    if (latest && latest.id !== session.runtimeDefinitionId) {
      warnings.push({
        code: "RUNTIME_DEFINITION_NEWER_AVAILABLE",
        severity: "warning",
        message: `当前残局绑定的是 RuntimeDefinition ${session.runtimeDefinitionId}，剧本包已有更新版本 v${latest.version}。不会自动切换；需要时可在 Debug 中手动重新绑定。`
      });
    }
  }

  if (session.runtimeDefinitionId && !session.dmFlowCursor) {
    warnings.push({
      code: "DM_FLOW_CURSOR_MISSING",
      severity: "warning",
      message: "DM Cursor 尚待安全恢复；当前后台任务结束后会重试，不回放历史手册。"
    });
  }

  if (
    session.dmFlowCursor?.nodeId &&
    dmFlowCursor.available &&
    !dmFlowCursor.currentNode
  ) {
    warnings.push({
      code: "DM_FLOW_CURSOR_NODE_MISSING",
      severity: "warning",
      message: "保存的 DMFlow nodeId 在当前 RuntimeDefinition 中找不到。可尝试按节点序号继续，或在 Debug 中重置 Cursor。"
    });
  }

  const scopeWarnings = getRuntimeScopeWarnings(session.runtimeScope);

  scopeWarnings.forEach((message) => {
    warnings.push({
      code: "RUNTIME_SCOPE_WARNING",
      severity: "info",
      message
    });
  });

  return warnings;
}

function getRuntimeScopeWarnings(scope: unknown): string[] {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return [];
  }

  const warnings = (scope as { warnings?: unknown }).warnings;

  return Array.isArray(warnings)
    ? warnings.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

async function getAiInternalReadingStatusView(
  session: GameSession
): Promise<AiInternalReadingStatusView> {
  const script = await getScriptForGameSession(session.gameId);
  const roleNames = new Map(script.roles.map((role) => [role.role_id, role.name]));
  const roles = await Promise.all(
    session.aiRoleIds.map(async (roleId) => {
      const memory = await getRoleMemory(session.gameId, roleId);
      const record = memory.internal_readings?.[session.currentActId];

      return {
        roleId,
        roleName: roleNames.get(roleId) ?? roleId,
        status: record?.status ?? "idle",
        agentRunId: record?.agentRunId ?? null,
        errorMessage: record?.errorMessage ?? null,
        startedAt: record?.startedAt ?? null,
        completedAt: record?.completedAt ?? null
      };
    })
  );
  const completedCount = roles.filter((role) => role.status === "completed").length;
  const failedCount = roles.filter((role) => role.status === "failed").length;
  const runningCount = roles.filter((role) => role.status === "running").length;
  const idleCount = roles.filter((role) => role.status === "idle").length;
  const overallStatus =
    roles.length > 0 && completedCount === roles.length
      ? "completed"
      : failedCount > 0
        ? "failed"
        : runningCount > 0
          ? "running"
          : "idle";

  return {
    actId: session.currentActId,
    overallStatus,
    completedCount,
    failedCount,
    runningCount,
    idleCount,
    roles
  };
}

async function getRecentAgentRunDebugView(gameSessionId: string): Promise<AgentRunDebugView[]> {
  const runs = await listRecentAgentRuns(
    gameSessionId,
    [],
    24
  );

  return runs.map((run) => ({
    id: run.id,
    traceId: run.traceId,
    runKind: run.runKind,
    agentType: run.agentType,
    roleId: run.roleId,
    model: run.model,
    provider: (run.inputJson as { llmRoute?: { provider?: string } } | null)?.llmRoute?.provider ?? null,
    status: run.status,
    latencyMs: run.latencyMs,
    ttftMs: run.ttftMs,
    promptChars: run.promptChars,
    outputChars: run.outputChars,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    reasoningTokens: run.reasoningTokens,
    cachedInputTokens: run.cachedInputTokens,
    retryCount: run.retryCount,
    startedAt: run.startedAt.toISOString(),
    errorMessage: run.errorMessage,
    detail: getAgentRunDetail(run.agentType, run.inputJson, run.outputJson)
  }));
}

function getAgentRunDetail(
  agentType: string,
  inputJson: unknown,
  outputJson: unknown
): string | null {
  if (agentType === "dm_flow_runner" && isRecord(outputJson)) {
    return [
      `trigger ${toDisplay(outputJson.trigger)}`,
      `node ${toDisplay(outputJson.nodeKey)}`,
      `source ${toDisplay(outputJson.source)}`,
      outputJson.messageCreated === false ? "未写入 Message" : "已写入 Message",
      `output ${truncate(toDisplay(outputJson.dmOutput), 42)}`,
      isRecord(outputJson.checkerResult)
        ? `checker ${toDisplay(outputJson.checkerResult.decision)}`
        : "checker skipped"
    ].join(" · ");
  }

  if (agentType === "dm_output_checker" && isRecord(outputJson)) {
    return [
      `decision ${toDisplay(outputJson.decision)}`,
      Array.isArray(outputJson.issues) && outputJson.issues.length > 0
        ? outputJson.issues.join("；")
        : "无拦截项"
    ].join(" · ");
  }

  if (agentType === "discussion_checker_deterministic" && isRecord(outputJson)) {
    return [
      `mode ${toDisplay(outputJson.checkerMode)}`,
      `decision ${toDisplay(outputJson.decision)}`,
      `deterministic ${toDisplay(outputJson.deterministicLatencyMs)}ms`,
      Array.isArray(outputJson.violations) && outputJson.violations.length > 0
        ? outputJson.violations.join("；")
        : "无拦截项"
    ].join(" · ");
  }

  if (
    (agentType === "ai_player_discussion_utterance" || agentType === "discussion_checker") &&
    isRecord(inputJson)
  ) {
    const data = isRecord(outputJson) && isRecord(outputJson.data) ? outputJson.data : null;
    return [
      `reasoning ${toDisplay(inputJson.reasoningEffort)}`,
      `max output ${toDisplay(inputJson.maxOutputTokens)}`,
      isRecord(inputJson.metadata) && inputJson.metadata.checkerMode
        ? `mode ${toDisplay(inputJson.metadata.checkerMode)}`
        : null,
      data?.decision ? `decision ${toDisplay(data.decision)}` : null
    ]
      .filter(Boolean)
      .join(" · ");
  }

  if (agentType === "dm_agent_guided" && isRecord(inputJson)) {
    return "guided DM LLM";
  }

  if (agentType === "dm_discussion_analyzer" && isRecord(outputJson)) {
    const data = isRecord(outputJson.data) ? outputJson.data : outputJson;

    return [
      `action ${toDisplay(data.suggestedDmAction)}`,
      `summary ${Array.isArray(data.publicSummary) ? data.publicSummary.length : 0}`,
      `missing ${Array.isArray(data.missingPoints) ? data.missingPoints.length : 0}`
    ].join(" · ");
  }

  if (agentType === "dm_node_realizer" && isRecord(outputJson)) {
    const data = isRecord(outputJson.data) ? outputJson.data : outputJson;

    return [
      `source ${toDisplay(data.sourceMode)}`,
      `advance ${toDisplay(data.shouldAdvanceAfterSpeaking)}`,
      `text ${truncate(toDisplay(data.text), 42)}`
    ].join(" · ");
  }

  if (agentType === "ai_player_public_share" && isRecord(inputJson)) {
    const hasRepair = hasRepairInstructions(inputJson);

    return hasRepair ? "attempt 2 · rewrite with checker advice" : "attempt 1 · initial candidate";
  }

  if (agentType === "share_checker") {
    const result = extractStructuredOutput(outputJson);

    if (isRecord(result)) {
      return [
        `decision ${toDisplay(result.decision ?? (result.passed ? "pass" : "block"))}`,
        `passed ${toDisplay(result.passed)}`,
        `safe ${toDisplay(result.safe_to_publish)}`,
        Array.isArray(result.reasons) && result.reasons.length > 0
          ? result.reasons.join("；")
          : "无说明"
      ].join(" · ");
    }
  }

  if (agentType === "auto_discussion_runner" && isRecord(outputJson)) {
    return [
      `stop ${toDisplay(outputJson.stopReason)}`,
      `waves ${Array.isArray(outputJson.waves) ? outputJson.waves.length : 0}`,
      `replies ${toDisplay(outputJson.totalAiReplies)}`,
      outputJson.dmCloseTriggered ? "DM 收束已触发" : "DM 收束未触发"
    ].join(" · ");
  }

  if (agentType === "ai_share_visible" && isRecord(outputJson)) {
    return [
      `visible ${toDisplay(outputJson.shareVisibleLatencyMs)}ms`,
      `persist ${toDisplay(outputJson.sharePersistLatencyMs)}ms`,
      isRecord(outputJson.shareDraft) ? `draft ${toDisplay(outputJson.shareDraft.statusAtTurn)} / hit ${toDisplay(outputJson.shareDraft.draftHit)} / wait ${toDisplay(outputJson.shareDraft.waitAtTurnMs)}ms` : "同步生成",
      `message ${toDisplay(outputJson.messageId)}`
    ].join(" · ");
  }

  if (agentType === "post_share_discussion") {
    if (!isRecord(outputJson)) {
      return "后台讨论等待或执行中";
    }
    return [
      `completed ${toDisplay(outputJson.completedAt)}`,
      `latency ${toDisplay(outputJson.postShareDiscussionLatencyMs)}ms`,
      `next action ready ${toDisplay(outputJson.nextActionReadyLatencyMs)}ms`,
      `first followup ${toDisplay(outputJson.firstPostShareMessageLatencyMs)}ms`,
      outputJson.stoppedReason ? `stop ${toDisplay(outputJson.stoppedReason)}` : null,
      Array.isArray(outputJson.errors) && outputJson.errors.length > 0
        ? `errors ${outputJson.errors.length}`
        : "无后台错误"
    ]
      .filter(Boolean)
      .join(" · ");
  }

  return null;
}

async function getLatestReactionExecutionDebugView(
  gameSessionId: string
): Promise<ReactionExecutionDebugView | null> {
  const [run] = await listRecentAgentRuns(gameSessionId, ["discussion_reaction_executor"], 1);
  const output = run?.outputJson;

  if (!isReactionExecutionDebugView(output)) {
    return null;
  }

  return {
    latestMessage: output.latestMessage,
    selectedReactions: output.selectedReactions,
    createdMessages: output.createdMessages,
    checkerResults: output.checkerResults,
    attempts: output.attempts,
    blockedReactions: output.blockedReactions
  };
}

async function getLatestAutoDiscussionDebugView(
  gameSessionId: string
): Promise<AutoDiscussionDebugView | null> {
  const [run] = await listRecentAgentRuns(gameSessionId, ["auto_discussion_runner"], 1);
  const output = run?.outputJson;

  if (!isAutoDiscussionDebugView(output)) {
    return null;
  }

  return output;
}

async function getLatestReactionPlanDebugView(
  gameSessionId: string
): Promise<ReactionPlanDebugView | null> {
  const [run] = await listRecentAgentRuns(gameSessionId, ["discussion_orchestrator"], 1);
  const output = run?.outputJson;

  if (!isReactionPlanDebugView(output)) {
    return null;
  }

  return output;
}

function isReactionExecutionDebugView(value: unknown): value is ReactionExecutionDebugView {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ReactionExecutionDebugView>;

  return (
    Boolean(candidate.latestMessage) &&
    Array.isArray(candidate.selectedReactions) &&
    Array.isArray(candidate.createdMessages) &&
    Array.isArray(candidate.checkerResults) &&
    (candidate.attempts === undefined || Array.isArray(candidate.attempts)) &&
    Array.isArray(candidate.blockedReactions)
  );
}

function isAutoDiscussionDebugView(value: unknown): value is AutoDiscussionDebugView {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AutoDiscussionDebugView>;

  return (
    typeof candidate.mode === "string" &&
    typeof candidate.seedMessageId === "string" &&
    typeof candidate.phase === "string" &&
    Boolean(candidate.budget) &&
    Array.isArray(candidate.waves) &&
    typeof candidate.totalAiReplies === "number" &&
    typeof candidate.stopReason === "string" &&
    typeof candidate.dmCloseTriggered === "boolean"
  );
}

function isReactionPlanDebugView(value: unknown): value is ReactionPlanDebugView {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ReactionPlanDebugView>;

  return (
    Boolean(candidate.latestMessage) &&
    Array.isArray(candidate.prefilterCandidates) &&
    Array.isArray(candidate.reactionIntents) &&
    Boolean(candidate.schedulerResult)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toDisplay(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "-";
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function extractStructuredOutput(value: unknown): unknown {
  if (isRecord(value) && "data" in value) {
    return value.data;
  }

  return value;
}

function hasRepairInstructions(inputJson: Record<string, unknown>): boolean {
  const messages = inputJson.messages;

  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((message) => {
    if (!isRecord(message) || typeof message.content !== "string") {
      return false;
    }

    return message.content.includes('"repair_instructions"') && !message.content.includes('"repair_instructions":null');
  });
}

function getReadBooklets(
  session: GameSession,
  script: Awaited<ReturnType<typeof getScriptForGameSession>>
): UserBookletView[] {
  if (!session.userRoleId) {
    return [];
  }

  const readableActs = script.acts.slice(0, session.currentActIndex + 1);

  return readableActs.map((act) => {
    const booklet = act.booklets.find((candidate) => candidate.role_id === session.userRoleId);

    if (!booklet) {
      throw new Error(`Booklet for role "${session.userRoleId}" was not found in act "${act.act_id}".`);
    }

    return {
      role_id: booklet.role_id,
      act_id: act.act_id,
      title: act.title,
      private_text: session.runtimeDefinitionId
        ? "当前测试局使用上传的玩家 PDF 读本。请在读本区域查看本幕内容。"
        : booklet.private_text
    };
  });
}
