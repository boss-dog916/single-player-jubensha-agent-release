import "server-only";

import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { extractPdfText, MAX_DECODED_STREAM_BYTES, type ExtractedPdfPage } from "@/src/lib/ingestion/pdfTextExtractor";

export type TextQualityStatus = "pass" | "warning" | "failed";

export type ExtractedDocumentBlock = {
  type: "paragraph";
  text: string;
  orderIndex: number;
  style?: string | null;
  sourceParagraphIndex?: number;
  headingLevel?: number | null;
};

export type DocumentTextExtractionResult = {
  rawText: string;
  normalizedText: string;
  blocksJson?: ExtractedDocumentBlock[];
  pagesJson?: ExtractedPdfPage[];
  pageCount?: number;
  charCount: number;
  extractorName: "pdf-compatible" | "docx-mammoth-compatible" | string;
  qualityStatus: TextQualityStatus;
  qualityWarnings: string[];
  elapsedMs: number;
};

export async function extractDocumentText(input: {
  filePath: string;
  mimeType: string | null;
  originalName: string;
}): Promise<DocumentTextExtractionResult> {
  const startedAt = Date.now();

  if (isDocxAsset(input.mimeType, input.originalName)) {
    return withElapsed(await extractDocxText(input.filePath), startedAt);
  }

  if (isPdfAsset(input.mimeType, input.originalName)) {
    return withElapsed(await extractPdfDocumentText(input.filePath), startedAt);
  }

  throw new Error("当前阶段仅支持 DOCX 和可复制文本 PDF。");
}

export function isSupportedTextAsset(mimeType: string | null, originalName: string): boolean {
  return isPdfAsset(mimeType, originalName) || isDocxAsset(mimeType, originalName);
}

export function isPdfAsset(mimeType: string | null, originalName: string): boolean {
  return mimeType === "application/pdf" || originalName.toLowerCase().endsWith(".pdf");
}

export function isDocxAsset(mimeType: string | null, originalName: string): boolean {
  return (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    originalName.toLowerCase().endsWith(".docx")
  );
}

async function extractPdfDocumentText(filePath: string): Promise<Omit<DocumentTextExtractionResult, "elapsedMs">> {
  const pdf = await extractPdfText(filePath);
  const rawText = pdf.extractedText;
  const normalizedText = normalizePdfText(rawText);
  const quality = evaluateTextQuality({
    rawText,
    normalizedText,
    sourceType: "pdf"
  });

  return {
    rawText,
    normalizedText,
    pagesJson: pdf.pages.map((page) => ({
      ...page,
      text: normalizePdfText(page.text),
      paragraphs: normalizePdfText(page.text)
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
    })),
    pageCount: pdf.pageCount,
    charCount: normalizedText.length,
    extractorName: "pdf-compatible",
    qualityStatus: quality.status,
    qualityWarnings: [
      ...quality.warnings,
      "PDF 文本结构可能不稳定，建议上传 DOCX。"
    ]
  };
}

async function extractDocxText(filePath: string): Promise<Omit<DocumentTextExtractionResult, "elapsedMs">> {
  const buffer = await readFile(filePath);
  const documentXml = extractZipTextFile(buffer, "word/document.xml");

  if (!documentXml) {
    return {
      rawText: "",
      normalizedText: "",
      blocksJson: [],
      charCount: 0,
      extractorName: "docx-mammoth-compatible",
      qualityStatus: "failed",
      qualityWarnings: ["DOCX 中未找到 word/document.xml。"]
    };
  }

  const blocks = extractDocxParagraphs(documentXml);
  const normalizedText = blocks.map((block) => block.text).filter(Boolean).join("\n");
  const quality = evaluateTextQuality({
    rawText: normalizedText,
    normalizedText,
    sourceType: "docx"
  });

  return {
    rawText: normalizedText,
    normalizedText,
    blocksJson: blocks,
    charCount: normalizedText.length,
    extractorName: "docx-mammoth-compatible",
    qualityStatus: quality.status,
    qualityWarnings: quality.warnings
  };
}

function withElapsed<T extends Omit<DocumentTextExtractionResult, "elapsedMs">>(
  result: T,
  startedAt: number
): DocumentTextExtractionResult {
  return {
    ...result,
    elapsedMs: Date.now() - startedAt
  };
}

export function normalizePdfText(value: string): string {
  return value
    .replace(/【\s*([0-9]+(?:-[0-9]+)?)\s*\n\s*】/g, "【$1】")
    .replace(/【\s*([0-9]+(?:-[0-9]+)?)\s*】/g, "【$1】")
    .replace(/《([^《》\n]{1,24})\s*\n\s*》/g, "《$1》")
    .replace(/([0-9])\s*\n\s*([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/\b([A-Za-z]{1,5})\s*\n\s*([\u4e00-\u9fa5])/g, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function evaluateTextQuality(input: {
  rawText: string;
  normalizedText: string;
  sourceType: "pdf" | "docx";
}): { status: TextQualityStatus; warnings: string[] } {
  const warnings: string[] = [];
  const text = input.normalizedText.trim();
  const cidCount = countMatches(input.rawText, /\(cid:\d+\)/g);
  const replacementCount = countMatches(input.rawText, /�/g);
  const brokenBracketCount = countMatches(input.rawText, /【\s*\d+(?:-\d+)?\s*\n\s*】/g);
  const shortLineRatio = getShortLineRatio(input.rawText);
  const hasFlowHeading = /(^|\n)\s*(?:【\d+】|第\s*[一二三四五六七八九十\d]+\s*幕|开场|复盘|真相|结局)/.test(
    input.normalizedText
  );

  if (!text) {
    return {
      status: "failed",
      warnings:
        input.sourceType === "pdf"
          ? ["PDF 中没有抽取到足够可复制文本，可能是扫描版 PDF；已保留页数，可用于玩家 PDF 页码分幕。OCR 将在后续阶段实现。"]
          : ["未抽取到文本。"]
    };
  }

  if (input.sourceType === "pdf" && text.length < 20) {
    return {
      status: "failed",
      warnings: [
        "PDF 中没有抽取到足够可复制文本，可能是扫描版 PDF；已保留页数，可用于玩家 PDF 页码分幕。OCR 将在后续阶段实现。"
      ]
    };
  }

  if (cidCount >= 10) {
    return { status: "failed", warnings: ["文本中出现大量 cid 编码，无法可靠解析。"] };
  }

  if (replacementCount >= 10 || replacementCount / Math.max(input.rawText.length, 1) > 0.02) {
    return { status: "failed", warnings: ["文本中出现大量乱码替换字符。"] };
  }

  if (input.sourceType === "pdf") {
    if (brokenBracketCount > 0) {
      warnings.push("PDF 中存在标题编号断裂，已尝试修复。");
    }

    if (shortLineRatio > 0.45) {
      warnings.push("PDF 存在较多短行断裂，标题或段落可能不稳定。");
    }
  }

  if (!hasFlowHeading) {
    warnings.push("未识别到明显主流程标题候选。");
  }

  return {
    status: warnings.length > 0 ? "warning" : "pass",
    warnings
  };
}

function getShortLineRatio(value: string): number {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 10) {
    return 0;
  }

  const shortLines = lines.filter((line) => line.length <= 4).length;

  return shortLines / lines.length;
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function extractDocxParagraphs(documentXml: string): ExtractedDocumentBlock[] {
  const paragraphs: ExtractedDocumentBlock[] = [];
  type Frame = { parts: string[]; index: number; style: string | null; headingLevel: number | null };
  const stack: Frame[] = [];
  let nextIndex = 0;
  const flush = (frame: Frame) => {
    const text = frame.parts.join("").trim();
    frame.parts = [];
    if (text) paragraphs.push({ type: "paragraph", text, orderIndex: paragraphs.length,
      style: frame.style, sourceParagraphIndex: frame.index, headingLevel: frame.headingLevel });
  };
  // Text boxes contain w:p inside an outer w:p. Walk paragraph boundaries in
  // document order; flush the parent's prefix before the child and its suffix
  // afterwards. A non-recursive paragraph regex loses that suffix. Text tokens
  // are consumed once, so nested text is neither dropped nor counted twice.
  const tokens = /<w:p\b[^>]*>|<\/w:p\s*>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:(?:tab|br|pStyle|outlineLvl)\b[^>]*\/>/g;
  for (const token of documentXml.matchAll(tokens)) {
    const xml = token[0];
    if (/^<w:p\b/.test(xml)) {
      if (stack.length) flush(stack[stack.length - 1]);
      const frame: Frame = { parts: [], index: nextIndex++, style: null, headingLevel: null };
      if (!/\/\s*>$/.test(xml)) stack.push(frame);
      continue;
    }
    if (/^<\/w:p/.test(xml)) { const frame = stack.pop(); if (frame) flush(frame); continue; }
    const frame = stack[stack.length - 1];
    if (!frame) continue;
    if (/^<w:t\b/.test(xml)) frame.parts.push(decodeXmlEntities(token[1] ?? ""));
    else if (/^<w:tab\b/.test(xml)) frame.parts.push("\t");
    else if (/^<w:br\b/.test(xml)) frame.parts.push("\n");
    else if (/^<w:pStyle\b/.test(xml)) frame.style = xml.match(/w:val="([^"]+)"/)?.[1] ?? null;
    else if (/^<w:outlineLvl\b/.test(xml)) frame.headingLevel = Number(xml.match(/w:val="(\d+)"/)?.[1] ?? 0);
  }
  while (stack.length) flush(stack.pop()!);
  return paragraphs;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function extractZipTextFile(buffer: Buffer, fileName: string): string | null {
  const entries = readZipEntries(buffer);
  const entry = entries.find((candidate) => candidate.fileName === fileName);

  if (!entry) {
    return null;
  }

  const compressed = buffer.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    if (compressed.length > MAX_DECODED_STREAM_BYTES) throw new Error("DOCX正文超过32MiB解析上限。");
    return compressed.toString("utf8");
  }

  if (entry.compressionMethod === 8) {
    try { return inflateRawSync(compressed, { maxOutputLength: MAX_DECODED_STREAM_BYTES }).toString("utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new Error("DOCX正文超过32MiB解析上限。");
      throw error;
    }
  }

  throw new Error(`DOCX 使用了暂不支持的压缩方式：${entry.compressionMethod}。`);
}

function readZipEntries(buffer: Buffer): Array<{
  fileName: string;
  compressionMethod: number;
  compressedSize: number;
  dataStart: number;
}> {
  const entries: Array<{
    fileName: string;
    compressionMethod: number;
    compressedSize: number;
    dataStart: number;
  }> = [];
  let offset = 0;

  while (offset + 30 < buffer.length) {
    const signature = buffer.readUInt32LE(offset);

    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const fileNameStart = offset + 30;
    const fileName = buffer.subarray(fileNameStart, fileNameStart + fileNameLength).toString("utf8");
    const dataStart = fileNameStart + fileNameLength + extraLength;

    entries.push({
      fileName,
      compressionMethod,
      compressedSize,
      dataStart
    });

    offset = dataStart + compressedSize;
  }

  return entries;
}
