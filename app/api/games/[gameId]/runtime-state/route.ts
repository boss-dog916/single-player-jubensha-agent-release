import { playerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { getGameRuntimeState } from "@/src/lib/services/gameSessionRecoveryService";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

async function handleGET(_request: Request, context: RouteContext) {
  const { gameId } = await context.params;

  try {
    return NextResponse.json(await getGameRuntimeState(gameId));
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "恢复 GameSession 失败。",
        restoreWarnings: [
          {
            code: "RESTORE_FAILED",
            severity: "error",
            message:
              error instanceof Error ? error.message : "恢复 GameSession 失败，请检查数据库和 RuntimeDefinition。"
          }
        ]
      },
      { status: 409 }
    );
  }
}

export const GET = playerRoute(handleGET);
