import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import { assertJsonLimits, RequestInputError, validateUploadForm } from "@/src/lib/access/requestLimits";
import {
  listUploadedAssets,
  normalizeUploadedAssetKind,
  normalizeUploadedAssetPurpose,
  uploadScriptAsset
} from "@/src/lib/services/scriptPackageService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    assets: await listUploadedAssets(scriptPackageId)
  });
}

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;
  const formData = await request.formData();
  validateUploadForm(formData);
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "A file field is required." }, { status: 400 });
  }

  const asset = await uploadScriptAsset({
    scriptPackageId,
    file,
    kind: normalizeUploadedAssetKind(formData.get("kind")),
    assetPurpose: normalizeUploadedAssetPurpose(formData.get("assetPurpose")),
    roleName: typeof formData.get("roleName") === "string" ? String(formData.get("roleName")) : null,
    metadataJson: parseOptionalJson(formData.get("metadataJson"))
  });

  return NextResponse.json(asset, { status: 201 });
}

function parseOptionalJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    assertJsonLimits(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof RequestInputError) throw error;
    return {
      raw: value,
      parseWarning: "metadataJson was not valid JSON."
    };
  }
}

export const GET = developerRoute(handleGET);
export const POST = developerRoute(handlePOST);
