import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { compileScriptPackageToRuntimeDefinition } from "@/src/lib/services/scriptRuntimeDefinitionService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handlePOST(_request: Request, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  try {
    return NextResponse.json({
      summary: await compileScriptPackageToRuntimeDefinition(scriptPackageId)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成 RuntimeDefinition 失败。" },
      { status: 500 }
    );
  }
}

export const POST = developerRoute(handlePOST);
