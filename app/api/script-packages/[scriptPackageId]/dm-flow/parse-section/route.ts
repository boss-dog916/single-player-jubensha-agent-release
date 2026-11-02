import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { parseDMSectionToFlowNodes } from "@/src/lib/services/dmFlowService";
import { parseManualSemanticCandidate } from "@/src/lib/services/manualSemanticParseService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  try {
    const body = (await request.json()) as {
      sectionId?: string | null;
      pipeline?: "legacy" | "semantic_v2";
    };

    if (!body.sectionId) {
      return NextResponse.json({ error: "缺少 sectionId。" }, { status: 400 });
    }

    if (body.pipeline !== "legacy") {
      const candidate = await parseManualSemanticCandidate({ scriptPackageId, scope: { sectionId: body.sectionId } });
      return NextResponse.json({ candidate, published: false }, { status: candidate.status === "failed" ? 422 : 200 });
    }

    return NextResponse.json({
      dmFlow: await parseDMSectionToFlowNodes({
        scriptPackageId,
        sectionId: body.sectionId
      })
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "单段 DM 手册结构化解析失败。" },
      { status: 500 }
    );
  }
}

export const POST = developerRoute(handlePOST);
