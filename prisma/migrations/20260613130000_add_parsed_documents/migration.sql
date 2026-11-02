-- CreateTable
CREATE TABLE "ParsedDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scriptPackageId" TEXT NOT NULL,
    "uploadedAssetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "parseStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "extractedText" TEXT NOT NULL,
    "pagesJson" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ParsedDocument_scriptPackageId_fkey" FOREIGN KEY ("scriptPackageId") REFERENCES "ScriptPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ParsedDocument_uploadedAssetId_fkey" FOREIGN KEY ("uploadedAssetId") REFERENCES "UploadedAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ParsedDocument_scriptPackageId_idx" ON "ParsedDocument"("scriptPackageId");

-- CreateIndex
CREATE INDEX "ParsedDocument_uploadedAssetId_idx" ON "ParsedDocument"("uploadedAssetId");

-- CreateIndex
CREATE INDEX "ParsedDocument_parseStatus_idx" ON "ParsedDocument"("parseStatus");
