import "server-only";
import { prisma } from "@/src/lib/db/prisma";
import { generateStructured } from "@/src/lib/llm/llmClient";
import { hasTaskApiKey, manualExtractorEnabled, resolveTaskModelProfile } from "@/src/lib/llm/taskModelProfiles";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { extractDocumentText, type ExtractedDocumentBlock } from "@/src/lib/ingestion/documentTextExtractor";
import { fromJsonValue, toJsonInput } from "./jsonFields";
import { locateSourceSpan } from "@/src/lib/ingestion/sourceRevisionService";
import { MANUAL_V2_VERSIONS as V, SemanticChunkOutputSchema, type ManualPlan, type SemanticManualV2, type SemanticValidation } from "@/src/lib/schemas/manualSemanticV2Schema";
import { buildManualContext, chunkManualPlan, combineSemanticChunks, compactChunkContext, makeValidation, type ChunkRecord, type ManualContext } from "./manualSemanticPipeline";
import { buildSemanticExtractionPrompt } from "@/src/lib/prompts/manualSemanticPrompt";
import { hierarchicalManualPlanning } from "./manualPlanningService";
import { buildManualRoleIdentity } from "./manualRoleIdentity";
import { compileSemanticManualV2, type CompiledManualCandidate } from "./manualSemanticV2Compiler";
import { validateScriptRuntimeDefinition, type RuntimeValidationReport, type ScriptRuntimeDefinitionJson } from "./scriptRuntimeDefinitionService";

export type ManualParseScope = { actIndices?: number[]; includeOpening?: boolean; includeEnding?: boolean; sectionId?: string; maxChunks?: number; planOnly?: boolean; planningParagraphEnd?: number; planningWindowChars?: number; maxPlanningRequests?: number; lastPlanningWindowIndex?: number };
export type ManualCandidateView = {
  id: string; scriptPackageId: string; format: "semantic_v2"; status: string; createdAt: string; updatedAt: string;
  sourceManifest: unknown; scope: ManualParseScope; plan: ManualPlan | null; planResponse: unknown; chunks: ChunkRecord[];
  semantic: SemanticManualV2 | null; semanticValidation: SemanticValidation | null; compiled: CompiledManualCandidate | null;
  runtimeValidation: RuntimeValidationReport | null; errorMessage: string | null;
};
export async function loadManualContext(scriptPackageId: string, documentId?: string): Promise<ManualContext> {
  const pkg = await prisma.scriptPackage.findUniqueOrThrow({ where: { id: scriptPackageId } });
  const docs = await prisma.parsedDocument.findMany({ where: { scriptPackageId, kind: "DM_MANUAL", isActive: true, ...(documentId ? { id: documentId } : {}) }, include: { uploadedAsset: true, documentSections: { where: { isActive: true } } }, orderBy: { createdAt: "asc" } });
  if (docs.length !== 1) throw new Error("请选择唯一的有效 DM 手册文档；不能静默选择或串接多个版本。");
  const doc = docs[0], text = doc.normalizedText || doc.extractedText;
  let blocks = fromJsonValue<ExtractedDocumentBlock[]>(doc.blocksJson, []);
  const rawPath = join(process.cwd(), doc.uploadedAsset.localPath);
  if (doc.uploadedAsset.originalName.toLowerCase().endsWith(".docx") && blocks.some(b => b.sourceParagraphIndex === undefined) && existsSync(rawPath)) {
    const extracted = await extractDocumentText({ filePath: rawPath, mimeType: doc.uploadedAsset.mimeType, originalName: doc.uploadedAsset.originalName });
    if (extracted.normalizedText !== text) throw new Error("原始 DOCX 与已保存 revision 文字不同，需先建立新来源 revision。");
    blocks = extracted.blocksJson ?? blocks;
  }
  const manifest = fromJsonValue<unknown>(pkg.scriptJson, {});
  const assets = await prisma.uploadedAsset.findMany({ where: { scriptPackageId, kind: "ROLE_BOOKLET" }, select: { id: true, roleName: true } });
  const roleIdentity = buildManualRoleIdentity(manifest, pkg.id, assets);
  const knownRoles = roleIdentity.canonicalRoles.map(role => ({ name: role.displayName,
    aliases: roleIdentity.verifiedAliases.filter(a => a.canonicalRoleId === role.id).map(a => a.alias) }));
  const sections = doc.documentSections.filter(s => s.sectionSetRevision === doc.sectionSetRevision).flatMap(s => {
    const span = fromJsonValue<{ start: number; end: number } | null>(s.sourceSpanJson, null) ?? locateSourceSpan(text, s.text);
    return span ? [{ id: s.id, ...span }] : [];
  });
  return buildManualContext({ documentId: doc.id, documentRevision: doc.documentRevision, sectionSetRevision: doc.sectionSetRevision,
    title: doc.uploadedAsset.originalName, text, blocks, knownRoles, roleIdentity, sections });
}

async function assertCandidateSource(context: ManualContext): Promise<void> {
  const fresh = await prisma.parsedDocument.findFirst({ where: { id: context.source.documentId, isActive: true,
    documentRevision: context.source.documentRevision, sectionSetRevision: context.source.sectionSetRevision } });
  if (!fresh || (fresh.normalizedText || fresh.extractedText) !== context.source.text) throw new Error("STALE_SOURCE: 候选解析期间原文或切分版本已改变，结果不可发布。");
}

export async function parseManualSemanticCandidate(input: { scriptPackageId: string; documentId?: string; scope?: ManualParseScope }): Promise<ManualCandidateView> {
  if (!hasTaskApiKey("manual_planner")) throw new Error("手册解析需要当前模型对应的 QWEN_API_KEY 或 BAILIAN_API_KEY；不会回退到游戏 Provider 或用 mock 冒充结果。");
  const scope = input.scope ?? {};
  const selectedSection = scope.sectionId ? await prisma.documentSection.findFirst({ where: { id: scope.sectionId, scriptPackageId: input.scriptPackageId, isActive: true, parsedDocument: { isActive: true, kind: "DM_MANUAL" } } }) : null;
  if (scope.sectionId && !selectedSection) throw new Error("选定 section 不属于当前有效 DM 手册。");
  const context = await loadManualContext(input.scriptPackageId, input.documentId ?? selectedSection?.parsedDocumentId);
  if (selectedSection && !context.source.sections.some(s => s.id === selectedSection.id)) throw new Error("选定 section 来源无法定位或已过期。");
  const planningEnd = scope.planningParagraphEnd ?? context.paragraphs.length - 1;
  if (!Number.isInteger(planningEnd) || planningEnd < 0 || planningEnd >= context.paragraphs.length) throw new Error("Invalid planning paragraph scope");
  const record = await prisma.manualParseCandidate.create({ data: { scriptPackageId: input.scriptPackageId,
    sourceManifestJson: toJsonInput({ ...context, versions: V, modelConfig: { planner: resolveTaskModelProfile("manual_planner"), extractor: resolveTaskModelProfile("manual_semantic_extractor") } }), scopeJson: toJsonInput(scope) } });
  const chunks: ChunkRecord[] = [];
  let plan: ManualPlan | null = null;
  const plannerStartedAt = Date.now();
  let rawPlan: unknown = { versions: V, profile: resolveTaskModelProfile("manual_planner"), startedAt: new Date(plannerStartedAt).toISOString() };
  try {
    const planning = await hierarchicalManualPlanning(context, planningEnd, { targetChars: scope.planningWindowChars ?? 1800, maxRequests: scope.maxPlanningRequests, lastWindowIndex: scope.lastPlanningWindowIndex }, {
      assertSource: () => assertCandidateSource(context), persist: async artifact => { rawPlan = artifact; await prisma.manualParseCandidate.update({ where: { id: record.id }, data: { planJson: toJsonInput({ response: artifact, plan: null }) } }); }
    });
    rawPlan = planning.artifact; plan = planning.plan;
    const planValidation = planning.validation;
    if (!plan) {
      await assertCandidateSource(context);
      await prisma.manualParseCandidate.update({ where: { id: record.id }, data: { status: "needs_attention", planJson: toJsonInput({ plan: null, response: rawPlan }), semanticValidationJson: toJsonInput(planValidation), errorMessage: planValidation.errors.map(e => `${e.code}: ${e.message}`).join("; ") } });
      return (await getManualCandidate(record.id, input.scriptPackageId))!;
    }
    await assertCandidateSource(context);
    await prisma.manualParseCandidate.update({ where: { id: record.id }, data: { status: "extracting", planJson: toJsonInput({ plan, response: rawPlan }), semanticValidationJson: toJsonInput(planValidation) } });
    const section = scope.sectionId ? context.source.sections.find(s => s.id === scope.sectionId) : null;
    if (scope.sectionId && !section) throw new Error("选定 section 不属于当前有效 DM 手册。");
    const selected = chunkManualPlan(context, plan).filter(c => !section || c.start < section.end && c.end > section.start).filter(c =>
      !scope.actIndices || c.region.semanticSectionType === "act" && c.region.actIndex !== null && scope.actIndices.includes(c.region.actIndex) || c.region.semanticSectionType === "opening" && scope.includeOpening || c.region.semanticSectionType === "ending" && scope.includeEnding);
    const prioritized = selected;
    const bounded = scope.planOnly ? [] : prioritized.slice(0, scope.maxChunks ?? selected.length);
    if (bounded.length && !manualExtractorEnabled()) throw new Error("Manual Extractor 尚未启用：先完成百炼小 region benchmark，再设置 BAILIAN_MANUAL_EXTRACTOR_ENABLED=true。");
    for (const chunk of bounded) {
      await assertCandidateSource(context);
      const previous = chunks.filter(r => r.chunk.region.regionId === chunk.region.regionId).at(-1);
      const messages = buildSemanticExtractionPrompt(context, plan, chunk, previous ? compactChunkContext(previous) : "first chunk of this region");
      const chunkStartedAt = Date.now();
      const entry: ChunkRecord = { chunk, output: null, messages, requestConfig: resolveTaskModelProfile("manual_semantic_extractor"), startedAt: new Date(chunkStartedAt).toISOString(), trace: [] };
      chunks.push(entry);
      try {
        const result = await generateStructured({ agentType: "manual_semantic_parser_v2", phase: "ingestion", schemaName: "manual_semantic_chunk_v2", zodSchema: SemanticChunkOutputSchema,
          taskProfile: "manual_semantic_extractor", messages, maxRetries: 0, metadata: { candidateId: record.id, chunkId: chunk.id, versions: V },
          onTrace: event => { entry.trace!.push(event); },
          onRawResponse: async raw => { Object.assign(entry, { rawText: raw.text, model: raw.model, latencyMs: raw.latencyMs, retryCount: raw.retryCount, usage: raw.usage,
            finishReason: raw.finishReason, reasoningChars: raw.reasoningChars, requestConfig: raw.requestConfig ?? entry.requestConfig });
            await prisma.manualParseCandidate.update({ where: { id: record.id }, data: { chunksJson: toJsonInput(chunks) } }); } });
        Object.assign(entry, { output: result.data, rawText: result.rawText, model: result.model, latencyMs: result.latencyMs });
      } catch (e) { entry.error = e instanceof Error ? e.message : String(e); }
      entry.completedAt = new Date().toISOString(); entry.latencyMs = Date.now() - chunkStartedAt;
      await prisma.manualParseCandidate.update({ where: { id: record.id }, data: { chunksJson: toJsonInput(chunks) } });
      // Stop on provider/schema failure rather than spend the remaining budget repeating an unhealthy request.
      if (entry.error) break;
    }
    const combined = combineSemanticChunks(context, plan, chunks);
    combined.validation = makeValidation([...combined.validation.errors, ...combined.validation.warnings, ...planValidation.errors.filter(e => e.code.startsWith("GLOBAL_"))]);
    if (chunks.length !== chunkManualPlan(context, plan).length) {
      const partial = { code: "PARTIAL_EXTRACTION", severity: "error" as const, message: `Extracted ${chunks.length} of ${chunkManualPlan(context, plan).length} chunks; candidate only, not full-manual playable`, repairCandidate: false };
      combined.validation = makeValidation([...combined.validation.errors, ...combined.validation.warnings, partial]);
    }
    const compiled = compileSemanticManualV2(combined.semantic, combined.validation);
    const runtimeValidation = await validateCandidateRuntime(input.scriptPackageId, compiled);
    await assertCandidateSource(context);
    await prisma.manualParseCandidate.update({ where: { id: record.id }, data: { status: combined.validation.status === "valid" && runtimeValidation.status !== "invalid" ? "candidate" : "needs_attention",
      semanticJson: toJsonInput(combined.semantic), semanticValidationJson: toJsonInput(combined.validation), compiledJson: toJsonInput(compiled), runtimeValidationJson: toJsonInput(runtimeValidation) } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!plan) rawPlan = { ...rawPlan as object, attemptLatencyMs: Date.now() - plannerStartedAt, error: message };
    await prisma.manualParseCandidate.update({ where: { id: record.id }, data: { status: message.includes("STALE_SOURCE") ? "stale" : "failed", errorMessage: message,
      planJson: toJsonInput({ plan, response: rawPlan }), chunksJson: toJsonInput(chunks), semanticValidationJson: toJsonInput(makeValidation([{ code: "PIPELINE_FAILURE", severity: "error", message, repairCandidate: true }])) } });
  }
  return (await getManualCandidate(record.id, input.scriptPackageId))!;
}

export async function validateCandidateRuntime(scriptPackageId: string, compiled: CompiledManualCandidate): Promise<RuntimeValidationReport> {
  const pkg = await prisma.scriptPackage.findUniqueOrThrow({ where: { id: scriptPackageId } });
  const latest = await prisma.scriptRuntimeDefinition.findFirst({ where: { scriptPackageId }, orderBy: { version: "desc" } });
  const base = latest ? fromJsonValue<ScriptRuntimeDefinitionJson>(latest.definitionJson, {} as ScriptRuntimeDefinitionJson) : null;
  const definition: ScriptRuntimeDefinitionJson = { scriptPackageId, title: pkg.title, endingMode: "story_reconstruction", roles: base?.roles ?? [], roleBooklets: base?.roleBooklets ?? [], playerDisplay: base?.playerDisplay ?? [], clues: base?.clues ?? [],
    safety: base?.safety ?? { aiPlayerReadScope: "own_role_current_and_unlocked_acts_only", playerReadScope: "own_role_pdf_current_and_unlocked_acts_only", dmOutputScope: "current_stage_public_safe_only", publicStoryBoardSource: "public_messages_only" },
    sourceRefs: base?.sourceRefs ?? { roleBookletIds: [], playerDisplaySectionIds: [], uploadedAssetIds: [] },
    compileMeta: { compiledAt: new Date().toISOString(), compilerVersion: 3, warnings: ["Candidate-only: support data read from frozen definition, not a new publication"] }, acts: compiled.acts, dmFlow: compiled.dmFlow };
  const report = validateScriptRuntimeDefinition(definition);
  for (const message of compiled.needsAttention) report.errors.push({ code: "SEMANTIC_NEEDS_ATTENTION", severity: "error", message });
  if (report.errors.length) report.status = "invalid";
  return report;
}

export async function getManualCandidate(id: string, scriptPackageId: string): Promise<ManualCandidateView | null> {
  const row = await prisma.manualParseCandidate.findFirst({ where: { id, scriptPackageId } });
  if (!row) return null;
  const planData = fromJsonValue<{ plan: ManualPlan | null; response: unknown }>(row.planJson, { plan: null, response: null });
  const manifest = fromJsonValue<{ source?: { documentId: string; documentRevision: number; sectionSetRevision: number } }>(row.sourceManifestJson, {});
  const source = manifest.source;
  const active = source && await prisma.parsedDocument.findFirst({ where: { id: source.documentId, isActive: true, documentRevision: source.documentRevision, sectionSetRevision: source.sectionSetRevision } });
  return { id: row.id, scriptPackageId, format: "semantic_v2", status: active ? row.status : "stale", createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    sourceManifest: fromJsonValue(row.sourceManifestJson, null), scope: fromJsonValue(row.scopeJson, {}), plan: planData.plan, planResponse: planData.response,
    chunks: fromJsonValue(row.chunksJson, []), semantic: fromJsonValue(row.semanticJson, null), semanticValidation: fromJsonValue(row.semanticValidationJson, null),
    compiled: fromJsonValue(row.compiledJson, null), runtimeValidation: fromJsonValue(row.runtimeValidationJson, null), errorMessage: row.errorMessage };
}
export async function listManualCandidates(scriptPackageId: string): Promise<ManualCandidateView[]> {
  const rows = await prisma.manualParseCandidate.findMany({ where: { scriptPackageId }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true } });
  const result: ManualCandidateView[] = [];
  for (const row of rows) { const candidate = await getManualCandidate(row.id, scriptPackageId); if (candidate) result.push(candidate); }
  return result;
}
