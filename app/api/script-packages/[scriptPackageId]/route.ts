import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import {
  deleteScriptPackage,
  getScriptPackageDetail,
  normalizeScriptPackageStatus,
  updateScriptPackage
} from "@/src/lib/services/scriptPackageService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json(await getScriptPackageDetail(scriptPackageId));
}

async function handlePATCH(request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;
  const body = (await request.json()) as {
    slug?: string | null;
    title?: string;
    description?: string | null;
    status?: string;
    scriptJson?: unknown;
    sourceMetaJson?: unknown;
  };

  return NextResponse.json(
    await updateScriptPackage(scriptPackageId, {
      slug: body.slug,
      title: body.title,
      description: body.description,
      status: body.status ? normalizeScriptPackageStatus(body.status) : undefined,
      scriptJson: body.scriptJson,
      sourceMetaJson: body.sourceMetaJson
    })
  );
}

async function handleDELETE(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  await deleteScriptPackage(scriptPackageId);

  return NextResponse.json({ ok: true });
}

export const GET = developerRoute(handleGET);
export const PATCH = developerRoute(handlePATCH);
export const DELETE = developerRoute(handleDELETE);
