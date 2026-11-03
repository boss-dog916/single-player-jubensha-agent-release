import { NextResponse } from "next/server";
import { cookieOptions, issueCredential, playerCookieName, safeMutation } from "@/src/lib/access/localCredentials";
import { boundedRequest, inputErrorResponse, RequestInputError } from "@/src/lib/access/requestLimits";
import { listPlayableScripts } from "@/src/lib/services/playerLibraryService";
import { createGameSession } from "@/src/lib/services/gameService";
import { runDmFlowStep } from "@/src/lib/agents/dmFlowRunner";

// Public creation grants access only to the newly created, normally scoped game.
// The existing developer API retains debug/test/range options behind its auth.
export async function POST(request: Request) {
  if (!safeMutation(request)) return NextResponse.json({ error: "请求来源无效。" }, { status: 403 });
  try {
    const body = await (await boundedRequest(request, { jsonBytes: 4096 })).json();
    if (!body || Array.isArray(body) || typeof body !== "object" ||
      Object.keys(body).some(k => !["scriptPackageId", "runtimeDefinitionId", "publicStoryBoardEnabled"].includes(k)) ||
      typeof body.scriptPackageId !== "string" || body.scriptPackageId.length > 100 ||
      body.runtimeDefinitionId !== undefined && body.runtimeDefinitionId !== null && typeof body.runtimeDefinitionId !== "string" ||
      body.publicStoryBoardEnabled !== undefined && typeof body.publicStoryBoardEnabled !== "boolean")
      return NextResponse.json({ error: "开局参数不合法。" }, { status: 400 });
    const script = (await listPlayableScripts()).find(s => s.id === body.scriptPackageId);
    if (!script || body.runtimeDefinitionId != null && body.runtimeDefinitionId !== script.runtimeDefinitionId)
      return NextResponse.json({ error: "剧本暂不可玩，请刷新剧本库。" }, { status: 404 });
    const session = await createGameSession({ scriptPackageId: script.id, runtimeDefinitionId: script.runtimeDefinitionId ?? undefined,
      publicStoryBoardEnabled: body.publicStoryBoardEnabled === true });
    await runDmFlowStep({ gameSessionId: session.gameId, trigger: "game_started", nextAction: "wait_for_user" });
    const response = NextResponse.json({ gameId: session.gameId }, { status: 201,
      headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
    response.cookies.set(playerCookieName(session.gameId), issueCredential("player", session.gameId), cookieOptions(request, 604_800));
    return response;
  } catch (error) {
    if (error instanceof RequestInputError) return inputErrorResponse(error);
    return NextResponse.json({ error: "暂时无法创建游戏，请稍后重试或联系维护者。" }, { status: 400 });
  }
}
