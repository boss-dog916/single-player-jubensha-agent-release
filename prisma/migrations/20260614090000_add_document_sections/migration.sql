ALTER TABLE "UploadedAsset" ADD COLUMN "roleName" TEXT;

ALTER TABLE "ParsedDocument" ADD COLUMN "segmentationStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "ParsedDocument" ADD COLUMN "segmentationError" TEXT;

CREATE TABLE "DocumentSection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scriptPackageId" TEXT NOT NULL,
    "uploadedAssetId" TEXT NOT NULL,
    "parsedDocumentId" TEXT NOT NULL,
    "sectionType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "roleName" TEXT,
    "actIndex" INTEGER,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "text" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DocumentSection_scriptPackageId_fkey" FOREIGN KEY ("scriptPackageId") REFERENCES "ScriptPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DocumentSection_uploadedAssetId_fkey" FOREIGN KEY ("uploadedAssetId") REFERENCES "UploadedAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DocumentSection_parsedDocumentId_fkey" FOREIGN KEY ("parsedDocumentId") REFERENCES "ParsedDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UploadedAsset_kind_idx" ON "UploadedAsset"("kind");
CREATE INDEX "ParsedDocument_segmentationStatus_idx" ON "ParsedDocument"("segmentationStatus");
CREATE INDEX "DocumentSection_scriptPackageId_idx" ON "DocumentSection"("scriptPackageId");
CREATE INDEX "DocumentSection_uploadedAssetId_idx" ON "DocumentSection"("uploadedAssetId");
CREATE INDEX "DocumentSection_parsedDocumentId_idx" ON "DocumentSection"("parsedDocumentId");
CREATE INDEX "DocumentSection_sectionType_idx" ON "DocumentSection"("sectionType");
