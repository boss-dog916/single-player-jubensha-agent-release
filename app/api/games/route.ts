import { toPlayerSnapshot } from "@/src/lib/access/playerView";
import { issueCredential, cookieOptions, playerCookieName } from "@/src/lib/access/localCredentials";
import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { runDmFlowStep } from "@/src/lib/agents/dmFlowRunner";
import { createGameSession } from "@/src/lib/services/gameService";
import { getGameRuntimeSnapshot } from "@/src/lib/services/gameRuntimeSnapshotService";

async function handlePOST(request: Request) {
  try {
    const body = await readOptionalJson(request);
    if (body.publicStoryBoardEnabled !== undefined && typeof body.publicStoryBoardEnabled !== "boolean") throw new Error("公共信息板设置必须为开启或关闭。");
    const session = await createGameSession({
      publicStoryBoardEnabled: body.publicStoryBoardEnabled === true,
      scriptPackageId:
        typeof body.scriptPackageId === "string" ? body.scriptPackageId : undefined,
      runtimeDefinitionId:
        typeof body.runtimeDefinitionId === "string" ? body.runtimeDefinitionId : undefined,
      testMode: body.testMode === true,
      runtimeMode: body.runtimeMode === "runtime_manual_debug" ? "runtime_manual_debug" : undefined,
      actRange: readActRange(body.actRange),
      roleNames: readRoleNames(body.roleNames)
    });

    await runDmFlowStep({
      gameSessionId: session.gameId,
      trigger: "game_started",
      nextAction: "wait_for_user"
    });

    const response = NextResponse.json(toPlayerSnapshot(await getGameRuntimeSnapshot(session.gameId)));
    response.cookies.set(playerCookieName(session.gameId), issueCredential("player", session.gameId), cookieOptions(request, 604_800));
    return response;
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to create game session."
      },
      { status: 400 }
    );
  }
}

function readActRange(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  return {
    start: typeof record.start === "number" ? record.start : undefined,
    end: typeof record.end === "number" ? record.end : undefined
  };
}

function readRoleNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}

async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();

    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const POST = developerRoute(handlePOST);
