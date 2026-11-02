import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { afterAll, expect, it } from "vitest";
import { extractDocumentText } from "./documentTextExtractor";
import { extractPdfText, MAX_DECODED_STREAM_BYTES } from "./pdfTextExtractor";

const root = mkdtempSync(join(tmpdir(), "jubensha-extraction-limit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function docx(body: Buffer, compressed = true) {
  const name = Buffer.from("word/document.xml"), data = compressed ? deflateRawSync(body) : body;
  const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(compressed ? 8 : 0, 8);
  head.writeUInt32LE(data.length, 18); head.writeUInt32LE(body.length, 22); head.writeUInt16LE(name.length, 26);
  const path = join(root, "fixture.docx"); writeFileSync(path, Buffer.concat([head, name, data])); return path;
}
function pdf(body: Buffer) {
  const data = deflateSync(body), path = join(root, "fixture.pdf");
  writeFileSync(path, Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`),
    data, Buffer.from("\nendstream\nendobj\n%%EOF")])); return path;
}
it("retains ordinary DOCX text extraction", async () => {
  const path = docx(Buffer.from('<w:document><w:body><w:p><w:r><w:t>原创验收文本</w:t></w:r></w:p></w:body></w:document>'));
  expect((await extractDocumentText({ filePath: path, originalName: "fixture.docx", mimeType: null })).normalizedText).toContain("原创验收文本");
});
it("rejects compressed DOCX expansion and oversized stored XML", async () => {
  for (const compressed of [true, false]) {
    const path = docx(Buffer.alloc(MAX_DECODED_STREAM_BYTES + 1, 65), compressed);
    await expect(extractDocumentText({ filePath: path, originalName: "fixture.docx", mimeType: null })).rejects.toThrow("32MiB");
  }
});
it("retains ordinary PDF text extraction", async () => {
  expect((await extractPdfText(pdf(Buffer.from("BT (Original fixture text) Tj ET")))).extractedText).toContain("Original fixture text");
});
it("rejects PDF stream expansion instead of hiding it as an empty stream", async () => {
  await expect(extractPdfText(pdf(Buffer.alloc(MAX_DECODED_STREAM_BYTES + 1, 65)))).rejects.toThrow("32MiB");
});
