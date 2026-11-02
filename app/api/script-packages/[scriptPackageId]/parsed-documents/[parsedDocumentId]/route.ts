import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { getParsedDocument } from "@/src/lib/ingestion/parsedDocumentService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
    parsedDocumentId: string;
  }>;
};

async function handleGET(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId, parsedDocumentId } = await context.params;

  return NextResponse.json({
    parsedDocument: await getParsedDocument(scriptPackageId, parsedDocumentId)
  });
}

export const GET = developerRoute(handleGET);
