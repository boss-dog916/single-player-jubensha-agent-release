import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { parseAllRoleActBookletsForScriptPackage } from "@/src/lib/services/roleActBookletService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handlePOST(_request: Request, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  try {
    return NextResponse.json({
      summary: await parseAllRoleActBookletsForScriptPackage(scriptPackageId)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "批量角色本结构化解析失败。" },
      { status: 500 }
    );
  }
}

export const POST = developerRoute(handlePOST);
