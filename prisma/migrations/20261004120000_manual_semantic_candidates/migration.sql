CREATE TABLE "ManualParseCandidate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scriptPackageId" TEXT NOT NULL,
  "format" TEXT NOT NULL DEFAULT 'semantic_v2',
  "status" TEXT NOT NULL DEFAULT 'planning',
  "sourceManifestJson" TEXT NOT NULL,
  "scopeJson" TEXT NOT NULL,
  "planJson" TEXT,
  "chunksJson" TEXT NOT NULL DEFAULT '[]',
  "semanticJson" TEXT,
  "semanticValidationJson" TEXT,
  "compiledJson" TEXT,
  "runtimeValidationJson" TEXT,
  "errorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ManualParseCandidate_scriptPackageId_createdAt_idx" ON "ManualParseCandidate"("scriptPackageId", "createdAt");
