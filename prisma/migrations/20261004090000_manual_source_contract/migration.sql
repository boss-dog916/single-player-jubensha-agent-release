ALTER TABLE "ParsedDocument" ADD COLUMN "documentRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ParsedDocument" ADD COLUMN "sectionSetRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ParsedDocument" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DocumentSection" ADD COLUMN "sectionSetRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "DocumentSection" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "DocumentSection" ADD COLUMN "sourceSpanJson" TEXT;
CREATE TABLE "DMParseArtifact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scriptPackageId" TEXT NOT NULL,
  "sourceSectionId" TEXT NOT NULL,
  "sourceJson" TEXT NOT NULL,
  "outputJson" TEXT NOT NULL,
  "semanticJson" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "parserVersion" TEXT NOT NULL,
  "promptVersion" TEXT NOT NULL,
  "schemaVersion" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DMParseArtifact_scriptPackageId_status_idx" ON "DMParseArtifact"("scriptPackageId", "status");
CREATE INDEX "DMParseArtifact_sourceSectionId_idx" ON "DMParseArtifact"("sourceSectionId");
