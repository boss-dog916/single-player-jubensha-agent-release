CREATE TABLE "PostShareTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameSessionId" TEXT NOT NULL,
  "seedMessageId" TEXT NOT NULL,
  "sourceActId" TEXT NOT NULL,
  "sourceShareIndex" INTEGER NOT NULL,
  "committedShareIndex" INTEGER NOT NULL,
  "sharedRoleId" TEXT NOT NULL,
  "hasMoreShares" BOOLEAN NOT NULL,
  "nextRoleId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "claimedAt" DATETIME,
  "completedAt" DATETIME,
  "errorMessage" TEXT,
  "agentRunId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PostShareTask_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PostShareTask_seedMessageId_key"
ON "PostShareTask"("seedMessageId");

CREATE INDEX "PostShareTask_gameSessionId_status_createdAt_idx"
ON "PostShareTask"("gameSessionId", "status", "createdAt");

CREATE UNIQUE INDEX "PostShareTask_one_running_per_game"
ON "PostShareTask"("gameSessionId") WHERE "status" = 'running';
