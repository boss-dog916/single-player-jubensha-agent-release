CREATE TABLE "ShareDraft" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameSessionId" TEXT NOT NULL,
  "actId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "generatedContent" TEXT,
  "metadataJson" TEXT,
  "checkerJson" TEXT,
  "preparationJson" TEXT,
  "errorMessage" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "agentRunId" TEXT,
  "generationStartedAt" DATETIME,
  "generationCompletedAt" DATETIME,
  "checkedAt" DATETIME,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "ShareDraft_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ShareDraft_gameSessionId_actId_roleId_key" ON "ShareDraft"("gameSessionId", "actId", "roleId");
CREATE INDEX "ShareDraft_gameSessionId_status_createdAt_idx" ON "ShareDraft"("gameSessionId", "status", "createdAt");
