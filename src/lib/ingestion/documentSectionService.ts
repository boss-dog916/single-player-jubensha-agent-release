import "server-only";

import { basename, extname } from "node:path";
import {
  DocumentSectionPurpose,
  DocumentSegmentationStatus,
  IngestionJobStatus,
  UploadedAssetPurpose,
  UploadedAssetKind,
  type DocumentSection,
  type ParsedDocument,
  type UploadedAsset
} from "@prisma/client";
import { prisma } from "@/src/lib/db/prisma";
import type { ExtractedPdfPage } from "@/src/lib/ingestion/pdfTextExtractor";
import { fromJsonValue, toJsonInput } from "@/src/lib/services/jsonFields";
import { beginSectionRevision, retireSections, locateSourceSpan } from "@/src/lib/ingestion/sourceRevisionService";

type ParsedDocumentWithAsset = {
  id: string;
  scriptPackageId: string;
  uploadedAssetId: string;
  kind: UploadedAssetKind;
  parseStatus: string;
  qualityStatus: string;
  pageCount: number;
  extractedText: string;
  normalizedText: string;
  pagesJson: string;
  uploadedAsset: UploadedAsset;
};

export type DocumentSectionView = DocumentSection & {
  uploadedAsset: Pick<UploadedAsset, "id" | "kind" | "assetPurpose" | "originalName" | "roleName">;
};

export type SegmentationResult = {
  sections: DocumentSectionView[];
  sectionsCount: number;
  segmentationStatus: DocumentSegmentationStatus;
  segmentationError: string | null;
};

export type ManualRoleActInput = {
  roleName?: string | null;
  displayAssetId?: string | null;
  textAssetId?: string | null;
  actStartPages: Array<{
    actIndex: number;
    pageStart: number;
    title?: string | null;
  }>;
};

export type MarkerMatchResult = {
  status: "matched" | "not_found";
  matches: Array<{
    startOffset: number;
    endOffset: number;
    matchedTextPreview: string;
  }>;
  normalizedMarker: string;
  message: string;
};

type SectionDraft = {
  uploadedAssetId?: string;
  parsedDocumentId?: string;
  sectionType: string;
  sectionPurpose?: DocumentSectionPurpose;
  title: string;
  roleName?: string | null;
  actIndex?: number | null;
  pageStart?: number | null;
  pageEnd?: number | null;
  text: string;
  metadataJson?: unknown;
  orderIndex: number;
};

type PageRange = {
  pageNumber: number;
  start: number;
  end: number;
};

type Heading = {
  title: string;
  index: number;
  pageNumber: number;
  actIndex: number | null;
  sectionType?: string;
};

const ROLE_SINGLE_HEADING_ERROR =
  "只识别到一个幕标题，无法可靠判断每一幕边界，请手动输入每一幕起始页码。";
const ROLE_NO_HEADING_ERROR = "未识别到幕标题，请手动输入每一幕起始页码。";

export async function listDocumentSections(input: {
  scriptPackageId: string;
  uploadedAssetId?: string | null;
  parsedDocumentId?: string | null;
}): Promise<DocumentSectionView[]> {
  return prisma.documentSection.findMany({
    where: {
      scriptPackageId: input.scriptPackageId,
      isActive: true,
      parsedDocument: { isActive: true },
      uploadedAssetId: input.uploadedAssetId ?? undefined,
      parsedDocumentId: input.parsedDocumentId ?? undefined
    },
    include: {
      uploadedAsset: {
        select: {
          id: true,
          kind: true,
          assetPurpose: true,
          originalName: true,
          roleName: true
        }
      }
    },
    orderBy: [{ uploadedAssetId: "asc" }, { orderIndex: "asc" }]
  });
}

export async function segmentParsedDocument(input: {
  scriptPackageId: string;
  parsedDocumentId: string;
}): Promise<SegmentationResult> {
  const parsedDocument = await getParsedDocumentForSegmentation(input);
  const job = await createSegmentationJob(parsedDocument, "auto");

  try {
    const pages = readPages(parsedDocument);
    const drafts = buildAutomaticSectionDrafts(parsedDocument, pages);

    const revision = await beginSectionRevision(parsedDocument.id);

    if (drafts.status === DocumentSegmentationStatus.NEEDS_MANUAL_SEGMENTATION) {
      await updateSegmentationState({
        parsedDocumentId: parsedDocument.id,
        status: drafts.status,
        error: drafts.error
      });
      await completeSegmentationJob(job.id, job.stepId, {
        status: drafts.status,
        errorMessage: drafts.error,
        sectionsCount: 0
      });

      return {
        sections: [],
        sectionsCount: 0,
        segmentationStatus: drafts.status,
        segmentationError: drafts.error ?? null
      };
    }

    const sections = await writeSections(parsedDocument, drafts.sections, revision);

    await updateSegmentationState({
      parsedDocumentId: parsedDocument.id,
      status: drafts.status,
      error: drafts.error ?? null
    });
    await completeSegmentationJob(job.id, job.stepId, {
      status: drafts.status,
      sectionsCount: sections.length
    });

    return {
      sections,
      sectionsCount: sections.length,
      segmentationStatus: drafts.status,
      segmentationError: drafts.error ?? null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "章节切分失败。";

    await updateSegmentationState({
      parsedDocumentId: parsedDocument.id,
      status: DocumentSegmentationStatus.FAILED,
      error: message
    });
    await failSegmentationJob(job.id, job.stepId, message);

    return {
      sections: [],
      sectionsCount: 0,
      segmentationStatus: DocumentSegmentationStatus.FAILED,
      segmentationError: message
    };
  }
}

export async function segmentRoleActsManually(input: {
  scriptPackageId: string;
  parsedDocumentId: string;
  manual: ManualRoleActInput;
}): Promise<SegmentationResult> {
  const parsedDocument = await getParsedDocumentForSegmentation(input);

  if (parsedDocument.uploadedAsset.kind !== UploadedAssetKind.ROLE_BOOKLET) {
    throw new Error("手动幕切分仅适用于角色剧本。");
  }

  const pages = readPages(parsedDocument);
  const sortedStarts = normalizeManualActStarts(input.manual.actStartPages, parsedDocument.pageCount);
  const roleName = normalizeRoleName(input.manual.roleName) ?? getRoleName(parsedDocument.uploadedAsset);
  const job = await createSegmentationJob(parsedDocument, "manual_role_acts");
  const drafts = sortedStarts.map((start, index) => {
    const next = sortedStarts[index + 1];
    const pageEnd = next ? next.pageStart - 1 : parsedDocument.pageCount;
    const title = normalizeTitle(start.title) ?? `第 ${start.actIndex} 幕`;

    return {
      sectionType: "role_act",
      title,
      roleName,
      actIndex: start.actIndex,
      pageStart: start.pageStart,
      pageEnd,
      text: getTextByPageRange(pages, start.pageStart, pageEnd),
      orderIndex: index
    };
  });

  const sections = await writeSections(parsedDocument, drafts, undefined, {
      scriptPackageId: input.scriptPackageId,
      uploadedAssetId: parsedDocument.uploadedAssetId,
      sectionType: "role_act"
  });

  await updateSegmentationState({
    parsedDocumentId: parsedDocument.id,
    status: DocumentSegmentationStatus.COMPLETED,
    error: null
  });
  await completeSegmentationJob(job.id, job.stepId, {
    status: DocumentSegmentationStatus.COMPLETED,
    sectionsCount: sections.length
  });

  return {
    sections,
    sectionsCount: sections.length,
    segmentationStatus: DocumentSegmentationStatus.COMPLETED,
    segmentationError: null
  };
}

export async function segmentRoleBookletManualActs(input: {
  scriptPackageId: string;
  roleName?: string | null;
  displayAssetId: string;
  textAssetId?: string | null;
  actStartPages: ManualRoleActInput["actStartPages"];
}): Promise<
  SegmentationResult & {
    aiTextSourceStatus: "docx_needs_text_alignment" | "pdf_fallback" | "needs_docx";
    displayAssetId: string;
    textAssetId: string | null;
  }
> {
  const displayAsset = await prisma.uploadedAsset.findFirst({
    where: {
      id: input.displayAssetId,
      scriptPackageId: input.scriptPackageId,
      kind: UploadedAssetKind.ROLE_BOOKLET
    }
  });

  if (!displayAsset) {
    throw new Error("未找到玩家阅读 PDF 角色剧本。");
  }

  if (!isPdfAsset(displayAsset)) {
    throw new Error("玩家阅读展示文件必须是 PDF；DOCX 不能作为正式页码来源。");
  }

  if (
    displayAsset.assetPurpose !== UploadedAssetPurpose.PLAYER_DISPLAY &&
    displayAsset.assetPurpose !== UploadedAssetPurpose.BOTH
  ) {
    throw new Error("displayAssetId 必须指向 player_display 或 both 用途的角色 PDF。");
  }

  const displayParsedDocument = await findLatestParsedDocumentForAsset(
    input.scriptPackageId,
    displayAsset.id
  );

  if (!displayParsedDocument || displayParsedDocument.pageCount <= 0) {
    throw new Error("请先解析玩家阅读 PDF，系统需要 PDF 页数来校验每一幕起始页。");
  }

  const textAsset = input.textAssetId
    ? await prisma.uploadedAsset.findFirst({
        where: {
          id: input.textAssetId,
          scriptPackageId: input.scriptPackageId,
          kind: UploadedAssetKind.ROLE_BOOKLET
        }
      })
    : null;

  if (input.textAssetId && !textAsset) {
    throw new Error("未找到 AI 解析 DOCX 角色剧本。");
  }

  if (
    textAsset &&
    textAsset.assetPurpose !== UploadedAssetPurpose.AI_TEXT_SOURCE &&
    textAsset.assetPurpose !== UploadedAssetPurpose.BOTH
  ) {
    throw new Error("textAssetId 必须指向 ai_text_source 或 both 用途的角色资料。");
  }

  const pages = readPagesFromParsedDocument(displayParsedDocument);
  const sortedStarts = normalizeManualActStarts(input.actStartPages, displayParsedDocument.pageCount);
  const roleName =
    normalizeRoleName(input.roleName) ??
    normalizeRoleName(displayAsset.roleName) ??
    normalizeRoleName(textAsset?.roleName) ??
    getRoleName(displayAsset);
  const textParsedDocument = textAsset
    ? await findLatestParsedDocumentForAsset(input.scriptPackageId, textAsset.id)
    : null;
  const aiTextSourceStatus = textAsset
    ? "docx_needs_text_alignment"
    : displayParsedDocument.qualityStatus === "FAILED"
      ? "needs_docx"
      : "pdf_fallback";
  const job = await createSegmentationJobForManualRoleBooklet(
    input.scriptPackageId,
    displayParsedDocument,
    textAsset?.id ?? null,
    roleName
  );

  const displayDrafts = sortedStarts.map((start, index): SectionDraft => {
    const next = sortedStarts[index + 1];
    const pageEnd = next ? next.pageStart - 1 : displayParsedDocument.pageCount;
    const title = normalizeTitle(start.title) ?? `第${start.actIndex}幕`;

    return {
      uploadedAssetId: displayAsset.id,
      parsedDocumentId: displayParsedDocument.id,
      sectionType: "role_act",
      sectionPurpose: DocumentSectionPurpose.PLAYER_DISPLAY,
      title,
      roleName,
      actIndex: start.actIndex,
      pageStart: start.pageStart,
      pageEnd,
      text: getTextByPageRange(pages, start.pageStart, pageEnd),
      metadataJson: {
        displayAssetId: displayAsset.id,
        textAssetId: textAsset?.id ?? null,
        source: "manual_pdf_page_range"
      },
      orderIndex: index
    };
  });
  const aiDrafts =
    aiTextSourceStatus === "needs_docx" || aiTextSourceStatus === "docx_needs_text_alignment"
      ? []
      : sortedStarts.map((start, index): SectionDraft => {
          const next = sortedStarts[index + 1];
          const pageEnd = next ? next.pageStart - 1 : displayParsedDocument.pageCount;
          const title = normalizeTitle(start.title) ?? `第${start.actIndex}幕`;
          const usePdfFallback = aiTextSourceStatus === "pdf_fallback";

          return {
            uploadedAssetId: usePdfFallback ? displayAsset.id : textAsset?.id ?? displayAsset.id,
            parsedDocumentId: usePdfFallback
              ? displayParsedDocument.id
              : textParsedDocument?.id ?? displayParsedDocument.id,
            sectionType: "role_act",
            sectionPurpose: DocumentSectionPurpose.AI_TEXT_SOURCE,
            title,
            roleName,
            actIndex: start.actIndex,
            pageStart: usePdfFallback ? start.pageStart : null,
            pageEnd: usePdfFallback ? pageEnd : null,
            text: usePdfFallback ? getTextByPageRange(pages, start.pageStart, pageEnd) : "",
            metadataJson: {
              status: aiTextSourceStatus,
              displayAssetId: displayAsset.id,
              textAssetId: textAsset?.id ?? null,
              textParsedDocumentId: textParsedDocument?.id ?? null,
              qualityStatus: displayParsedDocument.qualityStatus,
              qualityWarnings: fromJsonValue<string[]>(displayParsedDocument.qualityWarningsJson, [])
            },
            orderIndex: index
          };
        });

  await writeSections(displayParsedDocument, [...displayDrafts, ...aiDrafts], undefined, {
      scriptPackageId: input.scriptPackageId,
      uploadedAssetId: displayAsset.id,
      roleName,
      sectionType: "role_act",
      sectionPurpose: {
        in: textAsset
          ? [DocumentSectionPurpose.PLAYER_DISPLAY]
          : [DocumentSectionPurpose.PLAYER_DISPLAY, DocumentSectionPurpose.AI_TEXT_SOURCE]
      }
  });
  const sections = (await listDocumentSections({ scriptPackageId: input.scriptPackageId })).filter(
    (section) =>
      section.roleName === roleName &&
      [displayAsset.id, textAsset?.id].includes(section.uploadedAssetId) &&
      section.sectionType === "role_act" &&
      (section.sectionPurpose === DocumentSectionPurpose.PLAYER_DISPLAY ||
        section.sectionPurpose === DocumentSectionPurpose.AI_TEXT_SOURCE)
  );

  await updateSegmentationState({
    parsedDocumentId: displayParsedDocument.id,
    status: DocumentSegmentationStatus.COMPLETED,
    error: aiTextSourceStatus === "needs_docx" ? "PDF 文本质量未通过，请上传 DOCX 作为 AI 文本源。" : null
  });
  await completeSegmentationJob(job.id, job.stepId, {
    status: DocumentSegmentationStatus.COMPLETED,
    sectionsCount: sections.length,
    aiTextSourceStatus
  });

  return {
    sections,
    sectionsCount: sections.length,
    segmentationStatus: DocumentSegmentationStatus.COMPLETED,
    segmentationError: aiTextSourceStatus === "needs_docx" ? "PDF 文本质量未通过，请上传 DOCX 作为 AI 文本源。" : null,
    aiTextSourceStatus,
    displayAssetId: displayAsset.id,
    textAssetId: textAsset?.id ?? null
  };
}

export async function segmentRoleBookletTextActsByMarker(input: {
  scriptPackageId: string;
  roleName?: string | null;
  textAssetId: string;
  expectedActCount?: number | null;
  startActIndex?: number;
  commonEndMarker: string;
}): Promise<
  SegmentationResult & {
    matchCount: number;
    normalizedMarker: string;
  }
> {
  const textAsset = await prisma.uploadedAsset.findFirst({
    where: {
      id: input.textAssetId,
      scriptPackageId: input.scriptPackageId,
      kind: UploadedAssetKind.ROLE_BOOKLET
    }
  });

  if (!textAsset) {
    throw new Error("未找到 AI 文本 DOCX 角色剧本。");
  }

  if (!isDocxAsset(textAsset)) {
    throw new Error("AI 文本切分目前只支持 DOCX。");
  }

  if (
    textAsset.assetPurpose !== UploadedAssetPurpose.AI_TEXT_SOURCE &&
    textAsset.assetPurpose !== UploadedAssetPurpose.BOTH
  ) {
    throw new Error("textAssetId 必须指向 ai_text_source 或 both 用途的 DOCX。");
  }

  const roleName = normalizeRoleName(input.roleName) ?? normalizeRoleName(textAsset.roleName) ?? getRoleName(textAsset);

  if (normalizeRoleName(textAsset.roleName) && normalizeRoleName(textAsset.roleName) !== roleName) {
    throw new Error("textAssetId 不属于当前 roleName。");
  }

  const parsedDocument = await findLatestParsedDocumentForAsset(input.scriptPackageId, textAsset.id);

  if (!parsedDocument || parsedDocument.parseStatus !== "COMPLETED") {
    throw new Error("请先解析 DOCX，生成 ParsedDocument 后再切分 AI 文本。");
  }

  if (parsedDocument.qualityStatus === "FAILED") {
    throw new Error("DOCX 文本质量检测未通过，不能切分 AI 文本。");
  }

  const text = parsedDocument.normalizedText || parsedDocument.extractedText;

  if (!text.trim()) {
    throw new Error("DOCX ParsedDocument 缺少 normalizedText。");
  }

  const matchResult = findAllMarkersInText(text, input.commonEndMarker);

  if (matchResult.status === "not_found") {
    throw new Error(matchResult.message);
  }

  const expectedActCount =
    input.expectedActCount === null || input.expectedActCount === undefined
      ? null
      : Number(input.expectedActCount);

  if (expectedActCount !== null) {
    if (!Number.isInteger(expectedActCount) || expectedActCount <= 0) {
      throw new Error("expectedActCount 必须是正整数。");
    }

    if (matchResult.matches.length < expectedActCount - 1) {
      throw new Error(
        `结束语匹配次数不足，无法切出全部幕。预期 ${expectedActCount} 次，实际 ${matchResult.matches.length} 次。`
      );
    }

    if (matchResult.matches.length > expectedActCount) {
      throw new Error(
        `结束语出现次数超过预期，可能误匹配。预期 ${expectedActCount} 次，实际 ${matchResult.matches.length} 次。请输入更完整、更独特的结束语。`
      );
    }
  }

  const startActIndex = input.startActIndex ?? 1;
  if (!Number.isInteger(startActIndex) || startActIndex < 1) throw new Error("startActIndex must be a positive integer");
  const sectionCount = expectedActCount ?? matchResult.matches.length;
  const drafts = Array.from({ length: sectionCount }, (_, index): SectionDraft => {
    const match = matchResult.matches[index];
    const previousMatch = matchResult.matches[index - 1];
    const startOffset = index === 0 ? 0 : previousMatch?.endOffset ?? 0;
    const endOffset = match?.endOffset ?? text.length;
    const textSlice = text.slice(startOffset, endOffset).trim();
    const actIndex = startActIndex + index;

    return {
      uploadedAssetId: textAsset.id,
      parsedDocumentId: parsedDocument.id,
      sectionType: "role_act",
      sectionPurpose: DocumentSectionPurpose.AI_TEXT_SOURCE,
      title: `第${actIndex}幕`,
      roleName,
      actIndex,
      pageStart: null,
      pageEnd: null,
      text: textSlice,
      metadataJson: {
        status: "docx_marker_segmented",
        commonEndMarker: input.commonEndMarker,
        normalizedMarker: matchResult.normalizedMarker,
        markerMatchCount: matchResult.matches.length,
        markerStartOffset: match?.startOffset ?? null,
        markerEndOffset: match?.endOffset ?? null,
        tailSection: !match
      },
      orderIndex: index
    };
  });
  const job = await createSegmentationJobForManualRoleBooklet(
    input.scriptPackageId,
    parsedDocument,
    textAsset.id,
    roleName
  );

  await writeSections(parsedDocument, drafts, undefined, {
      scriptPackageId: input.scriptPackageId,
      uploadedAssetId: textAsset.id,
      roleName,
      sectionType: "role_act",
      sectionPurpose: DocumentSectionPurpose.AI_TEXT_SOURCE
  });
  const sections = await listDocumentSections({
    scriptPackageId: input.scriptPackageId,
    uploadedAssetId: textAsset.id,
    parsedDocumentId: parsedDocument.id
  });

  await updateSegmentationState({
    parsedDocumentId: parsedDocument.id,
    status: DocumentSegmentationStatus.COMPLETED,
    error: null
  });
  await completeSegmentationJob(job.id, job.stepId, {
    status: DocumentSegmentationStatus.COMPLETED,
    sectionsCount: sections.length,
    aiTextSourceStatus: "docx_marker_segmented"
  });

  return {
    sections,
    sectionsCount: sections.length,
    segmentationStatus: DocumentSegmentationStatus.COMPLETED,
    segmentationError: null,
    matchCount: matchResult.matches.length,
    normalizedMarker: matchResult.normalizedMarker
  };
}

async function getParsedDocumentForSegmentation(input: {
  scriptPackageId: string;
  parsedDocumentId: string;
}): Promise<ParsedDocumentWithAsset> {
  const parsedDocument = await prisma.parsedDocument.findFirst({
    where: {
      id: input.parsedDocumentId,
      isActive: true,
      scriptPackageId: input.scriptPackageId
    },
    include: {
      uploadedAsset: true
    }
  });

  if (!parsedDocument) {
    throw new Error(`ParsedDocument not found for id "${input.parsedDocumentId}".`);
  }

  if (parsedDocument.parseStatus !== "COMPLETED") {
    throw new Error("ParsedDocument 尚未完成文本抽取，不能切分章节。");
  }

  if (parsedDocument.qualityStatus === "FAILED") {
    throw new Error("ParsedDocument 文本质量检测未通过，不能自动切分。请上传 DOCX 或重新解析。");
  }

  return parsedDocument;
}

function readPages(parsedDocument: ParsedDocumentWithAsset): ExtractedPdfPage[] {
  const pages = fromJsonValue<ExtractedPdfPage[]>(parsedDocument.pagesJson, []);

  if (pages.length > 0) {
    return pages.map((page) => ({
      ...page,
      text: parsedDocument.normalizedText && pages.length === 1 ? parsedDocument.normalizedText : page.text
    }));
  }

  const text = parsedDocument.normalizedText || parsedDocument.extractedText;

  if (!text.trim()) {
    throw new Error("ParsedDocument 缺少 normalizedText，无法切分章节。");
  }

  return [
    {
      pageNumber: 1,
      text,
      paragraphs: text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean),
      charCount: text.length
    }
  ];
}

function buildAutomaticSectionDrafts(
  parsedDocument: ParsedDocumentWithAsset,
  pages: ExtractedPdfPage[]
): {
  status: DocumentSegmentationStatus;
  error?: string | null;
  sections: SectionDraft[];
} {
  switch (parsedDocument.uploadedAsset.kind) {
    case UploadedAssetKind.ROLE_BOOKLET:
      return {
        status: DocumentSegmentationStatus.NEEDS_MANUAL_SEGMENTATION,
        error: "角色剧本不做自动幕标题切分，请手动输入每一幕起始页码。",
        sections: []
      };
    case UploadedAssetKind.DM_MANUAL:
      return buildDmSections(pages);
    case UploadedAssetKind.CLUE:
      return {
        status: DocumentSegmentationStatus.COMPLETED,
        sections: [
          {
            sectionType: "clue_asset_full_text",
            title: "线索资料全文",
            pageStart: pages[0]?.pageNumber ?? null,
            pageEnd: pages.at(-1)?.pageNumber ?? null,
            text: pages.map((page) => page.text).join("\n\n").trim(),
            orderIndex: 0
          }
        ]
      };
    case UploadedAssetKind.IMAGE:
    case UploadedAssetKind.OTHER:
    default:
      return {
        status: DocumentSegmentationStatus.COMPLETED,
        error: "当前资料类型不做章节切分。",
        sections: []
      };
  }
}

function readPagesFromParsedDocument(
  parsedDocument: Pick<ParsedDocument, "pagesJson" | "normalizedText" | "extractedText">
): ExtractedPdfPage[] {
  const pages = fromJsonValue<ExtractedPdfPage[]>(parsedDocument.pagesJson, []);

  if (pages.length > 0) {
    return pages.map((page) => ({
      ...page,
      text: parsedDocument.normalizedText && pages.length === 1 ? parsedDocument.normalizedText : page.text
    }));
  }

  const text = parsedDocument.normalizedText || parsedDocument.extractedText;

  return text.trim()
    ? [
        {
          pageNumber: 1,
          text,
          paragraphs: text
            .split(/\n{2,}/)
            .map((paragraph) => paragraph.trim())
            .filter(Boolean),
          charCount: text.length
        }
      ]
    : [];
}

async function findLatestParsedDocumentForAsset(
  scriptPackageId: string,
  uploadedAssetId: string
): Promise<ParsedDocument | null> {
  return prisma.parsedDocument.findFirst({
    where: {
      scriptPackageId,
      uploadedAssetId,
      isActive: true
    },
    orderBy: { updatedAt: "desc" }
  });
}

function isPdfAsset(asset: Pick<UploadedAsset, "mimeType" | "originalName">): boolean {
  return asset.mimeType === "application/pdf" || asset.originalName.toLowerCase().endsWith(".pdf");
}

function isDocxAsset(asset: Pick<UploadedAsset, "mimeType" | "originalName">): boolean {
  return (
    asset.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    asset.originalName.toLowerCase().endsWith(".docx")
  );
}

export function findAllMarkersInText(rawText: string, marker: string): MarkerMatchResult {
  const normalizedText = normalizeTextForMarkerSearch(rawText);
  const normalizedMarker = normalizeTextForMarkerSearch(marker).normalized;

  if (!normalizedMarker) {
    return {
      status: "not_found",
      matches: [],
      normalizedMarker,
      message: "请填写统一每幕结束语。"
    };
  }

  if (normalizedMarker.length < 6) {
    return {
      status: "not_found",
      matches: [],
      normalizedMarker,
      message: "结束语太短，容易误匹配。请填写更完整、更独特的一句话。"
    };
  }

  const matches: MarkerMatchResult["matches"] = [];
  let searchIndex = 0;

  while (searchIndex < normalizedText.normalized.length) {
    const matchIndex = normalizedText.normalized.indexOf(normalizedMarker, searchIndex);

    if (matchIndex === -1) {
      break;
    }

    const startOffset = normalizedText.offsets[matchIndex] ?? 0;
    const endSourceIndex = normalizedText.offsets[matchIndex + normalizedMarker.length - 1] ?? startOffset;
    const endOffset = endSourceIndex + 1;

    matches.push({
      startOffset,
      endOffset,
      matchedTextPreview: rawText.slice(startOffset, endOffset).replace(/\s+/g, " ").slice(0, 80)
    });
    searchIndex = matchIndex + normalizedMarker.length;
  }

  if (matches.length === 0) {
    return {
      status: "not_found",
      matches,
      normalizedMarker,
      message: "未找到统一结束语。请检查结束语是否准确，或输入更完整、更独特的结束语。"
    };
  }

  return {
    status: "matched",
    matches,
    normalizedMarker,
    message: `找到 ${matches.length} 次结束语。`
  };
}

function normalizeTextForMarkerSearch(value: string): { normalized: string; offsets: number[] } {
  const offsets: number[] = [];
  let normalized = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? "";
    const normalizedChar = normalizeMarkerChar(char);

    if (!normalizedChar) {
      continue;
    }

    normalized += normalizedChar;
    offsets.push(index);
  }

  return {
    normalized,
    offsets
  };
}

function normalizeMarkerChar(char: string): string {
  if (/\s/u.test(char)) {
    return "";
  }

  const punctuationMap: Record<string, string> = {
    "，": ",",
    "。": ".",
    "！": "!",
    "？": "?",
    "：": ":",
    "；": ";",
    "（": "(",
    "）": ")",
    "【": "[",
    "】": "]",
    "“": "\"",
    "”": "\"",
    "‘": "'",
    "’": "'",
    "、": ",",
    "—": "-",
    "－": "-",
    "　": ""
  };

  return (punctuationMap[char] ?? char).toLowerCase();
}

function buildRoleActSections(
  asset: UploadedAsset,
  pages: ExtractedPdfPage[]
): {
  status: DocumentSegmentationStatus;
  error?: string;
  sections: SectionDraft[];
} {
  const documentText = buildDocumentText(pages);
  const headings = findRoleActHeadings(pages, documentText.pageRanges);

  if (headings.length < 2) {
    return {
      status: DocumentSegmentationStatus.NEEDS_MANUAL_SEGMENTATION,
      error: headings.length === 1 ? ROLE_SINGLE_HEADING_ERROR : ROLE_NO_HEADING_ERROR,
      sections: []
    };
  }

  const roleName = getRoleName(asset);

  return {
    status: DocumentSegmentationStatus.COMPLETED,
    sections: headings.map((heading, index) => {
      const nextHeading = headings[index + 1];
      const start = heading.index;
      const end = nextHeading ? nextHeading.index : documentText.text.length;
      const text = documentText.text.slice(start, end).trim();
      const range = getPageSpanForSlice(documentText.pageRanges, start, end);

      return {
        sectionType: "role_act",
        title: heading.title,
        roleName,
        actIndex: heading.actIndex ?? index + 1,
        pageStart: range.pageStart,
        pageEnd: range.pageEnd,
        text,
        orderIndex: index
      };
    })
  };
}

function buildDmSections(pages: ExtractedPdfPage[]): {
  status: DocumentSegmentationStatus;
  error?: string | null;
  sections: SectionDraft[];
} {
  const documentText = buildDocumentText(pages);
  const headings = findDmFlowHeadings(pages, documentText.pageRanges);

  if (headings.length === 0) {
    return {
      status: DocumentSegmentationStatus.COMPLETED,
      sections: [
        {
          sectionType: "dm_other",
          title: "未识别主流程段",
          pageStart: pages[0]?.pageNumber ?? null,
          pageEnd: pages.at(-1)?.pageNumber ?? null,
          text: documentText.text.trim(),
          orderIndex: 0
        }
      ]
    };
  }

  const sections: SectionDraft[] = [];

  if (headings[0] && headings[0].index > 0) {
    const prefaceText = documentText.text.slice(0, headings[0].index).trim();

    if (prefaceText) {
      const range = getPageSpanForSlice(documentText.pageRanges, 0, headings[0].index);

      sections.push({
        sectionType: "dm_other",
        title: "主流程前资料",
        pageStart: range.pageStart,
        pageEnd: range.pageEnd,
        text: prefaceText,
        orderIndex: sections.length
      });
    }
  }

  for (const [index, heading] of headings.entries()) {
    const nextHeading = headings[index + 1];
    const start = heading.index;
    const end = nextHeading ? nextHeading.index : documentText.text.length;
    const text = documentText.text.slice(start, end).trim();
    const range = getPageSpanForSlice(documentText.pageRanges, start, end);

    sections.push({
      sectionType: heading.sectionType ?? "dm_other",
      title: heading.title,
      actIndex: heading.actIndex,
      pageStart: range.pageStart,
      pageEnd: range.pageEnd,
      text,
      orderIndex: sections.length
    });
  }

  return {
    status: DocumentSegmentationStatus.COMPLETED,
    sections
  };
}

function findRoleActHeadings(pages: ExtractedPdfPage[], pageRanges: PageRange[]): Heading[] {
  const headings: Heading[] = [];

  for (const [pageIndex, page] of pages.entries()) {
    const pageStart = pageRanges[pageIndex]?.start ?? 0;
    const lines = iterateLines(page.text);

    for (const line of lines) {
      const parsed = parseRoleActHeading(line.text);

      if (parsed) {
        headings.push({
          title: parsed.title,
          actIndex: parsed.actIndex,
          index: pageStart + line.index,
          pageNumber: page.pageNumber
        });
      }
    }
  }

  return normalizeDmFlowHeadings(dedupeHeadings(headings));
}

function findDmFlowHeadings(pages: ExtractedPdfPage[], pageRanges: PageRange[]): Heading[] {
  const headings: Heading[] = [];

  for (const [pageIndex, page] of pages.entries()) {
    const pageStart = pageRanges[pageIndex]?.start ?? 0;
    const lines = iterateLines(page.text);

    for (const line of lines) {
      const parsed = parseDmHeading(line.text);

      if (parsed) {
        headings.push({
          ...parsed,
          index: pageStart + line.index,
          pageNumber: page.pageNumber
        });
      }
    }
  }

  return dedupeHeadings(headings);
}

function parseRoleActHeading(line: string): { title: string; actIndex: number | null } | null {
  const text = line.trim();

  if (!text || text.length > 80) {
    return null;
  }

  const match = matchActHeading(text);

  if (!match) {
    return null;
  }

  return {
    title: text,
    actIndex: parseActIndex(match.actIndexText)
  };
}

function parseDmHeading(
  line: string
): { title: string; sectionType: string; actIndex: number | null } | null {
  const text = line.trim();

  if (!text || text.length > 80) {
    return null;
  }

  const bracketMainFlowMatch = text.match(/^【\s*(\d+)\s*】\s*(.+)$/);

  if (bracketMainFlowMatch) {
    const bracketIndex = Number(bracketMainFlowMatch[1]);
    const bracketTitle = bracketMainFlowMatch[2]?.trim() ?? "";
    const bracketActMatch = matchActHeading(bracketTitle);

    if (bracketActMatch) {
      return {
        title: text,
        sectionType: "dm_act",
        actIndex: parseActIndex(bracketActMatch.actIndexText)
      };
    }

    if (bracketIndex === 0) {
      return {
        title: text,
        sectionType: "dm_opening",
        actIndex: 0
      };
    }

    return null;
  }

  if (/^(开场|开场白|破冰|Opening)(?=\s|:|：|-|—|$)/i.test(text)) {
    return { title: text, sectionType: "dm_opening", actIndex: 0 };
  }

  const actMatch = matchActHeading(text);

  if (actMatch) {
    return {
      title: text,
      sectionType: "dm_act",
      actIndex: parseActIndex(actMatch.actIndexText)
    };
  }

  if (/^(复盘|真相|结局|Ending|Reveal)(?=\s|:|：|-|—|$)/i.test(text)) {
    return { title: text, sectionType: "dm_ending", actIndex: null };
  }

  if (/^(注意事项|DM\s*须知|物料准备|人物介绍|背景介绍|游戏说明)(?=\s|:|：|-|—|$)/i.test(text)) {
    return { title: text, sectionType: "dm_notes", actIndex: null };
  }

  return null;
}

function normalizeDmFlowHeadings(headings: Heading[]): Heading[] {
  const normalized: Heading[] = [];
  let currentActIndex: number | null = null;

  for (const heading of headings) {
    if (heading.sectionType !== "dm_act") {
      normalized.push(heading);
      continue;
    }

    if (!heading.actIndex) {
      normalized.push(heading);
      continue;
    }

    if (currentActIndex === null || heading.actIndex > currentActIndex) {
      normalized.push(heading);
      currentActIndex = heading.actIndex;
    }
  }

  return normalized;
}

function matchActHeading(text: string): { actIndexText: string } | null {
  const match = text.match(
    /^(?:第\s*([一二三四五六七八九十\d]+)\s*幕|(?:Part|Act)\s+(\d+|[IVX]+|One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten))(?=\s|:|：|-|—|流程|$)/i
  );

  if (!match) {
    return null;
  }

  return {
    actIndexText: match[1] ?? match[2] ?? ""
  };
}

function buildDocumentText(pages: ExtractedPdfPage[]): { text: string; pageRanges: PageRange[] } {
  const chunks: string[] = [];
  const pageRanges: PageRange[] = [];
  let offset = 0;

  for (const page of pages) {
    const text = page.text ?? "";
    const start = offset;

    chunks.push(text);
    offset += text.length;
    pageRanges.push({
      pageNumber: page.pageNumber,
      start,
      end: offset
    });

    if (page !== pages.at(-1)) {
      chunks.push("\n\n");
      offset += 2;
    }
  }

  return {
    text: chunks.join(""),
    pageRanges
  };
}

function iterateLines(text: string): Array<{ text: string; index: number }> {
  const lines: Array<{ text: string; index: number }> = [];
  let index = 0;

  for (const value of text.split(/\r?\n/)) {
    const lineIndex = index;

    if (value.trim()) {
      lines.push({ text: value, index: lineIndex });
    }

    index += value.length + 1;
  }

  return lines;
}

function dedupeHeadings(headings: Heading[]): Heading[] {
  const result: Heading[] = [];

  for (const heading of headings.sort((a, b) => a.index - b.index)) {
    const previous = result.at(-1);

    if (previous && previous.index === heading.index && previous.title === heading.title) {
      continue;
    }

    result.push(heading);
  }

  return result;
}

function getPageSpanForSlice(
  pageRanges: PageRange[],
  start: number,
  end: number
): { pageStart: number | null; pageEnd: number | null } {
  const overlapping = pageRanges.filter((range) => range.end > start && range.start < end);

  return {
    pageStart: overlapping[0]?.pageNumber ?? null,
    pageEnd: overlapping.at(-1)?.pageNumber ?? null
  };
}

function getTextByPageRange(
  pages: ExtractedPdfPage[],
  pageStart: number,
  pageEnd: number
): string {
  return pages
    .filter((page) => page.pageNumber >= pageStart && page.pageNumber <= pageEnd)
    .map((page) => page.text)
    .join("\n\n")
    .trim();
}

function normalizeManualActStarts(
  starts: ManualRoleActInput["actStartPages"],
  pageCount: number
): Array<{ actIndex: number; pageStart: number; title?: string | null }> {
  if (!Array.isArray(starts) || starts.length === 0) {
    throw new Error("请至少输入一幕的起始页码。");
  }

  const seenPages = new Set<number>();
  let previousPage = 0;

  return starts.map((start) => {
    const actIndex = Number(start.actIndex);
    const pageStart = Number(start.pageStart);

    if (!Number.isInteger(actIndex) || actIndex <= 0) {
      throw new Error("actIndex 必须是正整数。");
    }

    if (!Number.isInteger(pageStart) || pageStart < 1 || pageStart > pageCount) {
      throw new Error(`pageStart 必须在 1 到 ${pageCount} 之间。`);
    }

    if (seenPages.has(pageStart)) {
      throw new Error("每一幕起始页码不能重复。");
    }

    if (pageStart <= previousPage) {
      throw new Error("actStartPages 必须按 pageStart 递增。");
    }

    seenPages.add(pageStart);
    previousPage = pageStart;

    return {
      actIndex,
      pageStart,
      title: start.title
    };
  });
}

function parseActIndex(value: string): number | null {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return null;
  }

  const numeric = Number(normalized);

  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric;
  }

  const english: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10
  };

  if (english[normalized]) {
    return english[normalized];
  }

  const roman = parseRomanNumeral(normalized.toUpperCase());

  if (roman) {
    return roman;
  }

  return parseChineseNumeral(normalized);
}

function parseRomanNumeral(value: string): number | null {
  const values: Record<string, number> = { I: 1, V: 5, X: 10 };
  let total = 0;
  let previous = 0;

  if (!/^[IVX]+$/.test(value)) {
    return null;
  }

  for (const char of [...value].reverse()) {
    const current = values[char] ?? 0;

    total += current < previous ? -current : current;
    previous = current;
  }

  return total > 0 ? total : null;
}

function parseChineseNumeral(value: string): number | null {
  const text = value.replace(/\s/g, "");
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };

  if (digits[text]) {
    return digits[text];
  }

  if (text === "十") {
    return 10;
  }

  const tenIndex = text.indexOf("十");

  if (tenIndex !== -1) {
    const before = text.slice(0, tenIndex);
    const after = text.slice(tenIndex + 1);
    const tens = before ? digits[before] ?? 0 : 1;
    const ones = after ? digits[after] ?? 0 : 0;
    const total = tens * 10 + ones;

    return total > 0 ? total : null;
  }

  return null;
}

function getRoleName(asset: UploadedAsset): string {
  return normalizeRoleName(asset.roleName) ?? fallbackRoleNameFromFile(asset.originalName);
}

function normalizeRoleName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function fallbackRoleNameFromFile(fileName: string): string {
  const extension = extname(fileName);
  const rawName = basename(fileName, extension);
  const cleaned = rawName
    .replace(/角色本|剧本|人物本|玩家手册|player|booklet/gi, "")
    .replace(/[_\-—]+/g, " ")
    .trim();

  return cleaned || rawName || "未命名角色";
}

function normalizeTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

async function writeSections(
  parsedDocument: Pick<ParsedDocument, "id" | "scriptPackageId" | "uploadedAssetId">,
  sections: SectionDraft[],
  expectedRevision?: number,
  replaceWhere?: import("@prisma/client").Prisma.DocumentSectionWhereInput
): Promise<DocumentSectionView[]> {
  if (sections.length > 0) {
    await prisma.$transaction(async tx => {
      if (replaceWhere) {
        await retireSections(tx, replaceWhere);
        for (const id of new Set([parsedDocument.id, ...sections.map(s => s.parsedDocumentId ?? parsedDocument.id)])) {
          const updated = await tx.parsedDocument.update({ where: { id }, data: { sectionSetRevision: { increment: 1 } } });
          // Unchanged role-display sections remain in the new set; retired rows retain their old revision.
          await tx.documentSection.updateMany({ where: { parsedDocumentId: id, isActive: true }, data: { sectionSetRevision: updated.sectionSetRevision } });
        }
      }
      const root = await tx.parsedDocument.findUniqueOrThrow({ where: { id: parsedDocument.id } });
      if (!root.isActive || expectedRevision !== undefined && root.sectionSetRevision !== expectedRevision) throw new Error("切分来源 revision 已变化，拒绝发布旧 section set。");
      const data = [];
      for (const [index, section] of sections.entries()) {
        const doc = section.parsedDocumentId && section.parsedDocumentId !== root.id
          ? await tx.parsedDocument.findUniqueOrThrow({ where: { id: section.parsedDocumentId } }) : root;
        if (!doc.isActive) throw new Error("切分来源文档已过期。");
        data.push({
        scriptPackageId: parsedDocument.scriptPackageId,
        uploadedAssetId: section.uploadedAssetId ?? parsedDocument.uploadedAssetId,
        parsedDocumentId: section.parsedDocumentId ?? parsedDocument.id,
        sectionType: section.sectionType,
        sectionPurpose: section.sectionPurpose ?? DocumentSectionPurpose.CONTENT,
        title: section.title,
        roleName: section.roleName ?? null,
        actIndex: section.actIndex ?? null,
        pageStart: section.pageStart ?? null,
        pageEnd: section.pageEnd ?? null,
        text: section.text,
        metadataJson:
          section.metadataJson === undefined ? null : toJsonInput(section.metadataJson),
        orderIndex: section.orderIndex ?? index,
        sectionSetRevision: doc.sectionSetRevision,
        sourceSpanJson: toJsonInput(locateSourceSpan(doc.normalizedText || doc.extractedText, section.text))
      });
      }
      await tx.documentSection.createMany({ data });
    });
  }

  return listDocumentSections({
    scriptPackageId: parsedDocument.scriptPackageId,
    parsedDocumentId: parsedDocument.id
  });
}

async function createSegmentationJobForManualRoleBooklet(
  scriptPackageId: string,
  parsedDocument: Pick<ParsedDocument, "id" | "uploadedAssetId">,
  textAssetId: string | null,
  roleName: string
): Promise<{ id: string; stepId: string | null }> {
  const job = await prisma.ingestionJob.create({
    data: {
      scriptPackageId,
      status: IngestionJobStatus.RUNNING,
      currentStep: "section_segmentation",
      inputJson: toJsonInput({
        mode: "manual_role_booklet_acts",
        roleName,
        displayParsedDocumentId: parsedDocument.id,
        displayAssetId: parsedDocument.uploadedAssetId,
        textAssetId
      }),
      steps: {
        create: {
          stepName: "section_segmentation",
          status: IngestionJobStatus.RUNNING,
          inputJson: toJsonInput({
            mode: "manual_role_booklet_acts",
            roleName,
            displayParsedDocumentId: parsedDocument.id,
            displayAssetId: parsedDocument.uploadedAssetId,
            textAssetId
          }),
          startedAt: new Date()
        }
      }
    },
    include: { steps: true }
  });

  return {
    id: job.id,
    stepId: job.steps[0]?.id ?? null
  };
}

async function updateSegmentationState(input: {
  parsedDocumentId: string;
  status: DocumentSegmentationStatus;
  error: string | null | undefined;
}): Promise<void> {
  await prisma.parsedDocument.update({
    where: { id: input.parsedDocumentId },
    data: {
      segmentationStatus: input.status,
      segmentationError: input.error ?? null
    }
  });
}

async function createSegmentationJob(
  parsedDocument: ParsedDocumentWithAsset,
  mode: "auto" | "manual_role_acts"
): Promise<{ id: string; stepId: string | null }> {
  const job = await prisma.ingestionJob.create({
    data: {
      scriptPackageId: parsedDocument.scriptPackageId,
      status: IngestionJobStatus.RUNNING,
      currentStep: "section_segmentation",
      inputJson: toJsonInput({
        mode,
        parsedDocumentId: parsedDocument.id,
        uploadedAssetId: parsedDocument.uploadedAssetId,
        assetKind: parsedDocument.uploadedAsset.kind
      }),
      steps: {
        create: {
          stepName: "section_segmentation",
          status: IngestionJobStatus.RUNNING,
          inputJson: toJsonInput({
            mode,
            parsedDocumentId: parsedDocument.id,
            uploadedAssetId: parsedDocument.uploadedAssetId
          }),
          startedAt: new Date()
        }
      }
    },
    include: { steps: true }
  });

  return {
    id: job.id,
    stepId: job.steps[0]?.id ?? null
  };
}

async function completeSegmentationJob(
  jobId: string,
  stepId: string | null,
  output: {
    status: DocumentSegmentationStatus;
    sectionsCount: number;
    errorMessage?: string | null;
    aiTextSourceStatus?: string;
  }
): Promise<void> {
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionJobStatus.COMPLETED,
      outputJson: toJsonInput(output),
      errorMessage: output.errorMessage ?? null
    }
  });

  if (stepId) {
    await prisma.ingestionStepRun.update({
      where: { id: stepId },
      data: {
        status: IngestionJobStatus.COMPLETED,
        outputJson: toJsonInput(output),
        errorMessage: output.errorMessage ?? null,
        finishedAt: new Date()
      }
    });
  }
}

async function failSegmentationJob(
  jobId: string,
  stepId: string | null,
  message: string
): Promise<void> {
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionJobStatus.FAILED,
      errorMessage: message
    }
  });

  if (stepId) {
    await prisma.ingestionStepRun.update({
      where: { id: stepId },
      data: {
        status: IngestionJobStatus.FAILED,
        errorMessage: message,
        finishedAt: new Date()
      }
    });
  }
}
