import "server-only";

import { join } from "node:path";
import {
  AssetParseStatus,
  DocumentSegmentationStatus,
  IngestionJobStatus,
  ParsedDocumentQualityStatus,
  ParsedDocumentParseStatus,
  type ParsedDocument
} from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import { toJsonInput, fromJsonValue } from "@/src/lib/services/jsonFields";
import { retireSections } from "@/src/lib/ingestion/sourceRevisionService";
import {
  extractDocumentText,
  isSupportedTextAsset,
  type DocumentTextExtractionResult
} from "@/src/lib/ingestion/documentTextExtractor";
import type { ExtractedPdfPage } from "@/src/lib/ingestion/pdfTextExtractor";

export type ParsedDocumentView = ParsedDocument & {
  pages: ExtractedPdfPage[];
  blocks: unknown[];
  qualityWarnings: string[];
};

export async function listParsedDocuments(
  scriptPackageId: string
): Promise<ParsedDocumentView[]> {
  const records = await prisma.parsedDocument.findMany({
    where: { scriptPackageId, isActive: true },
    orderBy: { updatedAt: "desc" }
  });

  return records.map(toParsedDocumentView);
}

export async function getParsedDocument(
  scriptPackageId: string,
  parsedDocumentId: string
): Promise<ParsedDocumentView> {
  const record = await prisma.parsedDocument.findFirst({
    where: {
      id: parsedDocumentId,
      scriptPackageId
    }
  });

  if (!record) {
    throw new Error(`ParsedDocument not found for id "${parsedDocumentId}".`);
  }

  return toParsedDocumentView(record);
}

export async function parseUploadedAssetPdf(input: {
  scriptPackageId: string;
  assetId: string;
}): Promise<ParsedDocumentView> {
  return parseUploadedAssetDocument(input);
}

export async function parseUploadedAssetDocument(input: {
  scriptPackageId: string;
  assetId: string;
}): Promise<ParsedDocumentView> {
  const asset = await prisma.uploadedAsset.findFirst({
    where: {
      id: input.assetId,
      scriptPackageId: input.scriptPackageId
    }
  });

  if (!asset) {
    throw new Error(`UploadedAsset not found for id "${input.assetId}".`);
  }

  if (!isSupportedTextAsset(asset.mimeType, asset.originalName)) {
    const message = "当前阶段仅支持 DOCX 和可复制文本 PDF。";

    await prisma.uploadedAsset.update({
      where: { id: asset.id },
      data: { parseStatus: AssetParseStatus.SKIPPED }
    });

    throw new Error(message);
  }

  const job = await prisma.ingestionJob.create({
    data: {
      scriptPackageId: input.scriptPackageId,
      status: IngestionJobStatus.RUNNING,
      currentStep: "document_text_extraction",
      inputJson: toJsonInput({
        assetId: asset.id,
        localPath: asset.localPath,
        mimeType: asset.mimeType
      }),
      steps: {
        create: {
          stepName: "document_text_extraction",
          status: IngestionJobStatus.RUNNING,
          inputJson: toJsonInput({
            assetId: asset.id,
            localPath: asset.localPath,
            mimeType: asset.mimeType
          }),
          startedAt: new Date()
        }
      }
    },
    include: { steps: true }
  });
  const step = job.steps[0];

  const processingDocument = await prisma.$transaction(async tx => {
    const previous = await tx.parsedDocument.findFirst({ where: { uploadedAssetId: asset.id }, orderBy: { documentRevision: "desc" } });
    await retireSections(tx, { uploadedAssetId: asset.id });
    await tx.parsedDocument.updateMany({ where: { uploadedAssetId: asset.id }, data: { isActive: false } });
    return tx.parsedDocument.create({
    data: {
      scriptPackageId: input.scriptPackageId,
      uploadedAssetId: asset.id,
      kind: asset.kind,
      sourceType: asset.mimeType ?? "application/pdf",
      parseStatus: ParsedDocumentParseStatus.PROCESSING,
      pageCount: 0,
      charCount: 0,
      extractedText: "",
      rawText: "",
      normalizedText: "",
      pagesJson: toJsonInput([]),
      documentRevision: (previous?.documentRevision ?? 0) + 1
    }
    });
  });

  await prisma.uploadedAsset.updateMany({
    where: { id: asset.id, parsedDocuments: { some: { id: processingDocument.id, isActive: true } } },
    data: { parseStatus: AssetParseStatus.PENDING }
  });

  try {
    const result = await extractDocumentText({
      filePath: resolveLocalPath(asset.localPath),
      mimeType: asset.mimeType,
      originalName: asset.originalName
    });
    const completed = await completeParsedDocument(processingDocument.id, result);
    if (!completed.isActive) throw new Error("文本抽取期间文档已被新 revision 替代。");

    if (result.qualityStatus === "failed") {
      throw new Error(result.qualityWarnings.join("；") || "文本质量检测未通过。");
    }

    await prisma.uploadedAsset.updateMany({
      where: { id: asset.id, parsedDocuments: { some: { id: processingDocument.id, isActive: true } } },
      data: {
        parseStatus: AssetParseStatus.EXTRACTED,
        parsedText: result.normalizedText
      }
    });
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: {
        status: IngestionJobStatus.COMPLETED,
        currentStep: "pdf_text_extraction",
        outputJson: toJsonInput({
          parsedDocumentId: completed.id,
          pageCount: completed.pageCount,
          charCount: completed.charCount,
          extractorName: completed.extractorName,
          qualityStatus: completed.qualityStatus
        })
      }
    });

    if (step) {
      await prisma.ingestionStepRun.update({
        where: { id: step.id },
        data: {
          status: IngestionJobStatus.COMPLETED,
          outputJson: toJsonInput({
            parsedDocumentId: completed.id,
            pageCount: completed.pageCount,
            charCount: completed.charCount,
            extractorName: completed.extractorName,
            qualityStatus: completed.qualityStatus
          }),
          finishedAt: new Date()
        }
      });
    }

    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "PDF 文本抽取失败。";
    const failed = await prisma.parsedDocument.update({
      where: { id: processingDocument.id },
      data: {
        parseStatus: ParsedDocumentParseStatus.FAILED,
        errorMessage: message
      }
    });

    await prisma.uploadedAsset.updateMany({
      where: { id: asset.id, parsedDocuments: { some: { id: processingDocument.id, isActive: true } } },
      data: { parseStatus: AssetParseStatus.FAILED }
    });
    await prisma.ingestionJob.update({
      where: { id: job.id },
      data: {
        status: IngestionJobStatus.FAILED,
        errorMessage: message
      }
    });

    if (step) {
      await prisma.ingestionStepRun.update({
        where: { id: step.id },
        data: {
          status: IngestionJobStatus.FAILED,
          errorMessage: message,
          finishedAt: new Date()
        }
      });
    }

    return toParsedDocumentView(failed);
  }
}

function completeParsedDocument(
  parsedDocumentId: string,
  result: DocumentTextExtractionResult
): Promise<ParsedDocumentView> {
  const qualityStatus = toPrismaQualityStatus(result.qualityStatus);

  return prisma.parsedDocument
    .update({
      where: { id: parsedDocumentId },
      data: {
        parseStatus:
          result.qualityStatus === "failed"
            ? ParsedDocumentParseStatus.FAILED
            : ParsedDocumentParseStatus.COMPLETED,
        pageCount: result.pageCount ?? 0,
        charCount: result.charCount,
        rawText: result.rawText,
        normalizedText: result.normalizedText,
        extractedText: result.normalizedText,
        blocksJson: result.blocksJson ? toJsonInput(result.blocksJson) : null,
        pagesJson: toJsonInput(result.pagesJson ?? []),
        extractorName: result.extractorName,
        qualityStatus,
        qualityWarningsJson: toJsonInput(result.qualityWarnings),
        errorMessage:
          result.qualityStatus === "failed"
            ? result.qualityWarnings.join("；") || "文本质量检测未通过。"
            : result.qualityWarnings.length > 0
              ? result.qualityWarnings.join("；")
              : null,
        segmentationStatus: DocumentSegmentationStatus.NOT_STARTED,
        segmentationError: null
      }
    })
    .then(toParsedDocumentView);
}

function toParsedDocumentView(record: ParsedDocument): ParsedDocumentView {
  return {
    ...record,
    pages: fromJsonValue<ExtractedPdfPage[]>(record.pagesJson, []),
    blocks: fromJsonValue<unknown[]>(record.blocksJson, []),
    qualityWarnings: fromJsonValue<string[]>(record.qualityWarningsJson, [])
  };
}

function toPrismaQualityStatus(value: DocumentTextExtractionResult["qualityStatus"]) {
  if (value === "failed") {
    return ParsedDocumentQualityStatus.FAILED;
  }

  if (value === "warning") {
    return ParsedDocumentQualityStatus.WARNING;
  }

  return ParsedDocumentQualityStatus.PASS;
}

function resolveLocalPath(localPath: string): string {
  return join(process.cwd(), localPath);
}
