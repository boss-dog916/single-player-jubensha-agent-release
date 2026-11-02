import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { getLatestScriptRuntimeDefinition } from "@/src/lib/services/scriptRuntimeDefinitionService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: Request, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    runtimeDefinition: await getLatestScriptRuntimeDefinition(scriptPackageId)
  });
}

export const GET = developerRoute(handleGET);
