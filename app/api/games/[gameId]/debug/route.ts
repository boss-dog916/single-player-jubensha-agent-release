import { NextResponse } from "next/server";
import { developerRoute } from "@/src/lib/access/routes";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";
import { listRecentAgentRuns } from "@/src/lib/services/agentRunService";
export const GET = developerRoute(async (_request: Request, context: { params: Promise<{ gameId: string }> }) => {
  const { gameId } = await context.params;
  return NextResponse.json({ snapshot: await getGameRuntimeSnapshot(gameId), agentRuns: await listRecentAgentRuns(gameId, [], 24) });
});
