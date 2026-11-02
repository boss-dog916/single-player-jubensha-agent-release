import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { hasActiveConversation } from "@/src/lib/services/conversationService";
import { hasActivePostShareTask } from "@/src/lib/services/postShareTaskService";
import { z } from "zod";
import { executeSelectedReactions } from "@/src/lib/orchestration/discussionOrchestrator";
import {
  runTracedInteraction,
  unwrapInteractionTraceError
} from "@/src/lib/observability/interactionTrace";
import { ReactionIntentSchema } from "@/src/lib/schemas/reactionIntentSchema";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import { scheduleStoryBoardDrain } from "@/src/lib/services/storyBoardQueueService";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

const ExecuteSelectedReactionsRequestSchema = z
  .object({
    latestMessageId: z.string().min(1),
    selectedReactions: z.array(ReactionIntentSchema).max(2)
  })
  .strict();

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  let traceId: string | null = null;

  try {
    if ((await hasActiveConversation(gameId)) || (await hasActivePostShareTask(gameId))) {
      return NextResponse.json({ error: "对话正在进行，不能重复执行旧反应计划。" }, { status: 409 });
    }
    const body = ExecuteSelectedReactionsRequestSchema.parse(await request.json());
    const traced = await runTracedInteraction({
      gameSessionId: gameId,
      action: "execute_selected_reactions",
      inputJson: body,
      callback: () =>
        executeSelectedReactions({
          gameSessionId: gameId,
          latestMessageId: body.latestMessageId,
          selectedReactions: body.selectedReactions
        })
    });
    traceId = traced.traceId;
    const response = NextResponse.json({
      ...(await getGameRuntimeSnapshot(gameId)),
      traceId
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
        error: unwrapped.error instanceof Error ? unwrapped.error.message : "执行 AI 反应失败。",
        traceId,
        snapshot: await getGameRuntimeSnapshot(gameId)
      },
      { status: 400 }
    );
  }
}

export const POST = developerRoute(handlePOST);
