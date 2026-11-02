import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/src/lib/db/prisma";
import { ReadingMetadataSchema } from "@/src/lib/services/runtimeReadingSources";
import { deleteUploadedAsset } from "@/src/lib/services/scriptPackageService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
    assetId: string;
  }>;
};

async function handleDELETE(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId, assetId } = await context.params;

  try {
    await deleteUploadedAsset({ scriptPackageId, assetId });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除资料失败。" },
      { status: 400 }
    );
  }
}

export const DELETE = developerRoute(handleDELETE);

// Changes only authoring metadata; existing frozen RuntimeDefinitions are untouched.
async function handlePATCH(request: NextRequest, context: RouteContext) {
  const { scriptPackageId, assetId } = await context.params;
  try {
    const reading = ReadingMetadataSchema.parse((await request.json()).reading);
    const asset = await prisma.uploadedAsset.findFirst({ where: { id: assetId, scriptPackageId, kind: "ROLE_BOOKLET" } });
    if (!asset) return NextResponse.json({ error: "Role booklet asset not found" }, { status: 404 });
    const prior = JSON.parse(asset.metadataJson ?? "{}");
    await prisma.uploadedAsset.update({ where: { id: asset.id }, data: { metadataJson: JSON.stringify({ ...prior, reading }) } });
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ error: "Invalid reading metadata" }, { status: 400 }); }
}
export const PATCH = developerRoute(handlePATCH);
