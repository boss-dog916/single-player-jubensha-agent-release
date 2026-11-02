import { ReplySelectionError } from "@/src/lib/services/discussionReply";
import { RuntimeInputPolicyError } from "@/src/lib/services/runtimeInputPolicy";
import { playerRoute } from "@/src/lib/access/routes";
import { RuntimeReadingError } from "@/src/lib/services/runtimeReadingService";
import { RuntimeClueError } from "@/src/lib/services/runtimeClueService";
import { submitGroupMatching } from "@/src/lib/services/groupMatchingService";
import { RuntimeChoiceError, submitHumanRuntimeChoice } from "@/src/lib/services/runtimeChoiceService";
import { NextRequest, NextResponse } from "next/server";
import { acceptUserTurn, hasActiveConversation, scheduleConversationDrain, withConversation, conversationStage } from "@/src/lib/services/conversationService";
import { runDmFlowStep, type RunDmFlowStepInput } from "@/src/lib/agents/dmFlowRunner";
import { runAutoDiscussionAfterMessage } from "@/src/lib/orchestration/autoDiscussionRunner";
import {
  runTracedInteraction,
  unwrapInteractionTraceError
} from "@/src/lib/observability/interactionTrace";
import type { Act, Script } from "@/src/lib/script/scriptTypes";
import { applyGameAction, getGameSession, selectUserRole, updateGameSession } from "@/src/lib/services/gameService";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import { createMessage } from "@/src/lib/services/messageService";
import { getRoleMemory } from "@/src/lib/services/roleMemoryService";
import {
  handleAiPublicShareTurn,
  ShareTurnConflictError
} from "@/src/lib/services/shareController";
import {
  hasActivePostShareTask,
  schedulePostShareTaskDrain
} from "@/src/lib/services/postShareTaskService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import { scheduleShareDraftDrain } from "@/src/lib/services/shareDraftService";
import {
  enqueuePublicMessageForStoryBoard,
  scheduleStoryBoardDrain
} from "@/src/lib/services/storyBoardQueueService";
import { transition } from "@/src/lib/state/gameStateMachine";
import type { StoryBoardPatch } from "@/src/lib/schemas/storyBoardPatchSchema";
import type { Message } from "@/src/lib/types/game";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

type GameEvent =
  | { type: "RESUME_MODEL_EXECUTION" }
  | ({ type: "SHARE_RUNTIME_CLUE" } & import("zod").z.infer<typeof import("@/src/lib/schemas/runtimeClueSchema").ShareRuntimeClueSchema>)
  | { type: "SELECT_ROLE"; roleId: string }
  | { type: "USER_FINISHED_READING"; sectionId?: string; actId?: string }
  | { type: "AI_INTERNAL_READING_DONE" }
  | { type: "AI_SHARE" }
  | { type: "USER_SHARE"; content: string }
  | { type: "USER_DISCUSSION"; content: string; clientMessageId?: string; replyToMessageId?: string | null; addressingMode?: "public" | "reply" }
  | { type: "NEXT_ACT" }
  | { type: "CONFIRM_DM_TEXT"; token: string }
  | ({ type: "SUBMIT_GROUP_MATCHING" } & import("@/src/lib/schemas/runtimeChoiceSchema").GroupMatchingSubmission)
  | ({ type: "SUBMIT_RUNTIME_CHOICE" } & import("@/src/lib/schemas/runtimeChoiceSchema").RuntimeChoiceSubmission);

async function handleGET(_request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  const snapshot = await getGameRuntimeSnapshot(gameId);
  scheduleConversationDrain(gameId);
  scheduleStoryBoardDrain(gameId);
  schedulePostShareTaskDrain(gameId);
  scheduleShareDraftDrain(gameId);
  return NextResponse.json(snapshot);
}

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  let traceId: string | null = null;
  let choiceReceipt: unknown = undefined;

  try {
    const event = (await request.json()) as GameEvent;
    const traced = await runTracedInteraction({
      gameSessionId: gameId,
      action: event.type.toLowerCase(),
      inputJson: event,
      callback: async () => {
        if (event.type === "RESUME_MODEL_EXECUTION") {
          await (await import("@/src/lib/services/modelAvailabilityService")).resumeModelExecution(gameId);
          return { conflict: null };
        }
        if (
          event.type !== "USER_DISCUSSION" && event.type !== "SUBMIT_GROUP_MATCHING" &&
          ((await hasActivePostShareTask(gameId)) || (await hasActiveConversation(gameId)))
        ) {
          return { conflict: "分享后的讨论仍在处理中，请稍候。" };
        }

        const execute = async () => {
        switch (event.type) {
          case "SHARE_RUNTIME_CLUE": {
            const { type: _type, ...payload } = event;
            await (await import("@/src/lib/services/runtimeClueService")).shareHumanRuntimeClue(gameId, payload);
            break;
          }
          case "SELECT_ROLE":
            await handleSelectRole(gameId, event.roleId);
            break;
          case "USER_FINISHED_READING":
            await handleUserFinishedReading(gameId, event);
            break;
          case "AI_INTERNAL_READING_DONE":
            if (!(await areCurrentActAiInternalReadingsCompleted(gameId))) {
              return { conflict: "AI 玩家还在读本" };
            }
            await advanceToShareRoundIfUserReady(gameId);
            break;
          case "AI_SHARE":
            try {
              await handleAiPublicShareTurn({ gameSessionId: gameId });
            } catch (error) {
              if (error instanceof ShareTurnConflictError) {
                return { conflict: error.message };
              }
              throw error;
            }
            break;
          case "USER_SHARE":
            if (await (await import("@/src/lib/services/runtimeInputPolicy")).runtimeInputPolicy(gameId))
              return { conflict: "当前请使用指定问答或结构化选择，尚未开放普通分享。" };
            await handleUserShare(gameId, event.content);
            break;
          case "USER_DISCUSSION":
            await acceptUserTurn(gameId, event.content, event.clientMessageId, event.addressingMode || event.replyToMessageId ? { mode: event.addressingMode ?? "reply", replyToMessageId: event.replyToMessageId } : undefined);
            break;
          case "NEXT_ACT":
            await handleNextAct(gameId);
            break;
          case "SUBMIT_GROUP_MATCHING": {
            const { type: _type, ...payload } = event;
            choiceReceipt = await submitGroupMatching(gameId, payload);
            break;
          }
          case "SUBMIT_RUNTIME_CHOICE": {
            const { type: _type, ...payload } = event;
            choiceReceipt = await submitHumanRuntimeChoice(gameId, payload);
            break;
          }
          case "CONFIRM_DM_TEXT":
            if (typeof event.token !== "string" || !event.token || event.token.length > 128) throw new Error("无效的演绎确认标识。");
            await (await import("@/src/lib/services/dmTextFlowService")).confirmDMText(gameId, event.token);
            break;
          default:
            return { conflict: "操作已更新，请刷新页面。" };
        }

        return { conflict: null };
        };
        if (event.type === "USER_DISCUSSION" || event.type === "SUBMIT_GROUP_MATCHING" || event.type === "SHARE_RUNTIME_CLUE") return execute();
        return await withConversation(gameId, "", async () => {
          await conversationStage("dm");
          return execute();
        }, true) ?? { conflict: "对话状态已变化，请稍后再推进。" };
      }
    });
    traceId = traced.traceId;
    const response = NextResponse.json(
      traced.value.conflict
        ? {
            error: traced.value.conflict,
            traceId,
            snapshot: await getGameRuntimeSnapshot(gameId)
          }
        : {
            ...(await getGameRuntimeSnapshot(gameId)),
            choiceReceipt,
            traceId
          },
      traced.value.conflict ? { status: 409 } : undefined
    );
    response.headers.set("X-Trace-Id", traceId);
    scheduleStoryBoardDrain(gameId);
    schedulePostShareTaskDrain(gameId);
    scheduleShareDraftDrain(gameId);
    scheduleConversationDrain(gameId);

    return response;
  } catch (error) {
    const unwrapped = unwrapInteractionTraceError(error);
    traceId = unwrapped.traceId ?? traceId;
    const message = unwrapped.error instanceof Error ? unwrapped.error.message : "请求处理失败。";

    try {
      const response = NextResponse.json(
        {
          error: message,
          inputRejected: unwrapped.error instanceof RuntimeInputPolicyError || unwrapped.error instanceof ReplySelectionError,
          traceId,
          snapshot: await getGameRuntimeSnapshot(gameId)
        },
        { status: unwrapped.error instanceof ReplySelectionError ? 400 : unwrapped.error instanceof RuntimeChoiceError || unwrapped.error instanceof RuntimeClueError || unwrapped.error instanceof RuntimeReadingError || unwrapped.error instanceof RuntimeInputPolicyError ? unwrapped.error.status : 500 }
      );
      if (traceId) {
        response.headers.set("X-Trace-Id", traceId);
      }
      scheduleStoryBoardDrain(gameId);
      schedulePostShareTaskDrain(gameId);
      scheduleShareDraftDrain(gameId);
      return response;
    } catch {
      return NextResponse.json({ error: message, traceId }, { status: 500 });
    }
  }
}

async function handleUserFinishedReading(gameId: string, input: { sectionId?: string; actId?: string }): Promise<void> {
  const handled = await (await import("@/src/lib/services/runtimeReadingService")).confirmHumanReading(gameId, input);
  if (handled) {
    if (await areCurrentActAiInternalReadingsCompleted(gameId)) await advanceToShareRoundIfUserReady(gameId);
    return;
  }
  const session = await getGameSession(gameId);
  const userReadActIds = Array.from(
    new Set([...session.userReadActIds, session.currentActId])
  );

  await updateGameSession(gameId, {
    userReadActIds
  });

  if (await areCurrentActAiInternalReadingsCompleted(gameId)) {
    await advanceToShareRoundIfUserReady(gameId);
  }
}

async function advanceToShareRoundIfUserReady(gameId: string): Promise<void> {
  const session = await getGameSession(gameId);
  const script = await getScriptForGameSession(gameId);

  if (session.currentPhase !== "reading" && session.currentPhase !== "ai_internal_reading") {
    return;
  }

  if (!session.userReadActIds.includes(session.currentActId)) {
    return;
  }

  if (!(await areCurrentActAiInternalReadingsCompleted(gameId))) {
    return;
  }

  const policy = await (await import("@/src/lib/services/conversationPolicyService")).getActConversationPolicy(gameId);
  if (policy?.mode === "free_discussion_after_reading") {
    await updateGameSession(gameId, { currentPhase: "free_discussion", currentShareIndex: 0 });
    await runDmFlowStepAndMaybeAutoDiscussion({ gameSessionId: gameId, trigger: "enter_free_discussion", nextAction: "wait_for_user" });
    return;
  }

  await updateGameSession(gameId, {
    currentPhase: "share_round",
    currentShareIndex: 0
  });
  await runDmFlowStepAndMaybeAutoDiscussion({
    gameSessionId: gameId,
    trigger: "enter_share_round",
    nextAction: "advance_phase"
  });
  await runDmFlowStepAndMaybeAutoDiscussion({
    gameSessionId: gameId,
    trigger: "before_next_share",
    targetRoleId: getCurrentShareRoleId(
      findAct(script.acts, session.currentActId),
      {
        ...session,
        currentPhase: "share_round",
        currentShareIndex: 0
      }
    ),
    nextAction: "wait_for_user"
  });
}

async function areCurrentActAiInternalReadingsCompleted(gameId: string): Promise<boolean> {
  const session = await getGameSession(gameId);
  const memories = await Promise.all(
    session.aiRoleIds.map((roleId) => getRoleMemory(gameId, roleId))
  );

  return memories.every(
    (memory) => memory.internal_readings?.[session.currentActId]?.status === "completed"
  );
}

async function handleSelectRole(gameId: string, roleId: string): Promise<void> {
  await selectUserRole(gameId, roleId);
  await runDmFlowStepAndMaybeAutoDiscussion({
    gameSessionId: gameId,
    trigger: "enter_reading",
    nextAction: "wait_for_user"
  });
}

async function handleUserShare(gameId: string, content: string): Promise<void> {
  const session = await getGameSession(gameId);
  const script = await getScriptForGameSession(gameId);

  if (!session.userRoleId || !content.trim()) {
    return;
  }

  const message: Message = {
    message_id: `user_share_${Date.now()}`,
    speaker_type: "user",
    speaker_role_id: session.userRoleId,
    speaker_name: getRoleName(script, session.userRoleId),
    phase: "share_round",
    speech_act: "share",
    content: content.trim(),
    metadata: {
      revealed_facts: [],
      emotional_points: [],
      questions_raised: [],
      mentioned_role_ids: [],
      event_tags: [],
      topic_tags: []
    }
  };
  const act = findAct(script.acts, session.currentActId);

  const savedMessage = await persistMessage(gameId, message);
  const storyBoardResult = await enqueuePublicMessageForStoryBoard({
    gameSessionId: gameId,
    message: savedMessage
  });

  await runDiscussionAfterPublicMessage(gameId, savedMessage, storyBoardResult.immediatePatch);
  await advanceShareRound(gameId, act);
}

async function handleUserDiscussion(gameId: string, content: string): Promise<void> {
  const session = await getGameSession(gameId);
  const script = await getScriptForGameSession(gameId);

  if (!session.userRoleId || !content.trim()) {
    return;
  }

  const mentionedRoleIds = inferMentionedRoleIds(content.trim(), script, session.userRoleId);
  const message: Message = {
    message_id: `user_discussion_${Date.now()}`,
    speaker_type: "user",
    speaker_role_id: session.userRoleId,
    speaker_name: getRoleName(script, session.userRoleId),
    target_role_ids: mentionedRoleIds,
    phase: "free_discussion",
    speech_act: "question",
    content: content.trim(),
    metadata: {
      revealed_facts: [],
      emotional_points: [],
      questions_raised: [content.trim()],
      mentioned_role_ids: mentionedRoleIds,
      event_tags: [],
      topic_tags: []
    }
  };

  const savedMessage = await persistMessage(gameId, message);
  const storyBoardResult = await enqueuePublicMessageForStoryBoard({
    gameSessionId: gameId,
    message: savedMessage
  });

  await applyGameAction(gameId, { type: "USER_MESSAGE_ADDED" });
  await runDiscussionAfterPublicMessage(gameId, savedMessage, storyBoardResult.immediatePatch);
}

async function runDiscussionAfterPublicMessage(
  gameId: string,
  message: Message,
  latestStoryBoardPatch: StoryBoardPatch | null
): Promise<void> {
  try {
    await runAutoDiscussionAfterMessage({
      gameId,
      seedMessageId: message.message_id,
      latestStoryBoardPatch
    });
  } catch {
    // Auto discussion is secondary and must not block public messages.
  }
}

async function runDmFlowStepAndMaybeAutoDiscussion(
  input: RunDmFlowStepInput
): Promise<void> {
  const result = await runDmFlowStep(input);
  const message = result.autoExecutedMessage ?? result.message;

  if (!message || !shouldAutoReactToDmMessage(message)) {
    return;
  }

  try {
    await runAutoDiscussionAfterMessage({
      gameId: input.gameSessionId,
      seedMessageId: message.message_id
    });
  } catch {
    // Auto discussion is secondary and must not block DM flow.
  }
}

function shouldAutoReactToDmMessage(message: Message): boolean {
  return (
    message.speaker_type === "dm" &&
    (message.speech_act === "dm_directed_question" ||
      message.speech_act === "group_question" ||
      message.speech_act === "dm_prompt" ||
      (message.speech_act === "question" && (message.target_role_ids ?? []).length > 0) ||
      isDmTextQuestionOrDirectAddress(message.content))
  );
}

function isDmTextQuestionOrDirectAddress(content: string): boolean {
  return /[?？]|你怎么看|怎么看|你觉得|觉得呢|要不要|有没有|注意到|想问|补充|说说|说一下|聊聊|回答|回应|请.+说|请.+答|.+呢/.test(
    content
  );
}

async function handleNextAct(gameId: string): Promise<void> {
  const session = await getGameSession(gameId);
  if (session.runtimeDefinitionId) {
    await (await import("@/src/lib/services/dmLifecycleService")).advanceRuntimeTransition(gameId);
    return;
  }
  const script = await getScriptForGameSession(gameId);
  const afterDiscussion = transition(session, { type: "DISCUSSION_LIMIT_REACHED" });
  const afterDm = transition(afterDiscussion, { type: "DM_QUESTION_DONE" });
  const nextAct = script.acts[session.currentActIndex + 1];
  const nextSession = transition(afterDm, {
    type: "ACT_SUMMARY_DONE",
    nextActId: nextAct?.act_id
  });

  await runDmFlowStepAndMaybeAutoDiscussion({
    gameSessionId: gameId,
    trigger: "discussion_turn_limit_reached",
    nextAction: "advance_phase"
  });
  await updateGameSession(gameId, {
    currentPhase: "dm_question"
  });
  await runDmFlowStepAndMaybeAutoDiscussion({
    gameSessionId: gameId,
    trigger: "enter_dm_question",
    nextAction: "wait_for_user"
  });
  await updateGameSession(gameId, {
    currentPhase: "act_summary"
  });
  await runDmFlowStepAndMaybeAutoDiscussion({
    gameSessionId: gameId,
    trigger: "enter_act_summary",
    nextAction: "advance_phase"
  });
  await updateGameSession(gameId, {
    currentActId: nextSession.currentActId,
    currentPhase: nextSession.currentPhase,
    currentShareIndex: nextSession.currentShareIndex,
    userRoleId: nextSession.userRoleId,
    aiRoleIds: nextSession.aiRoleIds,
    discussionTurnCount: nextSession.discussionTurnCount,
    maxDiscussionTurns: nextSession.maxDiscussionTurns
  });
  await runDmFlowStepAndMaybeAutoDiscussion({
    gameSessionId: gameId,
    trigger: session.currentActIndex + 1 < session.totalActs ? "advance_to_next_act" : "finished",
    nextAction: session.currentActIndex + 1 < session.totalActs ? "wait_for_user" : "none"
  });
}

async function advanceShareRound(gameId: string, act: Act): Promise<void> {
  const session = await getGameSession(gameId);
  const nextShareIndex = getNextShareIndex(act, session, session.currentShareIndex + 1);
  const hasMore = nextShareIndex !== -1;
  const afterChecker = transition(session, {
    type: "AI_SHARE_PASSED_CHECKER",
    hasMoreAiToShare: hasMore
  });
  const nextSession = hasMore ? afterChecker : transition(afterChecker, { type: "ALL_AI_SHARED" });

  await updateGameSession(gameId, {
    currentActId: nextSession.currentActId,
    currentPhase: nextSession.currentPhase,
    currentShareIndex: hasMore ? nextShareIndex : nextSession.currentShareIndex,
    userRoleId: nextSession.userRoleId,
    aiRoleIds: nextSession.aiRoleIds,
    discussionTurnCount: nextSession.discussionTurnCount,
    maxDiscussionTurns: nextSession.maxDiscussionTurns
  });

  if (!hasMore) {
    await runDmFlowStepAndMaybeAutoDiscussion({
      gameSessionId: gameId,
      trigger: "all_shares_completed",
      nextAction: "wait_for_user"
    });
  } else {
    await runDmFlowStepAndMaybeAutoDiscussion({
      gameSessionId: gameId,
      trigger: "before_next_share",
      targetRoleId: act.share_order[nextShareIndex] ?? null,
      nextAction: "wait_for_user"
    });
  }
}

async function persistMessage(gameId: string, message: Message): Promise<Message> {
  return createMessage({
    gameSessionId: gameId,
    speakerType: message.speaker_type,
    speakerRoleId: message.speaker_role_id,
    speakerName: message.speaker_name,
    targetRoleIds: message.target_role_ids,
    replyToMessageId: message.reply_to_message_id,
    phase: message.phase,
    speechAct: message.speech_act,
    content: message.content,
    metadata: message.metadata
  });
}

function getCurrentShareRoleId(
  act: Act,
  session: Awaited<ReturnType<typeof getGameSession>>
): string | null {
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

function getRoleName(script: Script, roleId: string): string {
  return script.roles.find((role) => role.role_id === roleId)?.name ?? roleId;
}

function inferMentionedRoleIds(content: string, script: Script, speakerRoleId: string): string[] {
  return script.roles
    .filter((role) => role.role_id !== speakerRoleId)
    .filter((role) =>
      [role.role_id, role.name]
        .map((value) => value.trim())
        .filter(Boolean)
        .some((alias) => containsRoleAlias(content, alias))
    )
    .map((role) => role.role_id);
}

function containsRoleAlias(content: string, alias: string): boolean {
  if (/^[A-Za-z0-9_-]+$/.test(alias)) {
    return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(alias)}($|[^A-Za-z0-9_-])`, "i").test(content);
  }

  return content.includes(alias);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAct(acts: Act[], actId: string): Act {
  const act = acts.find((candidate) => candidate.act_id === actId);

  if (!act) {
    throw new Error(`Act "${actId}" was not found in script.`);
  }

  return act;
}

export const GET = playerRoute(handleGET);
export const POST = playerRoute(handlePOST);
