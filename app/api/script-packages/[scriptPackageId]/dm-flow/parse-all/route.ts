import { developerRoute } from "@/src/lib/access/routes";
import { NextResponse } from "next/server";
import { parseDMFlowForScriptPackage } from "@/src/lib/services/dmFlowService";
import { parseManualSemanticCandidate } from "@/src/lib/services/manualSemanticParseService";
import { z } from "zod";

const Input = z.object({ pipeline: z.enum(["legacy", "semantic_v2"]).default("semantic_v2"), documentId: z.string().optional(),
  scope: z.object({ actIndices: z.array(z.number().int().positive()).max(64).optional(), includeOpening: z.boolean().optional(), includeEnding: z.boolean().optional(), maxChunks: z.number().int().min(1).max(100).optional(), planOnly: z.boolean().optional(), planningParagraphEnd: z.number().int().nonnegative().optional(), planningWindowChars: z.number().int().min(500).max(6000).optional(), maxPlanningRequests: z.number().int().min(1).max(100).optional() }).optional() });

type RouteContext = {
  params: Promise<{
    scriptPackageId: string;
  }>;
};

async function handlePOST(request: Request, context: RouteContext) {
  const { scriptPackageId } = await context.params;

  try {
    const text = await request.text();
    const raw = text ? JSON.parse(text) : {};
    if (Array.isArray(raw?.scope?.actIndices) && raw.scope.actIndices.length > 64)
      return NextResponse.json({ error: "每次最多指定64个幕次。" }, { status: 400 });
    const parsed = Input.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: "解析请求参数不合法。" }, { status: 400 });
    const body = parsed.data;
    if (body.pipeline !== "legacy") {
      const candidate = await parseManualSemanticCandidate({ scriptPackageId, documentId: body.documentId, scope: body.scope });
      return NextResponse.json({ candidate, published: false }, { status: candidate.status === "failed" ? 422 : 200 });
    }
    return NextResponse.json({
      summary: await parseDMFlowForScriptPackage(scriptPackageId)
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "批量 DM 手册结构化解析失败。" },
      { status: 500 }
    );
  }
}

export const POST = developerRoute(handlePOST);
