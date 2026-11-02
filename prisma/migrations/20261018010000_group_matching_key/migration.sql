CREATE TABLE "GroupMatchingKey" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "runtimeDefinitionId" TEXT NOT NULL,
  "choiceId" TEXT NOT NULL,
  "assignmentsJson" TEXT NOT NULL,
  "hintsJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GroupMatchingKey_runtimeDefinitionId_fkey" FOREIGN KEY ("runtimeDefinitionId") REFERENCES "ScriptRuntimeDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "GroupMatchingKey_runtimeDefinitionId_choiceId_key" ON "GroupMatchingKey"("runtimeDefinitionId", "choiceId");
