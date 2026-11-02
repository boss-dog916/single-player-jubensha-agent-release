import "server-only";

import { prisma } from "@/src/lib/db/prisma";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import {
  getGameRuntimeSnapshot,
  type GameRuntimeSnapshot
} from "@/src/lib/services/gameRuntimeSnapshotService";
import {
  getLatestScriptRuntimeDefinition,
  getScriptRuntimeDefinition
} from "@/src/lib/services/scriptRuntimeDefinitionService";
import {
  prepareRuntimeGameSession,
  type RuntimeSessionScope
} from "@/src/lib/services/runtimeDefinitionSessionService";
import type { DMFlowCursor, GamePhase } from "@/src/lib/types/game";

export type RuntimeDefinitionRestoreSummary = {
  id: string | null;
  version: number | null;
  status: string | null;
  compiledAt: Date | null;
  isBoundRuntimeDefinitionAvailable: boolean;
  latestRuntimeDefinitionId: string | null;
  latestVersion: number | null;
};

export type ShareStateRestoreView = {
  currentSpeakerRoleName: string | null;
  sharedRoleNames: string[];
  pendingShareRoleNames: string[];
};

export type DiscussionStateRestoreView = {
  discussionTurnCount: number;
  autoReactionProcessedMessageIds: string[];
  triggeredRuleIds: string[];
  lastReactionWave: number | null;
  lastStopReason: string | null;
};

export type GameRuntimeState = GameRuntimeSnapshot & {
  gameSession: GameRuntimeSnapshot["session"];
  runtimeDefinitionSummary: RuntimeDefinitionRestoreSummary | null;
  currentScriptView: GameRuntimeSnapshot["game"];
  publicStoryBoard: GameRuntimeSnapshot["storyBoard"];
  shareState: ShareStateRestoreView;
  discussionState: DiscussionStateRestoreView;
  availableActions: string[];
};

export type RecoverableGameSessionSummary = {
  gameId: string;
  createdAt: Date;
  updatedAt: Date;
  currentPhase: string;
  currentActId: string;
  currentActIndex: number | null;
  userRoleName: string | null;
  activeRoleNames: string[];
  testMode: boolean;
  runtimeDefinitionId: string | null;
  dmFlowCursor: {
    phase: string | null;
    nodeId: string | null;
    waitingFor: string | null;
    triggeredRuleCount: number;
  };
};

export async function getGameRuntimeState(gameSessionId: string): Promise<GameRuntimeState> {
  const snapshot = await getGameRuntimeSnapshot(gameSessionId);
  const [runtimeDefinitionSummary] = await Promise.all([
    buildRuntimeDefinitionSummary(snapshot.session)
  ]);

  return {
    ...snapshot,
    gameSession: snapshot.session,
    runtimeDefinitionSummary,
    currentScriptView: snapshot.game,
    publicStoryBoard: snapshot.storyBoard,
    shareState: buildShareState(snapshot),
    discussionState: buildDiscussionState(snapshot),
    availableActions: buildAvailableActions(snapshot.session.currentPhase)
  };
}

export async function listRecoverableGameSessions(
  scriptPackageId: string
): Promise<RecoverableGameSessionSummary[]> {
  const records = await prisma.gameSession.findMany({
    where: {
      scriptPackageId,
      currentPhase: { not: "finished" }
    },
    orderBy: { updatedAt: "desc" },
    take: 12
  });

  return records.map((record) => {
    const scope = fromJsonValue<Partial<RuntimeSessionScope> | null>(
      record.runtimeScopeJson ?? null,
      null
    );
    const activeRoleNames = Array.isArray(scope?.roleNames)
      ? scope.roleNames.filter((roleName): roleName is string => typeof roleName === "string")
      : fromJsonValue<string[]>(record.aiRoleIds, []);
    const cursor = fromJsonValue<DMFlowCursor | null>(record.dmFlowCursorJson ?? null, null);

    return {
      gameId: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      currentPhase: record.currentPhase,
      currentActId: record.currentActId,
      currentActIndex: inferActIndex(record.currentActId),
      userRoleName: record.userRoleId,
      activeRoleNames: record.userRoleId
        ? Array.from(new Set([record.userRoleId, ...activeRoleNames]))
        : activeRoleNames,
      testMode: record.testMode,
      runtimeDefinitionId: record.runtimeDefinitionId,
      dmFlowCursor: {
        phase: cursor?.phase ?? null,
        nodeId: cursor?.nodeId ?? null,
        waitingFor: cursor?.waitingFor ?? null,
        triggeredRuleCount: cursor?.triggeredRuleIds.length ?? 0
      }
    };
  });
}

export async function resetDiscussionBudget(gameSessionId: string): Promise<void> {
  await prisma.gameSession.update({
    where: { id: gameSessionId },
    data: { discussionTurnCount: 0 }
  });
}

export async function rebindGameSessionToLatestRuntimeDefinition(
  gameSessionId: string
): Promise<{ runtimeDefinitionId: string; version: number; warnings: string[] }> {
  const record = await prisma.gameSession.findUnique({
    where: { id: gameSessionId }
  });

  if (!record) {
    throw new Error(`GameSession not found for gameSessionId "${gameSessionId}".`);
  }

  if (!record.scriptPackageId) {
    throw new Error("当前 GameSession 没有 scriptPackageId，无法重新绑定 RuntimeDefinition。");
  }

  const oldScope = fromJsonValue<Partial<RuntimeSessionScope> | null>(
    record.runtimeScopeJson ?? null,
    null
  );
  const prepared = await prepareRuntimeGameSession({
    scriptPackageId: record.scriptPackageId,
    scope: {
      actRange: oldScope?.actRange,
      roleNames: oldScope?.roleNames
    }
  });
  const latest = await getScriptRuntimeDefinition(prepared.runtimeDefinitionId);
  const currentActId = prepared.script.acts.some((act) => act.act_id === record.currentActId)
    ? record.currentActId
    : prepared.script.acts[0]?.act_id;

  await prisma.gameSession.update({
    where: { id: gameSessionId },
    data: {
      runtimeDefinitionId: prepared.runtimeDefinitionId,
      runtimeScopeJson: toJsonInput(prepared.scope),
      currentActId,
      dmFlowCursorJson: record.dmFlowCursorJson
    }
  });

  return {
    runtimeDefinitionId: prepared.runtimeDefinitionId,
    version: latest.version,
    warnings: prepared.scope.warnings
  };
}

export async function clearSelectedReactionsDebugState(): Promise<{ cleared: boolean; note: string }> {
  return {
    cleared: true,
    note: "当前 selected reactions 只保存在最近 AgentRun debug 输出中，没有独立持久队列；已作为 no-op 处理。"
  };
}

async function buildRuntimeDefinitionSummary(
  session: GameRuntimeSnapshot["session"]
): Promise<RuntimeDefinitionRestoreSummary | null> {
  if (!session.runtimeDefinitionId && !session.scriptPackageId) {
    return null;
  }

  const [bound, latest] = await Promise.all([
    session.runtimeDefinitionId
      ? getScriptRuntimeDefinition(session.runtimeDefinitionId).catch(() => null)
      : Promise.resolve(null),
    session.scriptPackageId
      ? getLatestScriptRuntimeDefinition(session.scriptPackageId)
      : Promise.resolve(null)
  ]);

  return {
    id: bound?.id ?? session.runtimeDefinitionId ?? null,
    version: bound?.version ?? null,
    status: bound?.status ?? null,
    compiledAt: bound?.compiledAt ?? null,
    isBoundRuntimeDefinitionAvailable: Boolean(bound),
    latestRuntimeDefinitionId: latest?.id ?? null,
    latestVersion: latest?.version ?? null
  };
}

function buildShareState(snapshot: GameRuntimeSnapshot): ShareStateRestoreView {
  const activeRoleNames = getActiveRoleNames(snapshot);
  const sharedRoleNames = Array.from(
    new Set(
      snapshot.messages
        .filter(
          (message) =>
            message.phase === "share_round" &&
            message.speech_act === "share" &&
            typeof message.speaker_role_id === "string" &&
            message.speaker_role_id !== "dm" &&
            message.speaker_role_id !== "system"
        )
        .map((message) => message.speaker_role_id as string)
    )
  );
  const currentAct = snapshot.game.acts[snapshot.session.currentActIndex] ?? null;
  const currentSpeakerRoleName =
    currentAct?.share_order[snapshot.session.currentShareIndex] ?? null;

  return {
    currentSpeakerRoleName,
    sharedRoleNames,
    pendingShareRoleNames: activeRoleNames.filter((roleName) => !sharedRoleNames.includes(roleName))
  };
}

function buildDiscussionState(snapshot: GameRuntimeSnapshot): DiscussionStateRestoreView {
  const autoDiscussion = snapshot.latestAutoDiscussion;

  return {
    discussionTurnCount: snapshot.session.discussionTurnCount,
    autoReactionProcessedMessageIds: autoDiscussion
      ? Array.from(new Set(autoDiscussion.waves.map((wave) => wave.seedMessageId)))
      : [],
    triggeredRuleIds: snapshot.session.dmFlowCursor?.triggeredRuleIds ?? [],
    lastReactionWave: autoDiscussion?.waves.at(-1)?.waveIndex ?? null,
    lastStopReason: autoDiscussion?.stopReason ?? null
  };
}

function buildAvailableActions(phase: GamePhase): string[] {
  const phaseActions: Record<GamePhase, string[]> = {
    role_selection: ["select_role"],
    reading: ["user_finished_reading", "open_player_pdf"],
    ai_internal_reading: ["wait_ai_internal_reading"],
    share_round: ["submit_share", "ai_share", "open_player_pdf"],
    free_discussion: ["submit_discussion", "open_player_pdf"],
    dm_question: ["submit_discussion"],
    act_summary: ["next_act", "debug_complete_and_advance"],
    finished: ["view_messages"]
  };

  return phaseActions[phase] ?? [];
}

function getActiveRoleNames(snapshot: GameRuntimeSnapshot): string[] {
  return Array.from(
    new Set(
      [snapshot.session.userRoleId, ...snapshot.session.aiRoleIds].filter(
        (roleName): roleName is string => typeof roleName === "string" && roleName.length > 0
      )
    )
  );
}

function inferActIndex(actId: string): number | null {
  const match = actId.match(/(?:act|runtime_act)_?(\d+)/i);

  return match ? Number(match[1]) : null;
}
