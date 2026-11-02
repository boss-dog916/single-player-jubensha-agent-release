import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { listParsedDocuments } from "@/src/lib/ingestion/parsedDocumentService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    parsedDocuments: await listParsedDocuments(scriptPackageId)
  });
}

export const GET = developerRoute(handleGET);
