ALTER TABLE "ParsedDocument" ADD COLUMN "rawText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ParsedDocument" ADD COLUMN "normalizedText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ParsedDocument" ADD COLUMN "blocksJson" TEXT;
ALTER TABLE "ParsedDocument" ADD COLUMN "extractorName" TEXT;
ALTER TABLE "ParsedDocument" ADD COLUMN "qualityStatus" TEXT NOT NULL DEFAULT 'PASS';
ALTER TABLE "ParsedDocument" ADD COLUMN "qualityWarningsJson" TEXT;

UPDATE "ParsedDocument"
SET
  "rawText" = "extractedText",
  "normalizedText" = "extractedText"
WHERE "rawText" = '' AND "normalizedText" = '';

CREATE INDEX "ParsedDocument_qualityStatus_idx" ON "ParsedDocument"("qualityStatus");
