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
  const runtimeDefinition = await getLatestScriptRuntimeDefinition(scriptPackageId);

  return NextResponse.json({
    validationReport: runtimeDefinition?.validationReport ?? null,
    storedValidationReport: runtimeDefinition?.storedValidationReport ?? null
  });
}

export const GET = developerRoute(handleGET);
