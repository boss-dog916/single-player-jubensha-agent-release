import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { segmentRoleBookletTextActsByMarker } from "@/src/lib/ingestion/documentSectionService";

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
    if (typeof body.textAssetId !== "string" || !body.textAssetId.trim()) {
      return NextResponse.json({ error: "textAssetId is required." }, { status: 400 });
    }

    if (typeof body.commonEndMarker !== "string" || !body.commonEndMarker.trim()) {
      return NextResponse.json({ error: "commonEndMarker is required." }, { status: 400 });
    }

    return NextResponse.json(
      await segmentRoleBookletTextActsByMarker({
        scriptPackageId,
        roleName: typeof body.roleName === "string" ? body.roleName : decodeURIComponent(roleName),
        textAssetId: body.textAssetId,
        expectedActCount:
          body.expectedActCount === undefined || body.expectedActCount === null || body.expectedActCount === ""
            ? null
            : Number(body.expectedActCount),
        startActIndex: body.startActIndex === undefined ? 1 : Number(body.startActIndex),
        commonEndMarker: body.commonEndMarker
      })
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "DOCX AI 文本切分失败。" },
      { status: 400 }
    );
  }
}

export const POST = developerRoute(handlePOST);
