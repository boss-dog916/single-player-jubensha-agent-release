import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { segmentParsedDocument } from "@/src/lib/ingestion/documentSectionService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
    parsedDocumentId: string;
  }>;
};

async function handlePOST(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId, parsedDocumentId } = await context.params;

  try {
    return NextResponse.json(
      await segmentParsedDocument({
        scriptPackageId,
        parsedDocumentId
      })
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "章节切分失败。" },
      { status: 400 }
    );
  }
}

export const POST = developerRoute(handlePOST);
