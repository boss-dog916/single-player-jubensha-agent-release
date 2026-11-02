import "server-only";

import { DMFlowParseStatus, IngestionJobStatus, type DMFlow } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import { generateStructured } from "@/src/lib/llm/llmClient";
import { buildDMFlowSectionPrompt } from "@/src/lib/prompts/dmFlowPrompt";
import {
  DMFlowSectionOutputSchema,
  type DMFlowNode,
  type DMFlowSectionOutput
} from "@/src/lib/schemas/dmFlowSchema";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import { sectionEvidence, saveDMArtifact, archiveLegacyAggregate } from "@/src/lib/ingestion/sourceRevisionService";
import { ManualSemanticActSchema, type ManualSemanticAct, type SourceEvidence } from "@/src/lib/schemas/manualSemanticSchema";

const DM_SECTION_TYPES = ["dm_opening", "dm_act", "dm_ending"] as const;
const DM_FLOW_PARSE_TIMEOUT_MS = 180_000;
const DM_FLOW_SECTION_CHUNK_CHAR_LIMIT = 4_500;
type DMSectionType = (typeof DM_SECTION_TYPES)[number];

export type DMFlowActFlow = {
  actIndex: number;
  title?: string;
  nodes: DMFlowNode[];
  warnings: string[];
  sourceSectionId: string;
  sourceEvidence?: SourceEvidence;
};

export type DMFlowSectionResult = {
  sourceSectionId: string;
  sectionType: DMSectionType;
  actIndex: number | null;
  title: string;
  status: "success" | "failed";
  warningCount: number;
  warnings: string[];
  parseError?: string | null;
  parsedAt: string;
};

export type DMFlowView = {
  id: string;
  scriptPackageId: string;
  openingNodes: DMFlowNode[];
  actFlows: DMFlowActFlow[];
  endingNodes: DMFlowNode[];
  sectionResults: DMFlowSectionResult[];
  parseStatus: DMFlowParseStatus;
  parseError: string | null;
  warnings: string[];
  createdAt: Date;
  updatedAt: Date;
  format: "legacy_nodes" | "semantic_v1" | "mixed";
  semanticActs: ManualSemanticAct[];
  artifactAudit: Array<{ id: string; status: string; source: Partial<SourceEvidence> }>;
};

export type DMFlowParseSummary = {
  openingStatus: "missing" | "success" | "failed" | "not_parsed";
  endingStatus: "missing" | "success" | "failed" | "not_parsed";
  actFlowsCount: number;
  successCount: number;
  failedCount: number;
  warnings: string[];
  results: DMFlowSectionResult[];
};

export async function getDMFlow(scriptPackageId: string): Promise<DMFlowView | null> {
  const record = await prisma.dMFlow.findUnique({
    where: { scriptPackageId }
  });

  if (!record) return null;
  const view = toDMFlowView(record);
  const sections = await prisma.documentSection.findMany({ where: { scriptPackageId, isActive: true, parsedDocument: { isActive: true } }, include: { parsedDocument: true } });
  const active = new Map(sections.filter(s => s.sectionSetRevision === s.parsedDocument.sectionSetRevision).map(s => [s.id, s]));
  const artifacts = await prisma.dMParseArtifact.findMany({ where: { scriptPackageId }, orderBy: { createdAt: "asc" } });
  view.artifactAudit = artifacts.map(a => {
    const source = fromJsonValue<SourceEvidence>(a.sourceJson, {} as SourceEvidence);
    const section = active.get(a.sourceSectionId);
    const valid = section && source.sourceDocumentId === section.parsedDocumentId && source.sourceRevision === section.parsedDocument.documentRevision && source.sectionSetRevision === section.sectionSetRevision;
    return { id: a.id, source, status: a.status === "active" && !valid ? "stale" : a.status };
  });
  const current = artifacts.filter(a => view.artifactAudit.find(x => x.id === a.id)?.status === "active");
  const artifactSections = new Set(current.map(a => a.sourceSectionId));
  for (const flow of view.actFlows) if (!artifactSections.has(flow.sourceSectionId)) {
    const section = active.get(flow.sourceSectionId);
    view.artifactAudit.push({ id: `legacy:${flow.sourceSectionId}`, status: section ? "active_legacy" : "stale",
      source: { sourceSectionId: flow.sourceSectionId, sourceDocumentId: section?.parsedDocumentId,
        sourceRevision: section?.parsedDocument.documentRevision, sectionSetRevision: section?.sectionSetRevision,
        parserVersion: "legacy_unknown", promptVersion: "legacy_unknown" } });
  }
  const orphanCount = view.actFlows.filter(f => !active.has(f.sourceSectionId)).length;
  view.actFlows = view.actFlows.filter(f => active.has(f.sourceSectionId) && !artifactSections.has(f.sourceSectionId));
  view.sectionResults = view.sectionResults.filter(r => active.has(r.sourceSectionId));
  for (const artifact of current) {
    const output = fromJsonValue<DMFlowSectionOutput>(artifact.outputJson, {} as DMFlowSectionOutput);
    const source = fromJsonValue<SourceEvidence>(artifact.sourceJson, {} as SourceEvidence);
    if (artifact.semanticJson) view.semanticActs.push(ManualSemanticActSchema.parse(JSON.parse(artifact.semanticJson)));
    const nodes = (output.nodes ?? []).map(n => ({ ...n, sourceEvidence: source }));
    if (output.sectionType === "dm_act" && !artifact.semanticJson) view.actFlows.push({ actIndex: output.actIndex!, title: output.title ?? undefined, nodes, warnings: output.warnings ?? [], sourceSectionId: artifact.sourceSectionId, sourceEvidence: source });
    if (output.sectionType === "dm_opening") view.openingNodes = nodes;
    if (output.sectionType === "dm_ending") view.endingNodes = nodes;
  }
  // Old opening/ending arrays lack their own source ID. Do not carry them across a new set merely because its section type matches.
  const legacyResults = toDMFlowView(record).sectionResults;
  const canUseLegacyGroup = (type: "dm_opening" | "dm_ending") => {
    const results = legacyResults.filter(r => r.sectionType === type);
    return results.length ? results.some(r => active.has(r.sourceSectionId))
      : sections.some(s => s.sectionType === type && s.sectionSetRevision === 1 && s.parsedDocument.documentRevision === 1);
  };
  if (!canUseLegacyGroup("dm_opening") && !current.some(a => fromJsonValue<DMFlowSectionOutput>(a.outputJson, {} as DMFlowSectionOutput).sectionType === "dm_opening")) view.openingNodes = [];
  if (!canUseLegacyGroup("dm_ending") && !current.some(a => fromJsonValue<DMFlowSectionOutput>(a.outputJson, {} as DMFlowSectionOutput).sectionType === "dm_ending")) view.endingNodes = [];
  view.format = view.semanticActs.length ? view.actFlows.length ? "mixed" : "semantic_v1" : "legacy_nodes";
  if (orphanCount) view.warnings.push(`STALE_SOURCE_EXCLUDED: ${orphanCount} legacy act flows excluded`);
  const hasOutput = current.length > 0 || view.actFlows.length > 0 || view.openingNodes.length > 0 || view.endingNodes.length > 0;
  const missingOutput = [...active.values()].some(s => DM_SECTION_TYPES.includes(s.sectionType as DMSectionType) && !artifactSections.has(s.id) &&
    (s.sectionType === "dm_act" ? !view.actFlows.some(f => f.sourceSectionId === s.id)
      : s.sectionType === "dm_opening" ? !view.openingNodes.length : !view.endingNodes.length));
  view.parseStatus = view.sectionResults.some(r => r.status === "failed") || missingOutput
    ? hasOutput ? DMFlowParseStatus.PARTIAL_SUCCESS : DMFlowParseStatus.FAILED
    : hasOutput ? DMFlowParseStatus.SUCCESS : DMFlowParseStatus.PENDING;
  if (!hasOutput && !view.sectionResults.some(r => r.status === "failed")) view.parseStatus = DMFlowParseStatus.PENDING;
  return view;
}

export async function recordManualSemanticAct(input: { scriptPackageId: string; sectionId: string; semantic: ManualSemanticAct }): Promise<void> {
  const semantic = ManualSemanticActSchema.parse(input.semantic);
  const source = await sectionEvidence(input.sectionId);
  const section = await findDMSection({ scriptPackageId: input.scriptPackageId, sectionId: input.sectionId });
  if (section.actIndex !== semantic.actIndex) throw new Error("Semantic act 与 source section 不匹配。");
  const { assertActiveSource } = await import("@/src/lib/ingestion/sourceRevisionService");
  await prisma.$transaction(async tx => {
    for (const evidence of [...semantic.items.map(i => i.evidence), ...semantic.conversationPolicy.evidence]) {
      if (evidence.sourceSectionId !== source.sourceSectionId) throw new Error("Semantic fragment 必须来自当前 section。");
      await assertActiveSource(tx, evidence);
    }
  });
  await getOrCreateFlow(input.scriptPackageId);
  await saveDMArtifact({ source, scriptPackageId: input.scriptPackageId, semantic,
    output: { sectionType: "dm_act", actIndex: semantic.actIndex, title: section.title, nodes: [], warnings: [] } });
}

export async function parseDMSectionToFlowNodes(input: {
  scriptPackageId: string;
  sectionId: string;
}): Promise<DMFlowView> {
  const flow = await parseSingleSection(input, { resetSectionBeforeParse: false });

  return (await getDMFlow(flow.scriptPackageId))!;
}

export async function parseDMFlowForScriptPackage(
  scriptPackageId: string
): Promise<DMFlowParseSummary> {
  const sections = await prisma.documentSection.findMany({
    where: {
      scriptPackageId,
      isActive: true,
      parsedDocument: { isActive: true },
      sectionType: { in: [...DM_SECTION_TYPES] }
    },
    orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }]
  });

  await prisma.$transaction(tx => archiveLegacyAggregate(tx, scriptPackageId));
  await prisma.dMFlow.upsert({
    where: { scriptPackageId },
    create: {
      scriptPackageId,
      openingNodesJson: toJsonInput([]),
      actFlowsJson: toJsonInput([]),
      endingNodesJson: toJsonInput([]),
      sectionResultsJson: toJsonInput([]),
      parseStatus: DMFlowParseStatus.PENDING,
      parseError: null,
      warningsJson: toJsonInput([])
    },
    update: {
      openingNodesJson: toJsonInput([]),
      actFlowsJson: toJsonInput([]),
      endingNodesJson: toJsonInput([]),
      sectionResultsJson: toJsonInput([]),
      parseStatus: DMFlowParseStatus.PENDING,
      parseError: null,
      warningsJson: toJsonInput([])
    }
  });

  for (const section of sections) {
    await parseSingleSection(
      { scriptPackageId, sectionId: section.id },
      { resetSectionBeforeParse: false }
    );
  }

  const flow = await getDMFlow(scriptPackageId);
  const results = flow?.sectionResults ?? [];
  const successCount = results.filter((result) => result.status === "success").length;
  const failedCount = results.filter((result) => result.status === "failed").length;

  return {
    openingStatus: getSectionStatus(
      "dm_opening",
      results,
      sections.some((section) => section.sectionType === "dm_opening")
    ),
    endingStatus: getSectionStatus(
      "dm_ending",
      results,
      sections.some((section) => section.sectionType === "dm_ending")
    ),
    actFlowsCount: flow?.actFlows.length ?? 0,
    successCount,
    failedCount,
    warnings: flow?.warnings ?? [],
    results
  };
}

async function parseSingleSection(
  input: { scriptPackageId: string; sectionId: string },
  options: { resetSectionBeforeParse: boolean }
): Promise<DMFlow> {
  const section = await findDMSection(input);
  const job = await createDMFlowParseJob({
    scriptPackageId: input.scriptPackageId,
    sourceSectionId: section.id,
    sectionType: section.sectionType,
    actIndex: section.actIndex
  });

  if (options.resetSectionBeforeParse) {
    await removeSectionFromFlow(section);
  }

  if (!section.text.trim()) {
    const flow = await updateFlowWithFailedSection(section, "DM section 正文为空，不能结构化解析。");
    await failDMFlowParseJob(job.id, job.stepId, "DM section 正文为空，不能结构化解析。");

    return flow;
  }

  try {
    const output = validateSectionOutput(await generateSectionOutput(section), section);
    const flow = await updateFlowWithSuccessfulSection(section, output);

    await completeDMFlowParseJob(job.id, job.stepId, {
      status: "success",
      nodeCount: output.nodes.length,
      warningCount: output.warnings.length
    });

    return flow;
  } catch (error) {
    const message = error instanceof Error ? error.message : "DM 手册结构化解析失败。";
    const flow = await updateFlowWithFailedSection(section, message);

    await failDMFlowParseJob(job.id, job.stepId, message);

    return flow;
  }
}

async function generateSectionOutput(
  section: Awaited<ReturnType<typeof findDMSection>>
): Promise<DMFlowSectionOutput> {
  const chunks = splitDMSectionText(section.text);

  if (chunks.length === 1) {
    return generateSectionChunkOutput(section, chunks[0] ?? section.text, 0, 1);
  }

  const outputs: DMFlowSectionOutput[] = [];

  for (const [index, chunk] of chunks.entries()) {
    outputs.push(await generateSectionChunkOutput(section, chunk, index, chunks.length));
  }

  return combineChunkOutputs(section, outputs);
}

async function generateSectionChunkOutput(
  section: Awaited<ReturnType<typeof findDMSection>>,
  sourceText: string,
  chunkIndex: number,
  chunkCount: number
): Promise<DMFlowSectionOutput> {
  const result = await generateStructured<DMFlowSectionOutput>({
    agentType: "dm_flow_parser",
    actId: section.actIndex ? `act_${section.actIndex}` : section.sectionType,
    phase: "ingestion",
    schemaName: "dm_flow_section",
    zodSchema: DMFlowSectionOutputSchema,
    messages: buildDMFlowSectionPrompt({
      sectionType: section.sectionType,
      title: chunkCount > 1 ? `${section.title}（分块 ${chunkIndex + 1}/${chunkCount}）` : section.title,
      actIndex: section.actIndex,
      sourceText:
        chunkCount > 1
          ? [
              `这是同一个 DM section 的第 ${chunkIndex + 1}/${chunkCount} 个连续分块。`,
              "只解析当前分块中出现的流程节点，不要补全其他分块内容。",
              "",
              sourceText
            ].join("\n")
          : sourceText
    }),
    temperature: 0.1,
    maxOutputTokens: chunkCount > 1 ? 4500 : 8000,
    timeoutMs: DM_FLOW_PARSE_TIMEOUT_MS,
    metadata: {
      scriptPackageId: section.scriptPackageId,
      sourceSectionId: section.id,
      sectionType: section.sectionType,
      actIndex: section.actIndex,
      chunkIndex,
      chunkCount
    },
    mockOutput: createHeuristicDMFlowSectionOutput({
      ...section,
      text: sourceText
    })
  });

  return result.data;
}

function combineChunkOutputs(
  section: Awaited<ReturnType<typeof findDMSection>>,
  outputs: DMFlowSectionOutput[]
): DMFlowSectionOutput {
  return {
    sectionType: section.sectionType,
    actIndex: section.sectionType === "dm_act" ? section.actIndex : null,
    title: section.title,
    nodes: outputs.flatMap((output, chunkIndex) =>
      output.nodes.map((node, nodeIndex) => ({
        ...node,
        nodeId: `${node.nodeId || `${section.sectionType}_${section.actIndex ?? "x"}_${chunkIndex + 1}_${nodeIndex + 1}`}`
      }))
    ),
    warnings: outputs.flatMap((output, index) =>
      output.warnings.map((warning) => `分块 ${index + 1}: ${warning}`)
    )
  };
}

function splitDMSectionText(text: string): string[] {
  const normalized = text.trim();

  if (normalized.length <= DM_FLOW_SECTION_CHUNK_CHAR_LIMIT) {
    return [normalized];
  }

  const chunks: string[] = [];
  const lines = normalized.split(/\n+/);
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;

    if (next.length > DM_FLOW_SECTION_CHUNK_CHAR_LIMIT && current) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.flatMap((chunk) => splitOversizedChunk(chunk));
}

function splitOversizedChunk(chunk: string): string[] {
  if (chunk.length <= DM_FLOW_SECTION_CHUNK_CHAR_LIMIT) {
    return [chunk];
  }

  const parts: string[] = [];

  for (let index = 0; index < chunk.length; index += DM_FLOW_SECTION_CHUNK_CHAR_LIMIT) {
    parts.push(chunk.slice(index, index + DM_FLOW_SECTION_CHUNK_CHAR_LIMIT));
  }

  return parts;
}

async function findDMSection(input: { scriptPackageId: string; sectionId: string }) {
  const section = await prisma.documentSection.findFirst({
    where: {
      id: input.sectionId,
      scriptPackageId: input.scriptPackageId,
      isActive: true,
      parsedDocument: { isActive: true }
    }
  });

  if (!section) {
    throw new Error("未找到 DM 手册 DocumentSection。");
  }

  if (!isDMSectionType(section.sectionType)) {
    throw new Error("sectionId 不是 dm_opening / dm_act / dm_ending。");
  }

  if (section.sectionType === "dm_act" && !section.actIndex) {
    throw new Error("dm_act section 缺少 actIndex。");
  }

  return {
    id: section.id,
    scriptPackageId: section.scriptPackageId,
    sectionType: section.sectionType,
    title: section.title,
    actIndex: section.actIndex,
    text: section.text,
    orderIndex: section.orderIndex,
    source: await sectionEvidence(section.id)
  };
}

function validateSectionOutput(
  output: DMFlowSectionOutput,
  section: { sectionType: DMSectionType; actIndex: number | null; title: string }
): DMFlowSectionOutput {
  if (output.sectionType !== section.sectionType) {
    throw new Error(`LLM 输出 sectionType 不匹配：期望 ${section.sectionType}，实际 ${output.sectionType}。`);
  }

  if (section.sectionType === "dm_act" && output.actIndex !== section.actIndex) {
    throw new Error(`LLM 输出 actIndex 不匹配：期望 ${section.actIndex}，实际 ${output.actIndex}。`);
  }

  const nodes = output.nodes.map((node, index) => ({
    ...node,
    nodeId: node.nodeId || `${section.sectionType}_${section.actIndex ?? "x"}_${index + 1}`,
    actIndex: section.sectionType === "dm_act" ? section.actIndex ?? null : node.actIndex ?? null,
    orderHint: node.orderHint ?? index + 1,
    targetRoleNames: node.targetRoleNames.filter(Boolean),
    expectedSpeakerRoleNames: node.expectedSpeakerRoleNames.filter(Boolean),
    requiredPublicPoints: node.requiredPublicPoints.filter(Boolean),
    ifMissingPoints: node.ifMissingPoints.filter(Boolean),
    forbiddenReveals: node.forbiddenReveals.filter(Boolean),
    conditionalRules: node.conditionalRules.map((rule, ruleIndex) => ({
      ...rule,
      ruleId: rule.ruleId || `${node.nodeId || section.sectionType}_${ruleIndex + 1}`,
      targetRoleNames: rule.targetRoleNames.filter(Boolean),
      keywords: rule.keywords.filter(Boolean),
      warnings: rule.warnings.filter(Boolean)
    })),
    guidance: node.guidance
      ? {
          ...node.guidance,
          requiredPublicPoints: node.guidance.requiredPublicPoints.filter(Boolean),
          ifMissingPoints: node.guidance.ifMissingPoints.filter(Boolean),
          forbiddenReveals: node.guidance.forbiddenReveals.filter(Boolean)
        }
      : null,
    warnings: node.warnings.filter(Boolean)
  }));
  const warnings = output.warnings.filter(Boolean);

  if (nodes.length === 0) {
    warnings.push("当前 section 未抽取到流程节点，请人工检查。");
  }

  return {
    ...output,
    title: output.title || section.title,
    actIndex: section.sectionType === "dm_act" ? section.actIndex : null,
    nodes,
    warnings: Array.from(new Set(warnings))
  };
}

async function updateFlowWithSuccessfulSection(
  section: Awaited<ReturnType<typeof findDMSection>>,
  output: DMFlowSectionOutput
): Promise<DMFlow> {
  await getOrCreateFlow(section.scriptPackageId);
  await saveDMArtifact({ source: section.source, scriptPackageId: section.scriptPackageId, output });
  const existing = (await getDMFlow(section.scriptPackageId))!;
  const openingNodes = existing.openingNodes;
  const actFlows = existing.actFlows;
  const endingNodes = existing.endingNodes;
  const sectionResults = upsertSectionResult(
    existing.sectionResults,
    {
      sourceSectionId: section.id,
      sectionType: section.sectionType,
      actIndex: section.actIndex,
      title: section.title,
      status: "success",
      warningCount: output.warnings.length + output.nodes.reduce((sum, node) => sum + node.warnings.length, 0),
      warnings: collectSectionWarnings(output),
      parseError: null,
      parsedAt: new Date().toISOString()
    }
  );

  const nextData = buildUpdatedFlowData({
    section,
    openingNodes,
    actFlows,
    endingNodes,
    output,
    sectionResults
  });

  return prisma.dMFlow.update({
    where: { scriptPackageId: section.scriptPackageId },
    data: nextData
  });
}

async function updateFlowWithFailedSection(
  section: Awaited<ReturnType<typeof findDMSection>>,
  error: string
): Promise<DMFlow> {
  const existing = await getOrCreateFlow(section.scriptPackageId);
  const sectionResults = upsertSectionResult(
    fromJsonValue<DMFlowSectionResult[]>(existing.sectionResultsJson, []),
    {
      sourceSectionId: section.id,
      sectionType: section.sectionType,
      actIndex: section.actIndex,
      title: section.title,
      status: "failed",
      warningCount: 0,
      warnings: [],
      parseError: error,
      parsedAt: new Date().toISOString()
    }
  );

  return prisma.dMFlow.update({
    where: { scriptPackageId: section.scriptPackageId },
    data: buildStatusData(sectionResults)
  });
}

async function removeSectionFromFlow(section: Awaited<ReturnType<typeof findDMSection>>): Promise<void> {
  const existing = await getOrCreateFlow(section.scriptPackageId);
  const sectionResults = fromJsonValue<DMFlowSectionResult[]>(existing.sectionResultsJson, []).filter(
    (result) => result.sourceSectionId !== section.id
  );

  await prisma.dMFlow.update({
    where: { scriptPackageId: section.scriptPackageId },
    data: buildStatusData(sectionResults)
  });
}

function buildUpdatedFlowData(input: {
  section: Awaited<ReturnType<typeof findDMSection>>;
  openingNodes: DMFlowNode[];
  actFlows: DMFlowActFlow[];
  endingNodes: DMFlowNode[];
  output: DMFlowSectionOutput;
  sectionResults: DMFlowSectionResult[];
}) {
  const { section, output } = input;
  let openingNodes = input.openingNodes;
  let actFlows = input.actFlows;
  let endingNodes = input.endingNodes;

  if (section.sectionType === "dm_opening") {
    openingNodes = output.nodes;
  } else if (section.sectionType === "dm_ending") {
    endingNodes = output.nodes;
  } else {
    const nextActFlow: DMFlowActFlow = {
      actIndex: section.actIndex ?? output.actIndex ?? 0,
      title: output.title || section.title,
      nodes: output.nodes,
      warnings: output.warnings,
      sourceSectionId: section.id,
      sourceEvidence: section.source
    };
    actFlows = [
      ...actFlows.filter((actFlow) => actFlow.sourceSectionId !== section.id),
      nextActFlow
    ].sort((left, right) => left.actIndex - right.actIndex);
  }

  return {
    openingNodesJson: toJsonInput(openingNodes),
    actFlowsJson: toJsonInput(actFlows),
    endingNodesJson: toJsonInput(endingNodes),
    ...buildStatusData(input.sectionResults)
  };
}

function buildStatusData(sectionResults: DMFlowSectionResult[]) {
  const failedCount = sectionResults.filter((result) => result.status === "failed").length;
  const successCount = sectionResults.filter((result) => result.status === "success").length;
  const warnings = Array.from(new Set(sectionResults.flatMap((result) => result.warnings)));
  const parseStatus =
    failedCount > 0 && successCount > 0
      ? DMFlowParseStatus.PARTIAL_SUCCESS
      : failedCount > 0
        ? DMFlowParseStatus.FAILED
        : successCount > 0
          ? DMFlowParseStatus.SUCCESS
          : DMFlowParseStatus.PENDING;

  return {
    sectionResultsJson: toJsonInput(sectionResults),
    parseStatus,
    parseError:
      parseStatus === DMFlowParseStatus.FAILED
        ? sectionResults.find((result) => result.parseError)?.parseError ?? "DM 手册结构化解析失败。"
        : null,
    warningsJson: toJsonInput(warnings)
  };
}

async function getOrCreateFlow(scriptPackageId: string): Promise<DMFlow> {
  return prisma.dMFlow.upsert({
    where: { scriptPackageId },
    create: {
      scriptPackageId,
      openingNodesJson: toJsonInput([]),
      actFlowsJson: toJsonInput([]),
      endingNodesJson: toJsonInput([]),
      sectionResultsJson: toJsonInput([]),
      parseStatus: DMFlowParseStatus.PENDING,
      parseError: null,
      warningsJson: toJsonInput([])
    },
    update: {}
  });
}

function upsertSectionResult(
  results: DMFlowSectionResult[],
  next: DMFlowSectionResult
): DMFlowSectionResult[] {
  return [...results.filter((result) => result.sourceSectionId !== next.sourceSectionId), next].sort(
    (left, right) => {
      const typeOrder = sectionTypeOrder(left.sectionType) - sectionTypeOrder(right.sectionType);

      return typeOrder || (left.actIndex ?? 0) - (right.actIndex ?? 0);
    }
  );
}

function collectSectionWarnings(output: DMFlowSectionOutput): string[] {
  return Array.from(
    new Set([...output.warnings, ...output.nodes.flatMap((node) => node.warnings)].filter(Boolean))
  );
}

function toDMFlowView(record: DMFlow): DMFlowView {
  return {
    id: record.id,
    scriptPackageId: record.scriptPackageId,
    openingNodes: fromJsonValue<DMFlowNode[]>(record.openingNodesJson, []),
    actFlows: fromJsonValue<DMFlowActFlow[]>(record.actFlowsJson, []),
    endingNodes: fromJsonValue<DMFlowNode[]>(record.endingNodesJson, []),
    sectionResults: fromJsonValue<DMFlowSectionResult[]>(record.sectionResultsJson, []),
    parseStatus: record.parseStatus,
    parseError: record.parseError,
    warnings: fromJsonValue<string[]>(record.warningsJson, []),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    format: "legacy_nodes", semanticActs: [], artifactAudit: []
  };
}

function createHeuristicDMFlowSectionOutput(section: Awaited<ReturnType<typeof findDMSection>>): DMFlowSectionOutput {
  const lines = section.text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const nodes = lines.slice(0, 12).map((line, index): DMFlowNode => {
    const type = inferNodeType(line, section.sectionType);
    const clueRefs =
      type === "clue_release"
        ? [{ title: extractQuotedTitle(line) ?? null, rawText: line, releaseMode: "unknown" as const, targetRoleNames: [], visibility: "unknown" as const }]
        : [];
    const performance =
      type === "performance_instruction"
        ? { kind: inferPerformanceKind(line), instruction: line, rawText: line }
        : undefined;

    return {
      nodeId: `${section.sectionType}_${section.actIndex ?? "x"}_${index + 1}`,
      type,
      actIndex: section.sectionType === "dm_act" ? section.actIndex ?? null : null,
      title: line.length <= 24 ? line : null,
      text: type === "fixed_line" ? null : line,
      fixedLine: type === "fixed_line" ? line : null,
      promptGoal: type === "dm_prompt" ? line : null,
      targetRoleNames: [],
      expectedSpeakerRoleNames: [],
      durationHint: extractDuration(line) ?? null,
      orderHint: index + 1,
      requiredPublicPoints: [],
      ifMissingPoints: [],
      forbiddenReveals: [],
      conditionalRules: [],
      guidance: {
        discussionGoal: type === "free_discussion" || type === "dm_prompt" ? line : null,
        requiredPublicPoints: [],
        ifMissingPoints: [],
        forbiddenReveals: [],
        toneGuidance: null,
        fallbackHint: null
      },
      clueRefs,
      performance: performance ?? null,
      sourceQuote: line,
      confidence: 0.62,
      warnings: type === "sharing_round" && !/依次|顺序|轮流|所有人|每位|每个/.test(line) ? ["分享顺序不明确，请人工检查。"] : []
    };
  });

  return {
    sectionType: section.sectionType,
    actIndex: section.sectionType === "dm_act" ? section.actIndex : null,
    title: section.title,
    nodes,
    warnings: nodes.length === 0 ? ["当前 section 未抽取到流程节点，请人工检查。"] : []
  };
}

function inferNodeType(line: string, sectionType: DMSectionType): DMFlowNode["type"] {
  if (sectionType === "dm_ending" && /真相|复盘|结局|揭晓|揭示/.test(line)) {
    return "ending_reveal";
  }

  if (/请.*(?:说|读|念|打开|翻开|开始)|主持人.*(?:说|读|念)|DM.*(?:说|读|念)/i.test(line)) {
    return "fixed_line";
  }

  if (/阅读|读本|看本|翻开.*幕/.test(line)) {
    return "reading_start";
  }

  if (/分享|发言|依次|轮流/.test(line)) {
    return "sharing_round";
  }

  if (/自由讨论|讨论|交流/.test(line)) {
    return "free_discussion";
  }

  if (/为什么|觉得|引导|提醒|询问|提问/.test(line)) {
    return "dm_prompt";
  }

  if (/BGM|音乐|演绎|NPC|道具|信件|音频|视频|播放|表演/.test(line)) {
    return "performance_instruction";
  }

  if (/线索|发放|公开|照片|证据|给.*看/.test(line)) {
    return "clue_release";
  }

  if (/总结|确认|复述|本幕结束/.test(line)) {
    return "act_summary";
  }

  if (/进入|下一幕|第二幕|第三幕|休息|继续/.test(line)) {
    return "transition";
  }

  return sectionType === "dm_opening" ? "dm_prompt" : "free_discussion";
}

function inferPerformanceKind(line: string): NonNullable<DMFlowNode["performance"]>["kind"] {
  if (/BGM|音乐/.test(line)) return "bgm";
  if (/NPC/.test(line)) return "npc_line";
  if (/信件|信封|信/.test(line)) return "letter";
  if (/音频/.test(line)) return "audio";
  if (/视频/.test(line)) return "video";
  if (/道具/.test(line)) return "prop";
  return "other";
}

function extractDuration(line: string): string | undefined {
  return line.match(/\d+\s*(?:分钟|min|秒|小时)/i)?.[0];
}

function extractQuotedTitle(line: string): string | undefined {
  return line.match(/[《“"]([^》”"]+)[》”"]/)?.[1] ?? line.match(/(?:线索|发放|公开)(.{1,20})/)?.[1]?.trim();
}

function getSectionStatus(
  sectionType: DMSectionType,
  results: DMFlowSectionResult[],
  hasSection: boolean
): DMFlowParseSummary["openingStatus"] {
  if (!hasSection) {
    return "missing";
  }

  const matched = results.find((result) => result.sectionType === sectionType);

  return matched?.status ?? "not_parsed";
}

function isDMSectionType(value: string): value is DMSectionType {
  return DM_SECTION_TYPES.includes(value as DMSectionType);
}

function sectionTypeOrder(sectionType: DMSectionType): number {
  return sectionType === "dm_opening" ? 0 : sectionType === "dm_act" ? 1 : 2;
}

async function createDMFlowParseJob(input: {
  scriptPackageId: string;
  sourceSectionId: string;
  sectionType: string;
  actIndex: number | null;
}): Promise<{ id: string; stepId: string }> {
  const job = await prisma.ingestionJob.create({
    data: {
      scriptPackageId: input.scriptPackageId,
      status: IngestionJobStatus.RUNNING,
      currentStep: "dm_flow_section_parse",
      inputJson: toJsonInput(input),
      steps: {
        create: {
          stepName: "dm_flow_section_parse",
          status: IngestionJobStatus.RUNNING,
          inputJson: toJsonInput(input),
          startedAt: new Date()
        }
      }
    },
    include: { steps: true }
  });

  return {
    id: job.id,
    stepId: job.steps[0]?.id ?? ""
  };
}

async function completeDMFlowParseJob(
  jobId: string,
  stepId: string,
  output: unknown
): Promise<void> {
  await prisma.ingestionStepRun.update({
    where: { id: stepId },
    data: {
      status: IngestionJobStatus.COMPLETED,
      outputJson: toJsonInput(output),
      finishedAt: new Date()
    }
  });
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionJobStatus.COMPLETED,
      outputJson: toJsonInput(output),
      currentStep: "dm_flow_section_parse"
    }
  });
}

async function failDMFlowParseJob(
  jobId: string,
  stepId: string,
  errorMessage: string
): Promise<void> {
  await prisma.ingestionStepRun.update({
    where: { id: stepId },
    data: {
      status: IngestionJobStatus.FAILED,
      errorMessage,
      finishedAt: new Date()
    }
  });
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionJobStatus.FAILED,
      errorMessage,
      currentStep: "dm_flow_section_parse"
    }
  });
}
