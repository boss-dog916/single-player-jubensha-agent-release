CREATE TABLE "DMFlow" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scriptPackageId" TEXT NOT NULL,
  "openingNodesJson" TEXT NOT NULL DEFAULT '[]',
  "actFlowsJson" TEXT NOT NULL DEFAULT '[]',
  "endingNodesJson" TEXT NOT NULL DEFAULT '[]',
  "sectionResultsJson" TEXT NOT NULL DEFAULT '[]',
  "parseStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "parseError" TEXT,
  "warningsJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DMFlow_scriptPackageId_fkey" FOREIGN KEY ("scriptPackageId") REFERENCES "ScriptPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DMFlow_scriptPackageId_key" ON "DMFlow"("scriptPackageId");
CREATE INDEX "DMFlow_scriptPackageId_idx" ON "DMFlow"("scriptPackageId");
CREATE INDEX "DMFlow_parseStatus_idx" ON "DMFlow"("parseStatus");
