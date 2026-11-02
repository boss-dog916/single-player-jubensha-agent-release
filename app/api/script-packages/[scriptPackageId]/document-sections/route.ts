import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { listDocumentSections } from "@/src/lib/ingestion/documentSectionService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;
  const { searchParams } = new URL(request.url);

  return NextResponse.json({
    documentSections: await listDocumentSections({
      scriptPackageId,
      uploadedAssetId: searchParams.get("uploadedAssetId"),
      parsedDocumentId: searchParams.get("parsedDocumentId")
    })
  });
}

export const GET = developerRoute(handleGET);
