import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { segmentRoleActsManually } from "@/src/lib/ingestion/documentSectionService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
    parsedDocumentId: string;
  }>;
};

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { scriptPackageId, parsedDocumentId } = await context.params;
  const body = await request.json().catch(() => ({}));

  try {
    return NextResponse.json(
      await segmentRoleActsManually({
        scriptPackageId,
        parsedDocumentId,
        manual: {
          roleName: typeof body.roleName === "string" ? body.roleName : null,
          actStartPages: Array.isArray(body.actStartPages) ? body.actStartPages : []
        }
      })
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "手动幕切分失败。" },
      { status: 400 }
    );
  }
}

export const POST = developerRoute(handlePOST);
