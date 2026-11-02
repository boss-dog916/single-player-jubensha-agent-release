import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  runAutoDiscussionAfterMessage,
  type DiscussionExecutionMode
} from "@/src/lib/orchestration/autoDiscussionRunner";
import {
  runTracedInteraction,
  unwrapInteractionTraceError
} from "@/src/lib/observability/interactionTrace";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import { scheduleStoryBoardDrain } from "@/src/lib/services/storyBoardQueueService";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

const AutoDiscussionRequestSchema = z
  .object({
    seedMessageId: z.string().min(1),
    mode: z.enum(["manual_debug", "auto_play"]).optional()
  })
  .strict();

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  let traceId: string | null = null;

  try {
    const body = AutoDiscussionRequestSchema.parse(await request.json());
    const traced = await runTracedInteraction({
      gameSessionId: gameId,
      action: "auto_discussion_after_message",
      inputJson: body,
      callback: () =>
        runAutoDiscussionAfterMessage({
          gameId,
          seedMessageId: body.seedMessageId,
          mode: body.mode as DiscussionExecutionMode | undefined
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
        error: unwrapped.error instanceof Error ? unwrapped.error.message : "自动 AI 讨论失败。",
        traceId,
        snapshot: await getGameRuntimeSnapshot(gameId)
      },
      { status: 400 }
    );
  }
}

export const POST = developerRoute(handlePOST);
