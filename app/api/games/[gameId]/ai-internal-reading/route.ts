import { playerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { runAiInternalReadingForAllAiPlayers } from "@/src/lib/agents/aiPlayerInternalReading";
import { runDmFlowStep } from "@/src/lib/agents/dmFlowRunner";
import { runTracedInteraction } from "@/src/lib/observability/interactionTrace";
import type { Act, RoleId } from "@/src/lib/script/scriptTypes";
import { getGameSession, updateGameSession } from "@/src/lib/services/gameService";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import { getRoleMemory } from "@/src/lib/services/roleMemoryService";
import { getScriptForGameSession } from "@/src/lib/services/scriptPackageService";
import { scheduleStoryBoardDrain } from "@/src/lib/services/storyBoardQueueService";
import { withConversation } from "@/src/lib/services/conversationService";
import { getActConversationPolicy } from "@/src/lib/services/conversationPolicyService";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

async function handlePOST(_request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  const traced = await runTracedInteraction({
    gameSessionId: gameId,
    action: "ai_internal_reading",
    inputJson: {},
    callback: async () => {
      const result = await runAiInternalReadingForAllAiPlayers(gameId);

      if (result.status === "completed") {
        await withConversation(gameId, "", () => advanceAfterReadingIfUserReady(gameId), true);
      }

      return result;
    }
  });
  const response = NextResponse.json({
    status: traced.value.status,
    result: { ...traced.value, results: traced.value.results.map(({ roleId, agentRunId, skipped }) => ({ roleId, agentRunId, skipped })) },
    traceId: traced.traceId,
    snapshot: await getGameRuntimeSnapshot(gameId)
  });
  response.headers.set("X-Trace-Id", traced.traceId);
  scheduleStoryBoardDrain(gameId);

  return response;
}

async function advanceAfterReadingIfUserReady(gameId: string): Promise<void> {
  const session = await getGameSession(gameId);
  const script = await getScriptForGameSession(gameId);

  if (session.currentPhase !== "reading" && session.currentPhase !== "ai_internal_reading") {
    return;
  }

  if (!session.userReadActIds.includes(session.currentActId)) {
    return;
  }

  const memories = await Promise.all(
    session.aiRoleIds.map((roleId) => getRoleMemory(gameId, roleId))
  );
  const allAiCompleted = memories.every(
    (memory) => memory.internal_readings?.[session.currentActId]?.status === "completed"
  );

  if (!allAiCompleted) {
    return;
  }

  const policy = await getActConversationPolicy(gameId);
  if (policy?.mode === "free_discussion_after_reading") {
    await updateGameSession(gameId, { currentPhase: "free_discussion", currentShareIndex: 0 });
    await runDmFlowStep({ gameSessionId: gameId, trigger: "enter_free_discussion", nextAction: "wait_for_user" });
    return;
  }

  await updateGameSession(gameId, {
    currentPhase: "share_round",
    currentShareIndex: 0
  });
  await runDmFlowStep({
    gameSessionId: gameId,
    trigger: "enter_share_round",
    nextAction: "advance_phase"
  });
  await runDmFlowStep({
    gameSessionId: gameId,
    trigger: "before_next_share",
    targetRoleId: getCurrentShareRoleId(findAct(script.acts, session.currentActId), {
      ...session,
      currentPhase: "share_round",
      currentShareIndex: 0
    }),
    nextAction: "wait_for_user"
  });
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

function findAct(acts: Act[], actId: string): Act {
  const act = acts.find((candidate) => candidate.act_id === actId);

  if (!act) {
    throw new Error(`Act "${actId}" was not found in script.`);
  }

  return act;
}

export const POST = playerRoute(handlePOST);
