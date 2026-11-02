import { readFile } from "node:fs/promises";
import { extractDocumentText } from "@/src/lib/ingestion/documentTextExtractor";
import { extractPdfText, PDF_TEXT_LOCATOR_VERSION } from "@/src/lib/ingestion/pdfTextExtractor";
import { activityTextHash, type SourceCorpus } from "./manualActivityValidation";
import type { ActivityEvidence } from "@/src/lib/schemas/manualActivityIRSchema";

export type ActivitySourcePack = {
  fixture: "A" | "B"; sourcePath: string; sourceHash: string; fullNormalizedTextHash: string;
  normalizedTextHash: string; sourceFingerprint: string; locatorVersion: string;
  range: string; corpus: SourceCorpus; blocks: Array<{ id: string; purpose: "main" | "archive_cross_reference"; text: string }>;
};
export async function prepareActivitySource(fixture: "A" | "B"): Promise<ActivitySourcePack> {
  // Private regression fixtures are optional; normal uploaded-source parsing
  // uses ActivitySourcePack/activitySourceEvidence without this helper.
  const manifest = process.env.MANUAL_ACTIVITY_FIXTURE_MANIFEST || "storage/test-fixtures/activity-sources.json";
  const sources = JSON.parse(await readFile(manifest, "utf8")) as Record<"A" | "B", { path: string; hash: string }>;
  const source = sources[fixture], sourceHash = activityTextHash(await readFile(source.path));
  if (sourceHash !== source.hash) throw new Error("Source changed: ground truth must be reviewed first");
  const raw: Array<{ id: string; text: string; normalizedParagraph?: number; ooxmlOrdinal?: number; physicalPage?: number }> = [];
  if (fixture === "A") {
    const result = await extractDocumentText({ filePath: source.path, originalName: source.path, mimeType: null });
    for (const [i, b] of result.blocksJson!.entries()) raw.push({ id: `p${i}`, text: b.text, normalizedParagraph: i, ooxmlOrdinal: b.sourceParagraphIndex });
  } else {
    const result = await extractPdfText(source.path);
    if (result.locatorVersion !== PDF_TEXT_LOCATOR_VERSION) throw new Error("Stale PDF extractor");
    for (const p of result.pages) raw.push({ id: `p${p.pageNumber}`, text: p.text, physicalPage: p.pageNumber });
  }
  const delimiter = fixture === "A" ? "\n" : "\n\n";
  const fullNormalizedTextHash = activityTextHash(raw.map(b => b.text).join(delimiter));
  const selected = raw.filter(b => fixture === "A" ? b.normalizedParagraph! <= 210 : b.physicalPage! <= 20 || [40, 41].includes(b.physicalPage!));
  let text = "";
  const blocks: SourceCorpus[number]["blocks"] = selected.map(b => {
    if (text) text += delimiter;
    const start = text.length; text += b.text;
    const { text: _text, ...location } = b;
    return { ...location, start, end: text.length };
  });
  const locatorVersion = fixture === "A" ? "docx-paragraph-v1" : PDF_TEXT_LOCATOR_VERSION;
  const corpus: SourceCorpus = [{ documentId: `activity_fixture_${fixture}`, revision: 1, sourceHash, locatorVersion, layoutFidelity: "unsupported", text, blocks }];
  const normalizedTextHash = activityTextHash(text), range = fixture === "A" ? "nonempty paragraphs 0-210" : "physical pages 1-20 + 40-41 archive-point cross-reference only";
  return { fixture, sourcePath: source.path, sourceHash, fullNormalizedTextHash, normalizedTextHash, locatorVersion, range, corpus,
    sourceFingerprint: activityTextHash(JSON.stringify({ sourceHash, fullNormalizedTextHash, normalizedTextHash, locatorVersion, range, preparationVersion: "activity-source-v1" })),
    blocks: selected.map(b => ({ id: b.id, text: b.text, purpose: fixture === "B" && b.physicalPage! >= 40 ? "archive_cross_reference" : "main" })) };
}
export function activitySourceEvidence(pack: ActivitySourcePack, blockId: string): ActivityEvidence {
  const doc = pack.corpus[0], b = doc.blocks.find(b => b.id === blockId);
  if (!b || b.start === b.end) throw new Error(`SOURCE_FENCE: unknown/empty block ${blockId}`);
  return { documentId: doc.documentId, revision: doc.revision, sourceHash: doc.sourceHash,
    sourceSpan: { start: b.start, end: b.end }, sourceQuote: doc.text.slice(b.start, b.end),
    locator: b.normalizedParagraph !== undefined
      ? { format: "docx", normalizedParagraph: b.normalizedParagraph, ooxmlOrdinal: b.ooxmlOrdinal!, locatorVersion: doc.locatorVersion }
      : { format: "pdf", physicalPage: b.physicalPage!, textBlock: b.id, locatorVersion: doc.locatorVersion, layoutFidelity: "unsupported" } };
}
