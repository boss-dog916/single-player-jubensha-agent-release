import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { segmentRoleBookletManualActs } from "@/src/lib/ingestion/documentSectionService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
    roleName: string;
  }>;
};

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { scriptPackageId, roleName } = await context.params;
  const body = await request.json().catch(() => ({}));

  try {
    if (typeof body.displayAssetId !== "string" || !body.displayAssetId.trim()) {
      return NextResponse.json({ error: "displayAssetId is required." }, { status: 400 });
    }

    return NextResponse.json(
      await segmentRoleBookletManualActs({
        scriptPackageId,
        roleName: typeof body.roleName === "string" ? body.roleName : decodeURIComponent(roleName),
        displayAssetId: body.displayAssetId,
        textAssetId: typeof body.textAssetId === "string" && body.textAssetId.trim() ? body.textAssetId : null,
        actStartPages: Array.isArray(body.actStartPages) ? body.actStartPages : []
      })
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "角色剧本手动分幕失败。" },
      { status: 400 }
    );
  }
}

export const POST = developerRoute(handlePOST);
