import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { listManualCandidates } from "@/src/lib/services/manualSemanticParseService";

async function handleGET(_request: Request, context: { params: Promise<{ scriptPackageId: string }> }) {
  const { scriptPackageId } = await context.params;
  return NextResponse.json({ candidates: await listManualCandidates(scriptPackageId) });
}

export const GET = developerRoute(handleGET);
