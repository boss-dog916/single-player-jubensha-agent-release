import { NextResponse } from "next/server";
import { developerRoute } from "@/src/lib/access/routes";
import { issueCredential, cookieOptions, playerCookieName } from "@/src/lib/access/localCredentials";
import { prisma } from "@/src/lib/db/prisma";
export const POST = developerRoute(async (request: Request, context: { params: Promise<{ gameId: string }> }) => {
  const { gameId } = await context.params;
  if (!await prisma.gameSession.findUnique({ where: { id: gameId }, select: { id: true } })) return NextResponse.json({ error: "游戏不存在。" }, { status: 404 });
  const response = NextResponse.json({ entryUrl: `${new URL(request.url).origin}/games/${gameId}#access=${issueCredential("entry", gameId)}` },
    { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  response.cookies.set(playerCookieName(gameId), issueCredential("player", gameId), cookieOptions(request, 604_800)); return response;
});
