import { developerRoute } from "@/src/lib/access/routes";
import { NextRequest, NextResponse } from "next/server";
import {
  createIngestionJob,
  listIngestionJobs
} from "@/src/lib/services/scriptPackageService";

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handleGET(_request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  return NextResponse.json({
    ingestionJobs: await listIngestionJobs(scriptPackageId)
  });
}

async function handlePOST(request: NextRequest, context: RouteContext) {
  const { scriptPackageId } = await context.params;
  const body = await readOptionalJson(request);
  const job = await createIngestionJob({
    scriptPackageId,
    inputJson: body.inputJson ?? body,
    stepNames: Array.isArray(body.stepNames)
      ? body.stepNames.filter((stepName): stepName is string => typeof stepName === "string")
      : undefined
  });

  return NextResponse.json(job, { status: 201 });
}

async function readOptionalJson(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();

    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export const GET = developerRoute(handleGET);
export const POST = developerRoute(handlePOST);
