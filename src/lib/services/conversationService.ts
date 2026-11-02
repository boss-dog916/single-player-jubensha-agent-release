import { encodeQueuedAddress, decodeQueuedAddress, ReplySelectionError, type ReplySelection } from "./discussionReply";
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import { enqueuePublicMessageForStoryBoard, scheduleStoryBoardDrain } from "@/src/lib/services/storyBoardQueueService";
import { getMessageInGame } from "@/src/lib/services/messageService";
import type { CreateMessageInput } from "@/src/lib/services/messageService";
import { withLlmPriority } from "@/src/lib/llm/concurrencyBudget";
import { resolveAddressing } from "@/src/lib/orchestration/addressingResolution";

type Lease = { gameId: string; token: string; actId: string; revision: number; control?: boolean; deferredSeedMessageId?: string };
const scope = new AsyncLocalStorage<Lease>();
const scheduled = new Set<string>();
const runners = new Map<string, Promise<unknown>>();
export class StaleConversationError extends Error {}
const busy = ["generating", "checking", "dm"];

export async function ensureConversation(gameId: string) {
  return prisma.conversationState.upsert({ where: { gameSessionId: gameId },
    create: { gameSessionId: gameId }, update: {} });
}

export async function acceptUserTurn(gameId: string, content: string, clientMessageId: string = randomUUID(), reply?: ReplySelection) {
  await (await import("./runtimeInputPolicy")).assertRuntimeChatAllowed(gameId, reply);
  if (typeof content !== "string" || !content.trim() || content.length > 10000) throw new Error("消息不能为空，且不能超过 10000 字。");
  if (typeof clientMessageId !== "string" || !clientMessageId.trim() || clientMessageId.length > 128) throw new Error("无效的消息标识。");
  const script = await getScriptForGameSession(gameId);
  await ensureConversation(gameId);
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.pendingUserTurn.findUnique({ where: { gameSessionId_clientMessageId: { gameSessionId: gameId, clientMessageId } } });
    if (existing) return existing;
    const session = await tx.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    if (session.currentPhase === "finished") throw new Error("游戏已经结束，不能继续提交剧情发言。");
    if (!session.userRoleId) throw new Error("请先选择角色。");
    const role = script.roles.find((r) => r.role_id === session.userRoleId)!;
    if (reply && !["public", "reply"].includes(reply.mode)) throw new ReplySelectionError("无效的回复方式。");
    const published = await tx.message.findMany({ where: { gameSessionId: gameId, speakerType: { in: ["user", "ai_player"] } },
      select: { speakerRoleId: true, speakerType: true, content: true } });
    const roster = (await import("../orchestration/addressingResolution")).publicDiscussionRoster(script.roles,
      published.map(m => ({ speaker_role_id: m.speakerRoleId, speaker_type: m.speakerType, content: m.content })));
    let targets = reply?.mode === "reply" ? [] as string[] : resolveAddressing(content, roster).directTargets.filter(id => id !== role.role_id);
    let replyToMessageId: string | null = null;
    if (reply?.mode === "reply") {
      if (typeof reply.replyToMessageId !== "string" || !reply.replyToMessageId || reply.replyToMessageId.length > 128) throw new ReplySelectionError("请选择要回复的消息。");
      const parent = await tx.message.findFirst({ where: { id: reply.replyToMessageId, gameSessionId: gameId } });
      if (!parent || parent.speakerType === "system") throw new ReplySelectionError("这条消息不能回复。");
      const definition = session.runtimeDefinitionId ? await tx.scriptRuntimeDefinition.findUnique({ where: { id: session.runtimeDefinitionId } }) : null;
      const pacing = (await import("./discussionPacing")).discussionPacing({ ...session, dmFlowCursor: JSON.parse(session.dmFlowCursorJson ?? "null") } as any, definition ? JSON.parse(definition.definitionJson) : null);
      const publicMessages = await (await import("./messageService")).listMessages(gameId);
      const scopedFollowup = (await import("./publicDiscussionContext")).currentDMInteraction({ ...session,
        aiRoleIds: JSON.parse(session.aiRoleIds), dmFlowCursor: JSON.parse(session.dmFlowCursorJson ?? "null") } as any,
        publicMessages, { message_id: "new-user-followup", speaker_type: "user", reply_to_message_id: parent.id });
      if (pacing.mode === "dm_performance" && parent.speakerType !== "dm" && !scopedFollowup) throw new ReplySelectionError("演绎中请回复DM当前问答，暂不进行其他玩家讨论。");
      if (pacing.mode === "dm_performance" && !scopedFollowup && parent.id !== JSON.parse(session.dmFlowCursorJson ?? "null")?.pendingDMQuestion?.messageId)
        throw new ReplySelectionError("请回复DM当前的问题。");
      replyToMessageId = parent.id;
      targets = parent.speakerRoleId === role.role_id
        ? [...new Set([...(JSON.parse(parent.targetRoleIds) as string[]), ...resolveAddressing(parent.content, roster).directTargets])].filter(id => id !== role.role_id)
        : parent.speakerRoleId ? [parent.speakerRoleId] : [];
    }
    const row = await tx.pendingUserTurn.upsert({
      where: { gameSessionId_clientMessageId: { gameSessionId: gameId, clientMessageId } },
      create: { gameSessionId: gameId, clientMessageId, content: content.trim(), roleId: role.role_id,
        roleName: role.name, targetRoleIdsJson: encodeQueuedAddress({ targets, mode: reply?.mode, replyToMessageId }) }, update: {}
    });
    const state = await tx.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
    await tx.conversationState.update({ where: { gameSessionId: gameId }, data: { updatedAt: new Date() } });
    if (!busy.includes(state.stage)) await flushInTransaction(tx, gameId);
    return tx.pendingUserTurn.findUniqueOrThrow({ where: { id: row.id } });
  });
  scheduleConversationDrain(gameId);
  return result;
}

// All queued messages become one revision and one planning seed, in submission order.
async function flushInTransaction(tx: Prisma.TransactionClient, gameId: string) {
  const queued = await tx.pendingUserTurn.findMany({ where: { gameSessionId: gameId, status: "queued" },
    orderBy: { sequence: "asc" } });
  if (!queued.length) return null;
  const first = decodeQueuedAddress(queued[0].targetRoleIdsJson);
  const rows = [] as typeof queued;
  for (const row of queued) {
    const address = decodeQueuedAddress(row.targetRoleIdsJson);
    if (address.mode !== first.mode || address.replyToMessageId !== first.replyToMessageId) break;
    rows.push(row);
  }
  const session = await tx.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  const definition = session.runtimeDefinitionId ? await tx.scriptRuntimeDefinition.findUnique({ where: { id: session.runtimeDefinitionId } }) : null;
  const cursor = JSON.parse(session.dmFlowCursorJson ?? "null");
  const node = definition ? JSON.parse(definition.definitionJson).dmFlow?.actFlows.flatMap((f: { nodes: { nodeId: string; inputPolicy?: string }[] }) => f.nodes).find((n: { nodeId: string }) => n.nodeId === cursor?.nodeId) : null;
  const state = await tx.conversationState.update({ where: { gameSessionId: gameId },
    data: { revision: { increment: 1 } } });
  if (session.currentPhase === "free_discussion") await tx.gameSession.update({ where: { id: gameId },
    data: { discussionTurnCount: { increment: 1 } } });
  const last = await tx.message.findFirst({ where: { gameSessionId: gameId }, orderBy: { createdAt: "desc" } });
  let timestamp = Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1);
  const ids: string[] = [];
  for (const row of rows) {
    const id = randomUUID();
    const address = decodeQueuedAddress(row.targetRoleIdsJson);
    const targets = address.targets;
    await tx.message.create({ data: { id, gameSessionId: gameId, speakerType: "user",
      speakerRoleId: row.roleId, speakerName: row.roleName, targetRoleIds: JSON.stringify(targets), replyToMessageId: address.replyToMessageId ?? null,
      phase: session.currentPhase, speechAct: /[?？]|吗|呢|怎么看|有没有|谁|问一下|问问/.test(row.content) ? "question" : "statement", content: row.content,
      metadata: JSON.stringify({ discussionAddressingMode: address.mode, runtimeInputPolicy: node?.inputPolicy, revealed_facts: [], emotional_points: [], questions_raised: /[?？]|吗|呢|怎么看|有没有|谁|问一下|问问/.test(row.content) ? [row.content] : [],
        mentioned_role_ids: targets, event_tags: [], topic_tags: [], act_id: session.currentActId }), createdAt: new Date(timestamp++) } });
    await tx.pendingUserTurn.update({ where: { id: row.id }, data: {
      status: "committed", messageId: id, revision: state.revision, committedAt: new Date() } });
    ids.push(id);
  }
  await tx.conversationState.update({ where: { gameSessionId: gameId }, data: {
    seedMessageId: ids.at(-1), batchIdsJson: JSON.stringify(ids),
    ...(state.status === "running" ? {} : { status: "pending", stage: "idle" }) } });
  return ids.at(-1)!;
}

export async function conversationCheckpoint(gameId: string) {
  const lease = scope.getStore();
  return prisma.$transaction(async (tx) => {
    const state = await tx.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
    if (lease && (state.leaseToken !== lease.token || state.status !== "running")) throw new StaleConversationError("conversation lease lost");
    const seed = await flushInTransaction(tx, gameId);
    const next = await tx.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
    const changed = !!seed || !!lease && lease.revision !== next.revision;
    if (lease) lease.revision = next.revision;
    await tx.conversationState.update({ where: { gameSessionId: gameId }, data: {
      stage: "planning", roleId: null, heartbeatAt: new Date() } });
    return { changed, seedMessageId: changed ? next.seedMessageId : null, revision: next.revision };
  });
}

export async function beginConversationTurn(gameId: string, roleId: string, baseRevision: number) {
  const lease = scope.getStore();
  if (!lease) return true;
  const claimed = await prisma.$transaction(async (tx) => {
    if (await tx.pendingUserTurn.count({ where: { gameSessionId: gameId, status: "queued" } })) return { count: 0 };
    return tx.conversationState.updateMany({ where: { gameSessionId: gameId,
    leaseToken: lease.token, revision: baseRevision, status: "running", stage: "planning" },
    data: { stage: "generating", roleId, heartbeatAt: new Date() } });
  });
  return claimed.count === 1;
}

export async function conversationStage(stage: string) {
  const lease = scope.getStore();
  if (!lease) return;
  const changed = await prisma.conversationState.updateMany({ where: {
    gameSessionId: lease.gameId, leaseToken: lease.token, revision: lease.revision, status: "running" }, data: { stage, heartbeatAt: new Date() } });
  if (!changed.count) throw new StaleConversationError("conversation lease lost");
}

// Hand an unplanned public turn to the existing drain without resetting budgets.
// Keep this on the shared lease too: a nested DM runner's parent may checkpoint
// again before the lease finally releases.
export async function deferConversationSeed(gameId: string, seedMessageId: string) {
  const lease = scope.getStore();
  if (!lease || lease.gameId !== gameId) throw new StaleConversationError("No conversation owns deferred turn");
  await getMessageInGame(gameId, seedMessageId);
  const current = await ensureConversation(gameId);
  let batchIdsJson = current.batchIdsJson;
  if (current.seedMessageId !== seedMessageId) {
    // A prioritized DM reply may have replaced the seed. Rehydrate the existing
    // committed user batch rather than keeping only its final message.
    const turn = await prisma.pendingUserTurn.findFirst({ where: { gameSessionId: gameId, messageId: seedMessageId, status: "committed" } });
    const batch = turn ? await prisma.pendingUserTurn.findMany({ where: { gameSessionId: gameId, status: "committed", revision: turn.revision },
      orderBy: { sequence: "asc" }, select: { messageId: true } }) : [];
    batchIdsJson = JSON.stringify(batch.length ? batch.map(row => row.messageId) : [seedMessageId]);
  }
  const changed = await prisma.conversationState.updateMany({ where: {
    gameSessionId: gameId, leaseToken: lease.token, revision: lease.revision, status: "running"
  }, data: { stage: "replan", seedMessageId, batchIdsJson } });
  if (!changed.count) throw new StaleConversationError("conversation lease lost before deferring turn");
  lease.deferredSeedMessageId = seedMessageId;
}

export async function commitConversationMessage(input: CreateMessageInput) {
  const lease = scope.getStore();
  if (!lease || input.gameSessionId !== lease.gameId) return null;
  return prisma.$transaction(async (tx) => {
    const state = await tx.conversationState.findUniqueOrThrow({ where: { gameSessionId: lease.gameId } });
    const session = await tx.gameSession.findUniqueOrThrow({ where: { id: lease.gameId } });
    if (state.leaseToken !== lease.token || state.status !== "running" || session.currentActId !== lease.actId ||
      state.revision !== lease.revision || session.currentPhase !== input.phase) throw new StaleConversationError("stale conversation commit");
    if (input.speakerType === "ai_player" && (input.replyToMessageId || input.metadata?.discussionSourceMessageId) && await tx.message.count({ where: {
      gameSessionId: lease.gameId, speakerType: "ai_player", speakerRoleId: input.speakerRoleId,
      OR: [...(input.replyToMessageId ? [{ replyToMessageId: input.replyToMessageId }] : []), ...(input.metadata?.discussionSourceMessageId ? [{ metadata: { contains: `"discussionSourceMessageId":${JSON.stringify(input.metadata.discussionSourceMessageId)}` } }] : [])] } })) throw new StaleConversationError("duplicate AI turn");
    const last = await tx.message.findFirst({ where: { gameSessionId: lease.gameId }, orderBy: { createdAt: "desc" } });
    const record = await tx.message.create({ data: { ...input, targetRoleIds: JSON.stringify(input.targetRoleIds ?? []),
      metadata: JSON.stringify({ ...input.metadata, act_id: input.metadata?.act_id ?? session.currentActId }), createdAt: new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)) } });
    if (input.speakerType === "ai_player") await tx.gameSession.update({ where: { id: lease.gameId },
      data: { discussionTurnCount: { increment: 1 } } });
    await tx.conversationState.update({ where: { gameSessionId: lease.gameId }, data: {
      stage: "planning", roleId: null, seedMessageId: record.id, batchIdsJson: "[]", heartbeatAt: new Date() } });
    await flushInTransaction(tx, lease.gameId);
    return record;
  });
}

export function inConversation() { return !!scope.getStore(); }
export function adoptAuthorizedDMAct(gameId: string, actId: string) {
  const lease = scope.getStore();
  if (lease?.gameId === gameId) lease.actId = actId;
}

export async function assertDMTransactionFence(tx: Prisma.TransactionClient, gameId: string) {
  const lease = scope.getStore();
  if (!lease || lease.gameId !== gameId) return;
  const state = await tx.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
  const session = await tx.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  if (state.leaseToken !== lease.token || state.status !== "running" || state.revision !== lease.revision ||
      session.currentActId !== lease.actId) throw new StaleConversationError("stale DM lifecycle commit");
}
export function conversationRevision() { return scope.getStore()?.revision ?? 0; }

export async function assertConversationProviderStart(gameId?: string | null) {
  const lease = scope.getStore();
  if (!lease) {
    // Background consumers have no conversation lease, but still cannot start
    // a fresh generation after the game has formally finished.
    if (gameId && (await prisma.gameSession.findUnique({ where: { id: gameId }, select: { currentPhase: true } }))?.currentPhase === "finished")
      throw new StaleConversationError("game already finished");
    return;
  }
  const state = await prisma.conversationState.findUniqueOrThrow({ where: { gameSessionId: lease.gameId } });
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: lease.gameId } });
  if (session.currentPhase === "finished" || state.leaseToken !== lease.token || state.status !== "running" || state.revision !== lease.revision || session.currentActId !== lease.actId) {
    throw new StaleConversationError("stale queued provider call");
  }
}

export async function guardedConversationGameUpdate(gameId: string, data: Prisma.GameSessionUpdateInput) {
  const lease = scope.getStore();
  if (!lease || lease.gameId !== gameId) return null;
  return prisma.$transaction(async (tx) => {
    const state = await tx.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
    const session = await tx.gameSession.findUniqueOrThrow({ where: { id: gameId } });
    if (state.leaseToken !== lease.token || state.status !== "running" || state.revision !== lease.revision ||
      session.currentActId !== lease.actId) throw new StaleConversationError("stale conversation state update");
    const record = await tx.gameSession.update({ where: { id: gameId }, data });
    if (lease.control) lease.actId = record.currentActId;
    return record;
  });
}

export async function withConversation<T>(gameId: string, seedMessageId: string, operation: () => Promise<T>, control = false): Promise<T | null> {
  if (scope.getStore()?.gameId === gameId) return operation();
  const existing = runners.get(gameId);
  if (existing && control) return null;
  if (existing) await existing.catch(() => null);
  const work = runWithLease(gameId, seedMessageId, operation, control);
  runners.set(gameId, work);
  try { return await work; } finally { if (runners.get(gameId) === work) runners.delete(gameId); }
}

async function runWithLease<T>(gameId: string, seedMessageId: string, operation: () => Promise<T>, control: boolean) {
  await ensureConversation(gameId);
  await recoverConversation(gameId);
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  const beforeClaim = await prisma.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
  const token = randomUUID();
  const claim = await prisma.conversationState.updateMany({ where: { gameSessionId: gameId,
    status: control ? { in: ["idle", "failed"] } : { not: "running" } },
    data: { status: "running", stage: "planning", leaseToken: token, actId: session.currentActId, heartbeatAt: new Date(), errorMessage: null } });
  if (!claim.count) return null;
  const state = await prisma.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
  await prisma.conversationState.updateMany({ where: { gameSessionId: gameId, leaseToken: token, seedMessageId: null },
    data: { seedMessageId } });
  const heartbeat = setInterval(() => { void prisma.conversationState.updateMany({ where: {
    gameSessionId: gameId, leaseToken: token, status: "running" }, data: { heartbeatAt: new Date() } }).catch(() => null); }, 5000);
  const lease: Lease = { gameId, token, actId: session.currentActId, control,
    revision: beforeClaim.status === "pending" ? state.revision - 1 : state.revision };
  let failed = false;
  try {
    return await scope.run(lease, operation);
  } catch (error) {
    failed = true;
    await prisma.conversationState.updateMany({ where: { gameSessionId: gameId, leaseToken: token },
      data: { errorMessage: error instanceof Error ? error.message : String(error) } });
    throw error;
  } finally {
    clearInterval(heartbeat);
    await prisma.$transaction(async (tx) => {
      const current = await tx.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
      if (current.leaseToken !== token) return;
      const unhandled = current.revision !== lease.revision;
      const queued = await flushInTransaction(tx, gameId);
      await tx.conversationState.update({ where: { gameSessionId: gameId }, data: {
        ...(lease.deferredSeedMessageId && !queued && !unhandled ? {
          seedMessageId: lease.deferredSeedMessageId,
          batchIdsJson: current.seedMessageId === lease.deferredSeedMessageId ? current.batchIdsJson : JSON.stringify([lease.deferredSeedMessageId])
        } : {}),
        status: queued || unhandled || lease.deferredSeedMessageId || current.stage === "replan" ? "pending" : failed ? "failed" : "idle", stage: "idle", roleId: null, leaseToken: null, heartbeatAt: null } });
    });
    scheduleConversationDrain(gameId);
    if (process.env.NODE_ENV !== "test") {
      scheduleStoryBoardDrain(gameId);
      void import("./dmTextFlowService").then(module => module.scheduleTextDMTick(gameId)).catch(console.error);
    }
  }
}

export async function recoverConversation(gameId: string) {
  await prisma.$transaction(async (tx) => {
    const row = await tx.conversationState.findFirst({ where: { gameSessionId: gameId, status: "running",
      heartbeatAt: { lt: new Date(Date.now() - 30_000) } } });
    if (!row) return;
    // The same game lease covers the entire post-share pipeline, not just its AI loop.
    await tx.postShareTask.updateMany({ where: { gameSessionId: gameId, status: "running",
      claimedAt: { lte: row.heartbeatAt! } }, data: {
      status: "pending", claimedAt: null, errorMessage: "recovered_conversation_lease" } });
    const seed = await flushInTransaction(tx, gameId);
    await tx.conversationState.update({ where: { gameSessionId: gameId }, data: {
      status: seed || row.seedMessageId ? "pending" : "idle", stage: "idle", leaseToken: null,
      roleId: null, errorMessage: "recovered_expired_lease" } });
  });
}

export async function drainConversation(gameId: string) {
  await ensureConversation(gameId);
  await recoverConversation(gameId);
  await syncCommittedUserStoryBoard(gameId);
  if (await (await import("./modelAvailabilityService")).getModelAvailability(gameId)) return;
  const activePost = await prisma.postShareTask.count({ where: { gameSessionId: gameId, status: { in: ["pending", "running"] } } });
  if (activePost) return;
  const state = await prisma.conversationState.findUniqueOrThrow({ where: { gameSessionId: gameId } });
  if (state.status !== "pending" || !state.seedMessageId) return;
  const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: gameId } });
  if (!["share_round", "free_discussion", "dm_question"].includes(session.currentPhase)) {
    await prisma.$transaction((tx) => flushInTransaction(tx, gameId));
    await prisma.conversationState.updateMany({ where: { gameSessionId: gameId, status: "pending" }, data: { status: "idle" } });
    return;
  }
  const { runAutoDiscussionAfterMessage } = await import("@/src/lib/orchestration/autoDiscussionRunner");
  await withLlmPriority(0, () => runAutoDiscussionAfterMessage({ gameId, seedMessageId: state.seedMessageId! }));
}

export function scheduleConversationDrain(gameId: string) {
  if (process.env.NODE_ENV === "test" || scheduled.has(gameId)) return;
  scheduled.add(gameId);
  setTimeout(() => { scheduled.delete(gameId); void drainConversation(gameId).catch(console.error); }, 50);
}

export async function syncCommittedUserStoryBoard(gameId: string) {
  const rows = await prisma.message.findMany({ where: { gameSessionId: gameId, speakerType: "user", storyBoardStatus: "not_queued" }, select: { id: true } });
  for (const row of rows) {
    const message = await getMessageInGame(gameId, row.id);
    if (message.story_board_status === "not_queued") await enqueuePublicMessageForStoryBoard({ gameSessionId: gameId, message });
  }
}

export async function getConversationView(gameId: string, tx?: Prisma.TransactionClient) {
  if (!tx) return prisma.$transaction((db) => readConversationView(gameId, db));
  return readConversationView(gameId, tx);
}

async function readConversationView(gameId: string, db: Prisma.TransactionClient) {
  const [state, pending, acknowledgements] = await Promise.all([
    db.conversationState.findUnique({ where: { gameSessionId: gameId }, select: {
      gameSessionId: true, revision: true, status: true, stage: true, roleId: true,
      seedMessageId: true, actId: true, errorMessage: true, updatedAt: true } }),
    db.pendingUserTurn.findMany({ where: { gameSessionId: gameId, status: "queued" }, orderBy: { sequence: "asc" } }),
    db.pendingUserTurn.findMany({ where: { gameSessionId: gameId }, orderBy: { sequence: "desc" }, take: 100,
      select: { clientMessageId: true, status: true, messageId: true } })
  ]);
  return { state, pending: pending.map(p => ({ ...p, replyToMessageId: decodeQueuedAddress(p.targetRoleIdsJson).replyToMessageId, addressingMode: decodeQueuedAddress(p.targetRoleIdsJson).mode })), acknowledgements };
}

export async function hasActiveConversation(gameId: string) {
  const state = await prisma.conversationState.findUnique({ where: { gameSessionId: gameId } });
  return !!state && ["running", "pending"].includes(state.status);
}

export async function coalescedSeed(gameId: string, seedId: string) {
  const state = await prisma.conversationState.findUnique({ where: { gameSessionId: gameId } });
  const ids: string[] = state?.seedMessageId === seedId ? JSON.parse(state.batchIdsJson) : [];
  if (ids.length < 2) return undefined;
  const messages = await Promise.all(ids.map((id) => getMessageInGame(gameId, id)));
  const last = messages.at(-1)!;
  if (messages.some(m => m.reply_to_message_id !== last.reply_to_message_id || m.metadata.discussionAddressingMode !== last.metadata.discussionAddressingMode)) return undefined;
  return { ...last, content: messages.map((m) => m.content).join("\n"),
    target_role_ids: Array.from(new Set(messages.flatMap((m) => m.target_role_ids ?? []))) };
}
