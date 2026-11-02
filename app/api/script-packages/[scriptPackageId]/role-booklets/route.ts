import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { listRoleActBooklets } from "@/src/lib/services/roleActBookletService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: Request, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    roleActBooklets: await listRoleActBooklets(scriptPackageId)
  });
}

export const GET = developerRoute(handleGET);
