import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { parseRoleActBooklet } from "@/src/lib/services/roleActBookletService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  try {
    const body = (await request.json()) as {
      roleName?: string | null;
      actIndex?: number | null;
      sourceSectionId?: string | null;
    };

    return NextResponse.json({
      roleActBooklet: await parseRoleActBooklet({
        scriptPackageId,
        roleName: body.roleName,
        actIndex: body.actIndex,
        sourceSectionId: body.sourceSectionId
      })
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "角色本结构化解析失败。" },
      { status: 500 }
    );
  }
}

export const POST = developerRoute(handlePOST);
