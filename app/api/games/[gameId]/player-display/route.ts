import { playerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import {
  getPlayerDisplaySectionForReading,
  PlayerPdfReadingError
} from "@/src/lib/services/playerPdfReadingService";

type RouteContext = {
  params: Promise<{
    gameId: string;
  }>;
};

async function handleGET(request: NextRequest, context: RouteContext) {
  const { gameId } = await context.params;
  const actIndexParam = request.nextUrl.searchParams.get("actIndex");

  try {
    const view = await getPlayerDisplaySectionForReading({
      gameSessionId: gameId,
      roleName: request.nextUrl.searchParams.get("roleName"),
      actIndex: actIndexParam ? Number(actIndexParam) : null,
      sectionId: request.nextUrl.searchParams.get("sectionId")
    });
    const { localPath: _localPath, ...safeView } = view;

    return NextResponse.json(safeView);
  } catch (error) {
    return toErrorResponse(error);
  }
}

function toErrorResponse(error: unknown): NextResponse {
  if (error instanceof PlayerPdfReadingError) {
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }

  return NextResponse.json({ error: "读取玩家 PDF 读本失败。" }, { status: 500 });
}

export const GET = playerRoute(handleGET);
