import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import type { SourceEvidence } from "@/src/lib/schemas/manualSemanticSchema";

export const PARSER_VERSION = "dm-section-2";
export const PROMPT_VERSION = "dm-section-existing-1";
export const SEMANTIC_SCHEMA_VERSION = "manual-semantic-1";

export async function archiveLegacyAggregate(tx: Prisma.TransactionClient, scriptPackageId: string): Promise<void> {
  const flow = await tx.dMFlow.findUnique({ where: { scriptPackageId } });
  if (!flow) return;
  const outputJson = toJsonInput({ openingNodesJson: flow.openingNodesJson, actFlowsJson: flow.actFlowsJson,
    endingNodesJson: flow.endingNodesJson, sectionResultsJson: flow.sectionResultsJson, warningsJson: flow.warningsJson });
  if (await tx.dMParseArtifact.findFirst({ where: { scriptPackageId, status: "legacy_archive", outputJson } })) return;
  await tx.dMParseArtifact.create({ data: { scriptPackageId, sourceSectionId: "legacy_aggregate",
    sourceJson: toJsonInput({ provenance: "legacy_unknown" }), outputJson, status: "legacy_archive",
    parserVersion: "legacy_unknown", promptVersion: "legacy_unknown", schemaVersion: "legacy_aggregate" } });
}

export async function retireSections(tx: Prisma.TransactionClient, where: Prisma.DocumentSectionWhereInput): Promise<void> {
  const sections = await tx.documentSection.findMany({ where: { ...where, isActive: true }, select: { id: true, scriptPackageId: true } });
  for (const packageId of new Set(sections.map(s => s.scriptPackageId))) await archiveLegacyAggregate(tx, packageId);
  await tx.dMParseArtifact.updateMany({ where: { sourceSectionId: { in: sections.map(s => s.id) }, status: "active" }, data: { status: "stale" } });
  await tx.documentSection.updateMany({ where, data: { isActive: false } });
}

export async function beginSectionRevision(documentId: string): Promise<number> {
  return prisma.$transaction(async tx => {
    const doc = await tx.parsedDocument.findUniqueOrThrow({ where: { id: documentId } });
    if (!doc.isActive) throw new Error("来源文档已过期，不能重新切分。");
    await retireSections(tx, { uploadedAssetId: doc.uploadedAssetId });
    await tx.parsedDocument.update({ where: { id: documentId }, data: { sectionSetRevision: { increment: 1 } } });
    return doc.sectionSetRevision + 1;
  });
}

export function locateSourceSpan(text: string, sectionText: string): { start: number; end: number } | null {
  const start = text.indexOf(sectionText);
  if (start < 0 || text.indexOf(sectionText, start + 1) >= 0) return null;
  return { start, end: start + sectionText.length };
}

export async function sectionEvidence(sectionId: string): Promise<SourceEvidence> {
  const section = await prisma.documentSection.findUniqueOrThrow({ where: { id: sectionId }, include: { parsedDocument: true } });
  const doc = section.parsedDocument;
  if (!section.isActive || !doc.isActive || section.sectionSetRevision !== doc.sectionSetRevision) throw new Error("DM section 来源已 stale。");
  const span = fromJsonValue<{ start: number; end: number } | null>(section.sourceSpanJson, null) ?? locateSourceSpan(doc.normalizedText || doc.extractedText, section.text);
  if (!span) throw new Error("来源 span 无法唯一定位，需要重新切分或语义修复。");
  return { sourceDocumentId: doc.id, sourceRevision: doc.documentRevision, sourceSectionId: section.id,
    sectionSetRevision: section.sectionSetRevision, sourceSpan: span, sourceQuote: section.text,
    parserVersion: PARSER_VERSION, promptVersion: PROMPT_VERSION, schemaVersion: SEMANTIC_SCHEMA_VERSION };
}

export async function assertActiveSource(tx: Prisma.TransactionClient, source: SourceEvidence): Promise<void> {
  const section = await tx.documentSection.findFirst({ where: { id: source.sourceSectionId, isActive: true,
    sectionSetRevision: source.sectionSetRevision, parsedDocumentId: source.sourceDocumentId,
    parsedDocument: { isActive: true, documentRevision: source.sourceRevision, sectionSetRevision: source.sectionSetRevision } } });
  if (!section) throw new Error("解析期间来源 revision 已变化，结果不能发布到 active aggregate。");
  const doc = await tx.parsedDocument.findUniqueOrThrow({ where: { id: source.sourceDocumentId } });
  const text = doc.normalizedText || doc.extractedText;
  const sectionSpan = fromJsonValue<{ start: number; end: number } | null>(section.sourceSpanJson, null) ?? locateSourceSpan(text, section.text);
  if (!sectionSpan || source.sourceSpan.start < sectionSpan.start || source.sourceSpan.end > sectionSpan.end ||
    source.sourceSpan.start >= source.sourceSpan.end || !source.sourceQuote.trim() ||
    !text.slice(source.sourceSpan.start, source.sourceSpan.end).includes(source.sourceQuote)) {
    throw new Error("Source evidence 与原文不匹配。");
  }
}

export async function saveDMArtifact(input: { source: SourceEvidence; scriptPackageId: string; output: unknown; semantic?: unknown }): Promise<void> {
  await prisma.$transaction(async tx => {
    await assertActiveSource(tx, input.source);
    await archiveLegacyAggregate(tx, input.scriptPackageId);
    await tx.dMParseArtifact.updateMany({ where: { sourceSectionId: input.source.sourceSectionId, status: "active" }, data: { status: "superseded" } });
    await tx.dMParseArtifact.create({ data: { scriptPackageId: input.scriptPackageId, sourceSectionId: input.source.sourceSectionId,
      sourceJson: toJsonInput(input.source), outputJson: toJsonInput(input.output), semanticJson: input.semantic ? toJsonInput(input.semantic) : null,
      parserVersion: input.source.parserVersion, promptVersion: input.source.promptVersion, schemaVersion: input.source.schemaVersion } });
  });
}
