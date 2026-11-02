import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { parseUploadedAssetDocument } from "@/src/lib/ingestion/parsedDocumentService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
    assetId: string;
  }>;
};

async function handlePOST(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId, assetId } = await context.params;

  try {
    const parsedDocument = await parseUploadedAssetDocument({ scriptPackageId, assetId });

    return NextResponse.json(
      {
        parsedDocument,
        error:
          parsedDocument.parseStatus === "FAILED" ? parsedDocument.errorMessage : undefined
      },
      { status: parsedDocument.parseStatus === "FAILED" ? 422 : 200 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "文本抽取失败。"
      },
      { status: 400 }
    );
  }
}

export const POST = developerRoute(handlePOST);
