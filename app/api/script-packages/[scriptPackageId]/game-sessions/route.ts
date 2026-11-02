import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { listRecoverableGameSessions } from "@/src/lib/services/gameSessionRecoveryService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: Request, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    gameSessions: await listRecoverableGameSessions(scriptPackageId)
  });
}

export const GET = developerRoute(handleGET);
