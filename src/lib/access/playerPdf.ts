import "server-only";
import { PDFDocument, PDFName } from "pdf-lib";
import { readPlayerDisplayPdfForReading } from "@/src/lib/services/playerPdfReadingService";

// A page hint on a whole PDF is not authorization. Copy only permitted pages
// into a fresh document, without document attachments or page annotations.
export async function readScopedPlayerPdf(input: Parameters<typeof readPlayerDisplayPdfForReading>[0]) {
  const source = await readPlayerDisplayPdfForReading(input);
  const pdf = await PDFDocument.load(source.bytes);
  if (source.pageStart < 1 || source.pageEnd > pdf.getPageCount()) throw new Error("Invalid PDF section range");
  const output = await PDFDocument.create();
  const pages = await output.copyPages(pdf, Array.from({ length: source.pageEnd - source.pageStart + 1 }, (_, i) => source.pageStart - 1 + i));
  for (const page of pages) { page.node.delete(PDFName.of("Annots")); output.addPage(page); }
  return { ...source, bytes: Buffer.from(await output.save()), pageStart: 1, pageEnd: pages.length };
}
