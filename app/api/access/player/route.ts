import { NextResponse } from "next/server";
import { prisma } from "@/src/lib/db/prisma";
import { verifyCredential, issueCredential, playerCookieName, cookieOptions, safeMutation } from "@/src/lib/access/localCredentials";
import { boundedRequest, inputErrorResponse, RequestInputError } from "@/src/lib/access/requestLimits";
export async function POST(request: Request) {
  if (!safeMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  try {
    const { gameId, token } = await (await boundedRequest(request, { jsonBytes: 4096 })).json();
    if (typeof gameId !== "string" || typeof token !== "string" || !verifyCredential(token, "entry", gameId) ||
      !await prisma.gameSession.findUnique({ where: { id: gameId }, select: { id: true } })) throw new Error();
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    response.cookies.set(playerCookieName(gameId), issueCredential("player", gameId), cookieOptions(request, 604_800)); return response;
  } catch (error) {
    if (error instanceof RequestInputError) return inputErrorResponse(error);
    return NextResponse.json({ error: "进入链接无效或已过期，请让开发者重新生成。" }, { status: 401 });
  }
}
