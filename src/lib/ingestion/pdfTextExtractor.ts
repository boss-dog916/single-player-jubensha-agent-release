import "server-only";

import { inflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";

export const MAX_DECODED_STREAM_BYTES = 32 * 1024 * 1024;

export type ExtractedPdfPage = {
  pageNumber: number;
  text: string;
  paragraphs: string[];
  charCount: number;
};

export type PdfTextExtractionResult = {
  locatorVersion: string;
  layoutFidelity: "unsupported";
  pageCount: number;
  charCount: number;
  extractedText: string;
  pages: ExtractedPdfPage[];
  warning?: string;
};

type PdfTextContext = {
  fontMapsByResourceName: Map<string, ToUnicodeMap>;
  fontMapsByObjectId: Map<string, ToUnicodeMap>;
  winAnsiFontObjectIds: Set<string>;
  winAnsiResourceNames: Set<string>;
};
export const PDF_TEXT_LOCATOR_VERSION = "pdf-text-v2-cmap-tree";

type PdfObject = {
  body: string;
  dictionary: string;
  stream: string | null;
};

type ToUnicodeMap = {
  codeLength: number;
  values: Map<string, string>;
};

export async function extractPdfText(filePath: string): Promise<PdfTextExtractionResult> {
  const buffer = await readFile(filePath);
  const source = buffer.toString("latin1");

  if (!source.startsWith("%PDF-")) {
    throw new Error("上传文件不是有效 PDF。");
  }

  const pageCount = Math.max(countPdfPages(source), 1);
  const objects = parsePdfObjects(source);
  const context = buildTextContext(source, objects);
  const pages = extractPagesFromPageObjects(objects, context);
  const normalizedPages =
    pages.length > 0 ? pages : splitIntoPages(normalizeExtractedText(extractTextFromStreams(source, context).join("\n\n")), pageCount);
  const charCount = normalizedPages.reduce((sum, page) => sum + page.charCount, 0);

  return {
    locatorVersion: PDF_TEXT_LOCATOR_VERSION,
    layoutFidelity: "unsupported",
    pageCount,
    charCount,
    extractedText: normalizedPages.map((page) => page.text).join("\n\n"),
    pages: normalizedPages,
    warning: charCount < 80 ? "抽取文本较少，请确认该 PDF 不是扫描版或图片型 PDF。" : undefined
  };
}

function countPdfPages(source: string): number {
  const matches = source.match(/\/Type\s*\/Page(?!s)\b/g);

  return matches?.length ?? 0;
}

function extractTextFromStreams(source: string, context: PdfTextContext): string[] {
  const texts: string[] = [];
  const regex = /<<(.*?)>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const dictionary = match[1] ?? "";
    const rawStream = match[2] ?? "";
    const stream = decodeStream(dictionary, rawStream);

    if (!stream || !containsTextOperator(stream)) {
      continue;
    }

    const text = extractTextOperators(stream, context);

    if (text.trim()) {
      texts.push(text);
    }
  }

  return texts;
}

function decodeStream(dictionary: string, rawStream: string): string | null {
  const raw = Buffer.from(rawStream, "latin1");

  if (!dictionary.includes("/FlateDecode")) {
    if (raw.length > MAX_DECODED_STREAM_BYTES) throw new Error("PDF单个内容流超过32MiB解析上限。");
    return rawStream;
  }

  try {
    return inflateSync(raw, { maxOutputLength: MAX_DECODED_STREAM_BYTES }).toString("latin1");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new Error("PDF单个内容流超过32MiB解析上限。");
    return null;
  }
}

function buildTextContext(source: string, objects: Map<string, PdfObject>): PdfTextContext {
  const toUnicodeMapsByObjectId = new Map<string, ToUnicodeMap>();
  const fontObjectIdsByResourceName = parseFontResourceMap(source);
  const fontMapsByResourceName = new Map<string, ToUnicodeMap>();
  const fontMapsByObjectId = new Map<string, ToUnicodeMap>();
  const winAnsiFontObjectIds = new Set<string>();
  const winAnsiResourceNames = new Set<string>();

  for (const [objectId, object] of objects.entries()) {
    const stream = object.stream ? decodeStream(object.dictionary, object.stream) : null;

    if (stream?.includes("begincmap")) {
      toUnicodeMapsByObjectId.set(objectId, parseToUnicodeCMap(stream));
    }
  }

  for (const [fontObjectId, fontObject] of objects.entries()) {
    if (/\/Encoding\s*\/WinAnsiEncoding\b/.test(fontObject.body)) winAnsiFontObjectIds.add(fontObjectId);
    const toUnicodeRef = fontObject.body.match(/\/ToUnicode\s+(\d+)\s+(\d+)\s+R/);
    const toUnicodeObjectId = toUnicodeRef ? `${toUnicodeRef[1]} ${toUnicodeRef[2]}` : null;
    const map = toUnicodeObjectId ? toUnicodeMapsByObjectId.get(toUnicodeObjectId) : null;

    if (map) {
      fontMapsByObjectId.set(fontObjectId, map);
    }
  }
  for (const [resourceName, fontObjectId] of fontObjectIdsByResourceName) {
    if (winAnsiFontObjectIds.has(fontObjectId)) winAnsiResourceNames.add(resourceName);
    const map = fontMapsByObjectId.get(fontObjectId);
    if (map) fontMapsByResourceName.set(resourceName, map);
  }

  return { fontMapsByResourceName, fontMapsByObjectId, winAnsiFontObjectIds, winAnsiResourceNames };
}

function parsePdfObjects(source: string): Map<string, PdfObject> {
  const objects = new Map<string, PdfObject>();
  const regex = /(\d+)\s+(\d+)\s+obj\s*([\s\S]*?)\s*endobj/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const objectId = `${match[1]} ${match[2]}`;
    const body = match[3] ?? "";
    const streamMatch = body.match(/<<([\s\S]*?)>>\s*stream\r?\n?([\s\S]*?)\r?\n?endstream/);

    objects.set(objectId, {
      body,
      dictionary: streamMatch?.[1] ?? "",
      stream: streamMatch?.[2] ?? null
    });
  }

  return objects;
}

function extractPagesFromPageObjects(
  objects: Map<string, PdfObject>,
  context: PdfTextContext
): ExtractedPdfPage[] {
  // Physical order is the page tree's Kids order, not the indirect object number.
  const catalog = Array.from(objects.values()).find(object => /\/Type\s*\/Catalog\b/.test(object.body));
  const root = catalog?.body.match(/\/Pages\s+(\d+)\s+(\d+)\s+R/);
  const pageObjects: Array<[string, PdfObject]> = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const object = objects.get(id);
    if (!object) return;
    if (/\/Type\s*\/Page(?!s)\b/.test(object.body)) { pageObjects.push([id, object]); return; }
    const kids = object.body.match(/\/Kids\s*\[([\s\S]*?)\]/);
    for (const ref of (kids?.[1] ?? "").matchAll(/(\d+)\s+(\d+)\s+R/g)) visit(`${ref[1]} ${ref[2]}`);
  };
  if (root) visit(`${root[1]} ${root[2]}`);
  if (!pageObjects.length) pageObjects.push(...Array.from(objects.entries()).filter(([, object]) => /\/Type\s*\/Page(?!s)\b/.test(object.body)));

  return pageObjects
    .map(([_objectId, pageObject], index) => {
      const contentObjectIds = parseContentObjectIds(pageObject.body);
      const pageContext = contextForPage(pageObject, objects, context);
      const text = normalizeExtractedText(
        contentObjectIds
          .map((objectId) => {
            const contentObject = objects.get(objectId);
            const stream = contentObject?.stream
              ? decodeStream(contentObject.dictionary, contentObject.stream)
              : null;

            return stream && containsTextOperator(stream) ? extractTextOperators(stream, pageContext) : "";
          })
          .filter(Boolean)
          .join("\n\n")
      );

      return toExtractedPage(index + 1, text);
    })
    .filter((page) => page.text || pageObjects.length > 0);
}

function contextForPage(page: PdfObject, objects: Map<string, PdfObject>, context: PdfTextContext): PdfTextContext {
  let current: PdfObject | undefined = page;
  const seen = new Set<PdfObject>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (/\/Resources\b/.test(current.body)) {
      const ref = current.body.match(/\/Resources\s+(\d+)\s+(\d+)\s+R/);
      let resources = ref ? objects.get(`${ref[1]} ${ref[2]}`)?.body ?? "" : current.body;
      const fontRef = resources.match(/\/Font\s+(\d+)\s+(\d+)\s+R/);
      if (fontRef) resources = `/Font <<${objects.get(`${fontRef[1]} ${fontRef[2]}`)?.body.replace(/^<<|>>$/g, "") ?? ""}>>`;
      const local = new Map<string, ToUnicodeMap>();
      const winAnsi = new Set<string>();
      for (const [name, objectId] of parseFontResourceMap(resources)) {
        if (context.winAnsiFontObjectIds.has(objectId)) winAnsi.add(name);
        const map = context.fontMapsByObjectId.get(objectId);
        if (map) local.set(name, map);
      }
      return { ...context, fontMapsByResourceName: local, winAnsiResourceNames: winAnsi };
    }
    const parent: RegExpMatchArray | null = current.body.match(/\/Parent\s+(\d+)\s+(\d+)\s+R/);
    current = parent ? objects.get(`${parent[1]} ${parent[2]}`) : undefined;
  }
  return context;
}

function parseContentObjectIds(pageObjectBody: string): string[] {
  const arrayMatch = pageObjectBody.match(/\/Contents\s*\[([\s\S]*?)\]/);

  if (arrayMatch) {
    return Array.from((arrayMatch[1] ?? "").matchAll(/(\d+)\s+(\d+)\s+R/g)).map(
      (match) => `${match[1]} ${match[2]}`
    );
  }

  const singleMatch = pageObjectBody.match(/\/Contents\s+(\d+)\s+(\d+)\s+R/);

  return singleMatch ? [`${singleMatch[1]} ${singleMatch[2]}`] : [];
}

function parseFontResourceMap(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const fontBlocks = source.matchAll(/\/Font\s*<<([\s\S]*?)>>/g);

  for (const block of fontBlocks) {
    const fontEntries = block[1]?.matchAll(/\/([A-Za-z0-9_.-]+)\s+(\d+)\s+(\d+)\s+R/g) ?? [];

    for (const entry of fontEntries) {
      result.set(entry[1] ?? "", `${entry[2]} ${entry[3]}`);
    }
  }

  return result;
}

function parseToUnicodeCMap(cmap: string): ToUnicodeMap {
  const values = new Map<string, string>();

  for (const block of cmap.matchAll(/beginbfchar\s*([\s\S]*?)\s*endbfchar/g)) {
    for (const line of (block[1] ?? "").split(/\r?\n/)) {
      const match = line.match(/^\s*<([\dA-Fa-f\s]+)>\s*<([\dA-Fa-f\s]+)>\s*$/);
      const source = normalizeHex(match?.[1] ?? "");
      const target = decodeUtf16BeHex(match?.[2] ?? "");

      if (source && target) {
        values.set(source, target);
      }
    }
  }

  for (const block of cmap.matchAll(/beginbfrange\s*([\s\S]*?)\s*endbfrange/g)) {
    for (const line of (block[1] ?? "").split(/\r?\n/)) {
      const match = line.match(
        /^\s*<([\dA-Fa-f\s]+)>\s*<([\dA-Fa-f\s]+)>\s*(?:<([\dA-Fa-f\s]+)>|\[(.*?)\])\s*$/
      );
      const startHex = normalizeHex(match?.[1] ?? "");
      const endHex = normalizeHex(match?.[2] ?? "");

      if (!match || !startHex || !endHex) {
        continue;
      }

      const start = Number.parseInt(startHex, 16);
      const end = Number.parseInt(endHex, 16);

      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        continue;
      }

      if (match[3]) {
        const targetStart = Number.parseInt(normalizeHex(match[3]), 16);

        for (let code = start; code <= end; code += 1) {
          values.set(
            code.toString(16).toUpperCase().padStart(startHex.length, "0"),
            decodeUtf16BeCodePoint(targetStart + code - start)
          );
        }
        continue;
      }

      const targets = Array.from((match[4] ?? "").matchAll(/<([\dA-Fa-f\s]+)>/g)).map((item) =>
        decodeUtf16BeHex(item[1] ?? "")
      );

      targets.forEach((target, index) => {
        values.set(
          (start + index).toString(16).toUpperCase().padStart(startHex.length, "0"),
          target
        );
      });
    }
  }

  const codeLength = Math.max(
    1,
    Math.min(...Array.from(values.keys()).map((key) => Math.max(1, key.length / 2)))
  );

  return { codeLength: Number.isFinite(codeLength) ? codeLength : 2, values };
}

function containsTextOperator(stream: string): boolean {
  return /\b(BT|Tj|TJ|'|")\b/.test(stream);
}

function extractTextOperators(stream: string, context: PdfTextContext): string {
  const tokens = tokenizeContentStream(stream);
  const output: string[] = [];
  let currentFontMap: ToUnicodeMap | null = null;
  let currentWinAnsi = false;
  const fontStack: Array<{ map: ToUnicodeMap | null; winAnsi: boolean }> = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    // Text font belongs to graphics state too: Q must restore a font changed inside q.
    if (token === "q") { fontStack.push({ map: currentFontMap, winAnsi: currentWinAnsi }); continue; }
    if (token === "Q") { const restored = fontStack.pop(); if (restored) { currentFontMap = restored.map; currentWinAnsi = restored.winAnsi; } continue; }

    if (token === "Tf") {
      const fontName = tokens[index - 2]?.replace(/^\//, "");
      currentFontMap = fontName ? context.fontMapsByResourceName.get(fontName) ?? null : null;
      currentWinAnsi = fontName ? context.winAnsiResourceNames.has(fontName) : false;
      continue;
    }

    if (token === "Tj" || token === "'") {
      const text = decodePdfString(tokens[index - 1], currentFontMap, currentWinAnsi);

      if (text) {
        output.push(text);
      }
      continue;
    }

    if (token === "\"") {
      const text = decodePdfString(tokens[index - 1], currentFontMap, currentWinAnsi);

      if (text) {
        output.push(text);
      }
      continue;
    }

    if (token === "TJ") {
      const arrayToken = tokens[index - 1];

      if (arrayToken?.startsWith("[") && arrayToken.endsWith("]")) {
        const text = Array.from(arrayToken.matchAll(/\((?:\\.|[^\\)])*\)|<[\da-fA-F\s]+>/g))
          .map((item) => decodePdfString(item[0], currentFontMap, currentWinAnsi))
          .filter(Boolean)
          .join("");

        if (text) {
          output.push(text);
        }
      }
      continue;
    }

    if (token === "Td" || token === "TD") {
      const yOffset = Number(tokens[index - 1]);

      if (Number.isFinite(yOffset) && Math.abs(yOffset) > 0.1 && output.at(-1) !== "\n") {
        output.push("\n");
      }
      continue;
    }

    if (token === "T*" || token === "ET") {
      if (output.at(-1) !== "\n") {
        output.push("\n");
      }
    }
  }

  return output.join("");
}

function tokenizeContentStream(stream: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < stream.length) {
    const char = stream[index];

    if (!char || /\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "%") {
      while (index < stream.length && stream[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "(") {
      const end = readLiteralString(stream, index);
      tokens.push(stream.slice(index, end));
      index = end;
      continue;
    }

    if (char === "[") {
      const end = readArray(stream, index);
      tokens.push(stream.slice(index, end));
      index = end;
      continue;
    }

    if (char === "<" && stream[index + 1] !== "<") {
      const end = stream.indexOf(">", index + 1);
      tokens.push(end === -1 ? stream.slice(index) : stream.slice(index, end + 1));
      index = end === -1 ? stream.length : end + 1;
      continue;
    }

    let end = index + 1;

    while (end < stream.length && !/\s/.test(stream[end] ?? "")) {
      if ("[]()<>".includes(stream[end] ?? "")) {
        break;
      }
      end += 1;
    }

    tokens.push(stream.slice(index, end));
    index = end;
  }

  return tokens;
}

function readLiteralString(stream: string, start: number): number {
  let depth = 0;
  let escaped = false;

  for (let index = start; index < stream.length; index += 1) {
    const char = stream[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "(") {
      depth += 1;
    }

    if (char === ")") {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return stream.length;
}

function readArray(stream: string, start: number): number {
  let depth = 0;
  let index = start;

  while (index < stream.length) {
    const char = stream[index];

    if (char === "(") {
      index = readLiteralString(stream, index);
      continue;
    }

    if (char === "[") {
      depth += 1;
    }

    if (char === "]") {
      depth -= 1;

      if (depth === 0) {
        return index + 1;
      }
    }

    index += 1;
  }

  return stream.length;
}

function decodePdfString(token: string | undefined, toUnicodeMap: ToUnicodeMap | null = null, winAnsi = false): string {
  if (!token) {
    return "";
  }

  if (token.startsWith("(") && token.endsWith(")")) {
    const bytes = decodeLiteralPdfString(token.slice(1, -1));
    return toUnicodeMap ? decodeWithToUnicodeMap(Buffer.from(bytes, "latin1").toString("hex"), toUnicodeMap) : winAnsi ? new TextDecoder("windows-1252").decode(Buffer.from(bytes, "latin1")) : bytes;
  }

  if (token.startsWith("<") && token.endsWith(">")) {
    return decodeHexPdfString(token.slice(1, -1), toUnicodeMap, winAnsi);
  }

  return "";
}

function decodeLiteralPdfString(value: string): string {
  return value
    .replace(/\\([nrtbf()\\])/g, (_match, escaped: string) => {
      const map: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\"
      };

      return map[escaped] ?? escaped;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) =>
      String.fromCharCode(Number.parseInt(octal, 8))
    );
}

function decodeHexPdfString(value: string, toUnicodeMap: ToUnicodeMap | null, winAnsi: boolean): string {
  const hex = normalizeHex(value);

  if (toUnicodeMap && hex) {
    const mapped = decodeWithToUnicodeMap(hex, toUnicodeMap);

    if (mapped) {
      return mapped;
    }
  }

  const evenHex = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes = Buffer.from(evenHex, "hex");

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16BeBytes(bytes.subarray(2));
  }

  return winAnsi ? new TextDecoder("windows-1252").decode(bytes) : bytes.toString("utf8").replace(/\u0000/g, "");
}

function decodeWithToUnicodeMap(hex: string, map: ToUnicodeMap): string {
  const bytesPerCode = map.codeLength;
  const chars: string[] = [];

  for (let index = 0; index < hex.length; index += bytesPerCode * 2) {
    const code = hex.slice(index, index + bytesPerCode * 2).toUpperCase();
    const mapped = map.values.get(code);

    chars.push(mapped ?? "");
  }

  return chars.join("");
}

function normalizeHex(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

function decodeUtf16BeHex(value: string): string {
  const hex = normalizeHex(value);
  const evenHex = hex.length % 2 === 0 ? hex : `${hex}0`;

  return decodeUtf16BeBytes(Buffer.from(evenHex, "hex"));
}

function decodeUtf16BeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }

  if (value <= 0xffff) {
    return String.fromCharCode(value);
  }

  return String.fromCodePoint(value);
}

function decodeUtf16BeBytes(bytes: Buffer): string {
  const chars: string[] = [];

  for (let index = 0; index + 1 < bytes.length; index += 2) {
    chars.push(String.fromCharCode((bytes[index] << 8) | bytes[index + 1]));
  }

  return chars.join("");
}

function normalizeExtractedText(value: string): string {
  return mergeIsolatedInlineLines(value)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mergeIsolatedInlineLines(value: string): string {
  const lines = value.replace(/\r/g, "\n").split("\n");
  const merged: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const previous = merged.at(-1);

    if (
      previous &&
      isInlineFragment(trimmed) &&
      previous.trim() &&
      !looksLikeStandaloneHeading(previous)
    ) {
      merged[merged.length - 1] = `${previous}${trimmed}`;
      continue;
    }

    merged.push(line);
  }

  return merged.join("\n");
}

function isInlineFragment(value: string): boolean {
  return /^[A-Za-z0-9&.,:;!?，。：；！？、\-]+$/.test(value) && value.length <= 4;
}

function looksLikeStandaloneHeading(value: string): boolean {
  return /^(第\s*[一二三四五六七八九十\d]+\s*幕|(?:Part|Act)\s+\w+|【\s*\d+\s*】)/i.test(
    value.trim()
  );
}

function splitIntoPages(text: string, pageCount: number): ExtractedPdfPage[] {
  const chunks = splitPageChunks(text, pageCount);

  return chunks.map((chunk, index) => toExtractedPage(index + 1, chunk));
}

function toExtractedPage(pageNumber: number, text: string): ExtractedPdfPage {
  const normalized = normalizeExtractedText(text);
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return {
    pageNumber,
    text: normalized,
    paragraphs: paragraphs.length > 0 ? paragraphs : normalized ? [normalized] : [],
    charCount: normalized.length
  };
}

function splitPageChunks(text: string, pageCount: number): string[] {
  const markerChunks = text.split(/\f|(?:\n\s*---+\s*page\s*\d+\s*---+\s*\n)/i);

  if (markerChunks.length === pageCount) {
    return markerChunks;
  }

  if (pageCount <= 1) {
    return [text];
  }

  return Array.from({ length: pageCount }, (_item, index) => (index === 0 ? text : ""));
}
