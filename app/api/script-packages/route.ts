import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import {
  createScriptPackage,
  listScriptPackageSummaries,
  normalizeScriptPackageStatus
} from "@/src/lib/services/scriptPackageService";
import { loadScript } from "@/src/lib/script/loadScript";

async function handleGET(_request: Request) {
  const packages = await listScriptPackageSummaries();

  return NextResponse.json({
    scriptPackages: packages
  });
}

async function handlePOST(request: NextRequest) {
  const body = (await request.json()) as {
    slug?: string | null;
    title?: string | null;
    description?: string | null;
    status?: string;
    scriptJson?: unknown;
    validationJson?: unknown;
    sourceMetaJson?: unknown;
  };

  const scriptJson = body.scriptJson ?? createScriptTemplate(body.title, body.description);

  const scriptPackage = await createScriptPackage({
    slug: body.slug,
    title: body.title,
    description: body.description,
    status: normalizeScriptPackageStatus(body.status),
    scriptJson,
    validationJson: body.validationJson,
    sourceMetaJson: body.sourceMetaJson
  });

  return NextResponse.json(
    {
      id: scriptPackage.id,
      slug: scriptPackage.slug,
      title: scriptPackage.title,
      description: scriptPackage.description,
      status: scriptPackage.status,
      validation: scriptPackage.validation,
      sourceMeta: scriptPackage.sourceMeta,
      createdAt: scriptPackage.createdAt,
      updatedAt: scriptPackage.updatedAt
    },
    { status: 201 }
  );
}

function createScriptTemplate(title?: string | null, description?: string | null) {
  const demo = loadScript();
  const safeTitle = title?.trim() || "新剧本包";

  return {
    ...demo,
    script_id: `draft_${Date.now()}`,
    title: safeTitle,
    summary: description?.trim() || "待补充剧本简介。"
  };
}

export const GET = developerRoute(handleGET);
export const POST = developerRoute(handlePOST);
