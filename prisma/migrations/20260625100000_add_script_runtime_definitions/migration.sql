CREATE TABLE "ScriptRuntimeDefinition" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scriptPackageId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "definitionJson" TEXT NOT NULL,
  "validationReportJson" TEXT NOT NULL,
  "compiledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ScriptRuntimeDefinition_scriptPackageId_fkey" FOREIGN KEY ("scriptPackageId") REFERENCES "ScriptPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ScriptRuntimeDefinition_scriptPackageId_version_key" ON "ScriptRuntimeDefinition"("scriptPackageId", "version");
CREATE INDEX "ScriptRuntimeDefinition_scriptPackageId_idx" ON "ScriptRuntimeDefinition"("scriptPackageId");
CREATE INDEX "ScriptRuntimeDefinition_scriptPackageId_version_idx" ON "ScriptRuntimeDefinition"("scriptPackageId", "version");
CREATE INDEX "ScriptRuntimeDefinition_status_idx" ON "ScriptRuntimeDefinition"("status");
