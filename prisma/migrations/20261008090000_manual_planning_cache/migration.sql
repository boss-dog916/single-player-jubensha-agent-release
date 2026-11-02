CREATE TABLE "ManualPlanningCache" (
  "cacheKey" TEXT NOT NULL PRIMARY KEY,
  "documentId" TEXT NOT NULL,
  "documentRevision" INTEGER NOT NULL,
  "sectionSetRevision" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "outputJson" TEXT NOT NULL,
  "artifactJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ManualPlanningCache_documentId_documentRevision_sectionSetRevision_idx" ON "ManualPlanningCache"("documentId", "documentRevision", "sectionSetRevision");
