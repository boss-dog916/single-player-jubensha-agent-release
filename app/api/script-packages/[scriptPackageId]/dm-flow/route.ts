import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { getDMFlow } from "@/src/lib/services/dmFlowService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: Request, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    dmFlow: await getDMFlow(scriptPackageId)
  });
}

export const GET = developerRoute(handleGET);
