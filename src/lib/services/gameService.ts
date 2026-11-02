import { publicStoryBoardEnabled } from "./storyBoardSettings";
import { buildHistoricalPrivateKnowledge, type HistoricalPrivateKnowledge } from "./rolePrivateKnowledge";
import type { GameSession as PrismaGameSession, Prisma } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import type { Act, ActId, Booklet, RoleId, Script } from "@/src/lib/script/scriptTypes";
import { transition, type GameAction } from "@/src/lib/state/gameStateMachine";
import type {
  GamePhase,
  GameSession,
  PublicMessage,
  PublicStoryBoard,
  RoleMemory
} from "@/src/lib/types/game";
import { toJsonInput, fromJsonValue } from "@/src/lib/services/jsonFields";
import {
  createEmptyPublicStoryBoard,
  getOrCreatePublicStoryBoard
} from "@/src/lib/services/storyBoardService";
import { getRoleMemory, initializeRoleMemories } from "@/src/lib/services/roleMemoryService";
import { listRecentPublicMessages } from "@/src/lib/services/messageService";
import { getRuntimeMode, type RuntimeMode } from "@/src/lib/services/runtimeMode";
import {
  getScriptForGameSession,
  getScriptPackageForNewSession
} from "@/src/lib/services/scriptPackageService";
import {
  prepareRuntimeGameSession,
  type RuntimeActRangeInput
} from "@/src/lib/services/runtimeDefinitionSessionService";

export const DEFAULT_MAX_DISCUSSION_TURNS = 18;

export type CreateGameSessionInput = {
  publicStoryBoardEnabled?: boolean;
  id?: string;
  scriptPackageId?: string;
  runtimeDefinitionId?: string;
  testMode?: boolean;
  actRange?: RuntimeActRangeInput;
  roleNames?: string[];
  currentActId?: ActId;
  maxDiscussionTurns?: number;
  runtimeMode?: RuntimeMode;
};

export type UpdateGameSessionInput = Partial<
  Pick<
    GameSession,
    | "currentActId"
    | "currentPhase"
    | "currentShareIndex"
    | "userRoleId"
    | "aiRoleIds"
    | "userReadActIds"
    | "discussionTurnCount"
    | "maxDiscussionTurns"
    | "dmFlowCursor"
  >
>;

export type UserBookletView = {
  role_id: RoleId;
  act_id: ActId;
  title: string;
  private_text: string;
};

export type AiPlayerContext = {
  publicStoryBoardEnabled?: boolean;
  role_name?: string;
  historical_private_knowledge?: HistoricalPrivateKnowledge;
  runtime_clues?: import("@/src/lib/schemas/runtimeClueSchema").VisibleRuntimeClue[];
  role_id: RoleId;
  act_id: ActId;
  private_text: string;
  must_share: string[];
  may_share: string[];
  must_not_share: string[];
  roleMemory: RoleMemory;
  publicStoryBoard: PublicStoryBoard;
  recentPublicMessages: PublicMessage[];
};

export async function createGameSession(
  input: CreateGameSessionInput = {}
): Promise<GameSession> {
  const packageRecord = input.scriptPackageId ? await prisma.scriptPackage.findUnique({ where: { id: input.scriptPackageId }, select: { slug: true } }) : null;
  if (input.runtimeDefinitionId || input.testMode || (input.scriptPackageId && packageRecord?.slug !== "demo-script" && input.runtimeMode !== "legacy_demo")) {
    return createRuntimeDefinitionGameSession(input);
  }

  const scriptPackage = await getScriptPackageForNewSession(input.scriptPackageId);
  const script = scriptPackage.script;
  const firstAct = script.acts[0];

  if (!firstAct) {
    throw new Error("Cannot create game session because the script has no acts.");
  }

  const record = await prisma.gameSession.create({
    data: {
      id: input.id,
      scriptPackageId: scriptPackage.id,
      runtimeScopeJson: toJsonInput({ publicStoryBoardEnabled: input.publicStoryBoardEnabled === true }),
      currentActId: input.currentActId ?? firstAct.act_id,
      currentPhase: "role_selection",
      currentShareIndex: 0,
      userRoleId: null,
      aiRoleIds: toJsonInput([]),
      userReadActIds: toJsonInput([]),
      discussionTurnCount: 0,
      maxDiscussionTurns: input.maxDiscussionTurns ?? DEFAULT_MAX_DISCUSSION_TURNS,
      publicStoryBoard: {
        create: {
          board: toJsonInput(createEmptyPublicStoryBoard())
        }
      }
    }
  });

  return toGameSession(record, script);
}

async function createRuntimeDefinitionGameSession(
  input: CreateGameSessionInput
): Promise<GameSession> {
  const prepared = await prepareRuntimeGameSession({
    scriptPackageId: input.scriptPackageId,
    runtimeDefinitionId: input.runtimeDefinitionId,
    normalGame: !input.testMode,
    scope: {
      actRange: input.actRange,
      roleNames: input.roleNames
    }
  });
  prepared.scope.publicStoryBoardEnabled = input.publicStoryBoardEnabled === true;
  prepared.scope.testMode = input.testMode === true;
  prepared.scope.runtimeMode = input.runtimeMode === "runtime_manual_debug" ? "runtime_manual_debug" : "runtime_auto";
  const definition = await (await import("@/src/lib/services/scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(prepared.runtimeDefinitionId);
  prepared.scope.runtimeDefinitionVersion = definition.version;
  const cursor = (await import("@/src/lib/services/dmLifecycleService")).initialLifecycleCursor(definition, prepared.scope);
  const firstAct = prepared.script.acts[0];

  if (!firstAct) {
    throw new Error("无法启动测试局：RuntimeDefinition 没有可运行的幕。");
  }

  const record = await prisma.gameSession.create({
    data: {
      id: input.id,
      scriptPackageId: prepared.scriptPackageId,
      runtimeDefinitionId: prepared.runtimeDefinitionId,
      testMode: input.testMode === true,
      runtimeScopeJson: toJsonInput(prepared.scope),
      dmFlowCursorJson: toJsonInput(cursor),
      currentActId: input.currentActId ?? firstAct.act_id,
      currentPhase: "role_selection",
      currentShareIndex: 0,
      userRoleId: null,
      aiRoleIds: toJsonInput([]),
      userReadActIds: toJsonInput([]),
      discussionTurnCount: 0,
      maxDiscussionTurns: input.maxDiscussionTurns ?? DEFAULT_MAX_DISCUSSION_TURNS,
      publicStoryBoard: {
        create: {
          board: toJsonInput(createEmptyPublicStoryBoard())
        }
      }
    }
  });

  return toGameSession(record, prepared.script);
}

export async function getGameSession(gameSessionId: string): Promise<GameSession> {
  const record = await prisma.gameSession.findUnique({
    where: { id: gameSessionId }
  });

  if (!record) {
    throw new Error(`GameSession not found for gameSessionId "${gameSessionId}".`);
  }

  return toGameSession(record, await getScriptForGameSession(gameSessionId));
}

export async function selectUserRole(
  gameSessionId: string,
  userRoleId: RoleId
): Promise<GameSession> {
  const script = await getScriptForGameSession(gameSessionId);
  const roleIds = script.roles.map((role) => role.role_id);

  if (!roleIds.includes(userRoleId)) {
    throw new Error(`Role "${userRoleId}" was not found in script.`);
  }

  const existing = await getGameSession(gameSessionId);
  if (existing.userRoleId && existing.currentPhase !== "role_selection") {
    if (existing.userRoleId === userRoleId) return existing;
    throw new Error("游戏开始后不能更换真人角色或替其他角色提交选择。");
  }
  const aiRoleIds = roleIds.filter((roleId) => roleId !== userRoleId);

  const session = await updateGameSession(gameSessionId, {
    currentPhase: "reading",
    userRoleId,
    aiRoleIds,
    currentShareIndex: 0,
    discussionTurnCount: 0
  });

  await initializeRoleMemories(gameSessionId, aiRoleIds);

  return session;
}

export async function updateGameSession(
  gameSessionId: string,
  input: UpdateGameSessionInput
): Promise<GameSession> {
  const data: Prisma.GameSessionUpdateInput = {
    currentActId: input.currentActId,
    currentPhase: input.currentPhase,
    currentShareIndex: input.currentShareIndex,
    userRoleId: input.userRoleId,
    discussionTurnCount: input.discussionTurnCount,
    maxDiscussionTurns: input.maxDiscussionTurns
  };

  if (input.aiRoleIds) {
    data.aiRoleIds = toJsonInput(input.aiRoleIds);
  }

  if (input.userReadActIds) {
    data.userReadActIds = toJsonInput(input.userReadActIds);
  }

  if ("dmFlowCursor" in input) {
    data.dmFlowCursorJson = input.dmFlowCursor ? toJsonInput(input.dmFlowCursor) : null;
  }

  const guarded = await (await import("@/src/lib/services/conversationService")).guardedConversationGameUpdate(gameSessionId, data);
  const record = guarded ?? await prisma.gameSession.update({
    where: { id: gameSessionId },
    data
  });

  return toGameSession(record, await getScriptForGameSession(gameSessionId));
}

export async function applyGameAction(
  gameSessionId: string,
  action: GameAction
): Promise<GameSession> {
  const current = await getGameSession(gameSessionId);
  const next = transition(current, action);
  if (action.type === "AI_INTERNAL_READING_DONE" && (await (await import("@/src/lib/services/conversationPolicyService")).getActConversationPolicy(gameSessionId))?.mode === "free_discussion_after_reading") next.currentPhase = "free_discussion";

  return updateGameSession(gameSessionId, {
    currentActId: next.currentActId,
    currentPhase: next.currentPhase,
    currentShareIndex: next.currentShareIndex,
    userRoleId: next.userRoleId,
    aiRoleIds: next.aiRoleIds,
    userReadActIds: next.userReadActIds,
    discussionTurnCount: next.discussionTurnCount,
    maxDiscussionTurns: next.maxDiscussionTurns,
    dmFlowCursor: next.dmFlowCursor
  });
}

export async function deleteGameSession(gameSessionId: string): Promise<void> {
  await prisma.gameSession.delete({
    where: { id: gameSessionId }
  });
}

export async function getUserBookletView(gameSessionId: string): Promise<UserBookletView> {
  const session = await getGameSession(gameSessionId);
  const script = await getScriptForGameSession(gameSessionId);

  if (!session.userRoleId) {
    throw new Error(`User role has not been selected for game "${gameSessionId}".`);
  }

  const act = findAct(script.acts, session.currentActId);
  const booklet = findBookletInAct(act, session.userRoleId);

  return {
    role_id: booklet.role_id,
    act_id: act.act_id,
    title: act.title,
    private_text: session.runtimeDefinitionId
      ? "当前测试局使用上传的玩家 PDF 读本。请在读本区域查看本幕内容。"
      : booklet.private_text
  };
}

export async function buildAiPlayerContext(
  gameSessionId: string,
  roleId: RoleId
): Promise<AiPlayerContext> {
  const session = await getGameSession(gameSessionId);
  const script = await getScriptForGameSession(gameSessionId);

  if (roleId === session.userRoleId || !session.aiRoleIds.includes(roleId)) {
    throw new Error(`Role "${roleId}" is not an AI player in game "${gameSessionId}".`);
  }

  const act = findAct(script.acts, session.currentActId);
  const booklet = findBookletInAct(act, roleId);
  const [roleMemory, publicStoryBoard, recentPublicMessages] = await Promise.all([
    getRoleMemory(gameSessionId, roleId),
    getOrCreatePublicStoryBoard(gameSessionId),
    listRecentPublicMessages(gameSessionId)
  ]);

  const runtimeClues = await (await import("./runtimeClueService")).getRoleRuntimeClues(gameSessionId, roleId, session);

  const currentActIndex = Number(act.act_id.match(/^runtime_act_(\d+)$/)?.[1]) || script.acts.indexOf(act) + 1;
  const definition = session.runtimeDefinitionId ? await (await import("./scriptRuntimeDefinitionService")).getScriptRuntimeDefinition(session.runtimeDefinitionId) : null;
  const roleName = script.roles.find(r => r.role_id === roleId)?.name ?? roleId;
  const historicalPrivateKnowledge = buildHistoricalPrivateKnowledge({
    booklets: definition ? ((await (await import("./runtimeDefinitionSessionService")).getRuntimeReadingSourcesForGameSession({ gameSessionId, roleName: roleId }))?.booklets ?? []).map(b => ({ ...b, actId: `runtime_act_${b.actIndex}`, definitionId: session.runtimeDefinitionId! })) :
      script.acts.flatMap((a, i) => a.booklets.filter(b => b.role_id === roleId).map(b => ({ roleName, actId: a.act_id, actIndex: i + 1,
        definitionId: null, sourceRoleActBookletId: `${a.act_id}:${roleId}`, privateText: b.private_text,
        mustShare: b.must_share, mayShare: b.may_share, mustNotShare: b.must_not_share, emotionalPoints: [], relationshipPoints: [], timelineFragments: [] }))),
    roleNames: [roleName, roleId], currentActIndex, memory: roleMemory,
    query: recentPublicMessages.slice(-3).map(m => m.content).join(" ")
  });
  return {
    publicStoryBoardEnabled: session.publicStoryBoardEnabled,
    historical_private_knowledge: historicalPrivateKnowledge,
    role_name: roleName,
    role_id: booklet.role_id,
    act_id: act.act_id,
    private_text: booklet.private_text,
    runtime_clues: runtimeClues,
    must_share: booklet.must_share,
    may_share: [...booklet.may_share, ...runtimeClues.filter(c => c.shareAllowed || c.publiclyShared).map(c => c.text)],
    must_not_share: [...booklet.must_not_share, ...runtimeClues.filter(c => !c.shareAllowed && !c.publiclyShared).map(c => c.text)],
    roleMemory,
    publicStoryBoard,
    recentPublicMessages
  };
}

function toGameSession(record: PrismaGameSession, script: Script): GameSession {
  const currentActIndex = script.acts.findIndex((act) => act.act_id === record.currentActId);

  return {
    publicStoryBoardEnabled: publicStoryBoardEnabled(record),
    runtimeMode: getRuntimeMode({ runtimeDefinitionId: record.runtimeDefinitionId, runtimeScope: fromJsonValue(record.runtimeScopeJson ?? null, null) }),
    gameId: record.id,
    scriptPackageId: record.scriptPackageId,
    runtimeDefinitionId: record.runtimeDefinitionId,
    testMode: record.testMode,
    currentActIndex: currentActIndex === -1 ? 0 : currentActIndex,
    totalActs: script.acts.length,
    currentActId: record.currentActId,
    currentPhase: record.currentPhase as GamePhase,
    userRoleId: record.userRoleId,
    aiRoleIds: fromJsonValue<RoleId[]>(record.aiRoleIds, []),
    userReadActIds: fromJsonValue<string[]>(record.userReadActIds, []),
    currentShareIndex: record.currentShareIndex,
    discussionTurnCount: record.discussionTurnCount,
    maxDiscussionTurns: record.maxDiscussionTurns,
    dmFlowCursor: fromJsonValue(record.dmFlowCursorJson ?? null, null),
    runtimeScope: fromJsonValue(record.runtimeScopeJson ?? null, null)
  };
}

function findAct(acts: Act[], actId: ActId): Act {
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
