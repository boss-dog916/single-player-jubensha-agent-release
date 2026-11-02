import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { hasActiveConversation, withConversation, conversationStage } from "@/src/lib/services/conversationService";
import { hasActivePostShareTask } from "@/src/lib/services/postShareTaskService";
import { runAutoDiscussionAfterMessage } from "@/src/lib/orchestration/autoDiscussionRunner";
import {
  runTracedInteraction,
  unwrapInteractionTraceError
} from "@/src/lib/observability/interactionTrace";
import {
  completeAndAdvanceCurrentDMNode,
  executeCurrentMainFlowNode,
  findTriggeredDMRules,
  jumpToDMFlowNode,
  resetDMFlowCursor
} from "@/src/lib/services/dmFlowCursorService";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import { scheduleStoryBoardDrain } from "@/src/lib/services/storyBoardQueueService";
import {
  clearSelectedReactionsDebugState,
  rebindGameSessionToLatestRuntimeDefinition,
  resetDiscussionBudget
} from "@/src/lib/services/gameSessionRecoveryService";
import type { Message } from "@/src/lib/types/game";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

type DebugAction =
  | "execute_current"
  | "complete_and_advance"
  | "check_conditional_rules"
  | "reset_cursor"
  | "reload_state"
  | "jump_to_node"
  | "rebind_latest_runtime_definition"
  | "clear_selected_reactions"
  | "reset_discussion_budget";

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  let traceId: string | null = null;

  try {
    const body = (await request.json()) as { action?: DebugAction; nodeId?: string };
    const presentation = (await (await import("@/src/lib/services/gameService")).getGameSession(gameId)).dmFlowCursor?.textPresentation;
    if (presentation && !presentation.confirmed && !["reload_state", "check_conditional_rules", "clear_selected_reactions"].includes(body.action ?? "")) {
      return NextResponse.json({ error: "演绎正在等待真人确认，请使用剧情演绎按钮。" }, { status: 409 });
    }
    if (body.action !== "reload_state" && ((await hasActiveConversation(gameId)) || (await hasActivePostShareTask(gameId)))) {
      return NextResponse.json({ error: "对话仍在进行，暂不能推进或重置状态。" }, { status: 409 });
    }
    const allowedActions: DebugAction[] = [
      "execute_current",
      "complete_and_advance",
      "check_conditional_rules",
      "reset_cursor",
      "reload_state",
      "jump_to_node",
      "rebind_latest_runtime_definition",
      "clear_selected_reactions",
      "reset_discussion_budget"
    ];

    if (!body.action || !allowedActions.includes(body.action)) {
      return NextResponse.json({ error: "未知 DMFlow debug action。" }, { status: 400 });
    }
    if (body.action === "jump_to_node" && !body.nodeId?.trim()) {
      return NextResponse.json({ error: "请输入要跳转的 DMFlow nodeId。" }, { status: 400 });
    }

    const traced = await runTracedInteraction({
      gameSessionId: gameId,
      action: `dm_flow:${body.action}`,
      inputJson: body,
      callback: async () => {
        const execute = async () => {
        let result: unknown = null;

        if (body.action === "reload_state") {
          result = { reloaded: true };
        } else if (body.action === "execute_current") {
          result = await executeCurrentMainFlowNode(gameId);
        } else if (body.action === "complete_and_advance") {
          result = await completeAndAdvanceCurrentDMNode(gameId);
        } else if (body.action === "check_conditional_rules") {
          result = await findTriggeredDMRules({ gameSessionId: gameId });
        } else if (body.action === "reset_cursor") {
          await resetDMFlowCursor(gameId);
          result = { reset: true };
        } else if (body.action === "jump_to_node") {
          result = await jumpToDMFlowNode(gameId, body.nodeId!.trim());
        } else if (body.action === "rebind_latest_runtime_definition") {
          result = await rebindGameSessionToLatestRuntimeDefinition(gameId);
        } else if (body.action === "clear_selected_reactions") {
          result = await clearSelectedReactionsDebugState();
        } else if (body.action === "reset_discussion_budget") {
          await resetDiscussionBudget(gameId);
          result = { resetDiscussionBudget: true };
        }

        const message = extractResultMessage(result);

        if (message && shouldAutoReactToDmMessage(message)) {
          await runAutoDiscussionAfterMessage({
            gameId,
            seedMessageId: message.message_id
          }).catch(() => null);
        }

        return result;
        };
        if (body.action === "reload_state") return execute();
        const leased = await withConversation(gameId, "", async () => {
          await conversationStage("dm");
          return { value: await execute() };
        }, true);
        if (!leased) throw new Error("对话状态已变化，暂不能推进或重置状态。");
        return leased.value;
      }
    });
    traceId = traced.traceId;
    const response = NextResponse.json({
      result: traced.value,
      traceId,
      snapshot: await getGameRuntimeSnapshot(gameId)
    });
    response.headers.set("X-Trace-Id", traceId);
    scheduleStoryBoardDrain(gameId);

    return response;
  } catch (error) {
    const unwrapped = unwrapInteractionTraceError(error);
    traceId = unwrapped.traceId ?? traceId;
    scheduleStoryBoardDrain(gameId);
    return NextResponse.json(
      {
        error: unwrapped.error instanceof Error ? unwrapped.error.message : "DMFlow debug action failed.",
        traceId,
        snapshot: await getGameRuntimeSnapshot(gameId).catch(() => null)
      },
      { status: 500 }
    );
  }
}

function extractResultMessage(result: unknown): Message | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }

  const record = result as { message?: unknown; autoExecutedMessage?: unknown };
  const message = record.autoExecutedMessage ?? record.message;

  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }

  const candidate = message as Partial<Message>;

  return typeof candidate.message_id === "string" &&
    typeof candidate.speaker_type === "string" &&
    typeof candidate.content === "string"
    ? (candidate as Message)
    : null;
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

export const POST = developerRoute(handlePOST);
