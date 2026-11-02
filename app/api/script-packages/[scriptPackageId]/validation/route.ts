import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import {
  getScriptPackage,
  validateAndStoreScriptPackage
} from "@/src/lib/services/scriptPackageService";
import { validateScriptPackageScript } from "@/src/lib/services/scriptPackageValidator";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;
  const scriptPackage = await getScriptPackage(scriptPackageId);

  return NextResponse.json({
    validation: scriptPackage.validation ?? validateScriptPackageScript(scriptPackage.script)
  });
}

async function handlePOST(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    validation: await validateAndStoreScriptPackage(scriptPackageId)
  });
}

export const GET = developerRoute(handleGET);
export const POST = developerRoute(handlePOST);
