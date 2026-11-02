PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_AgentRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "gameSessionId" TEXT NOT NULL,
  "traceId" TEXT,
  "parentRunId" TEXT,
  "runKind" TEXT NOT NULL DEFAULT 'span',
  "agentType" TEXT NOT NULL,
  "roleId" TEXT,
  "actId" TEXT,
  "phase" TEXT,
  "input" TEXT NOT NULL,
  "output" TEXT,
  "checkerResult" TEXT,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "errorMessage" TEXT,
  "model" TEXT,
  "latencyMs" INTEGER,
  "ttftMs" INTEGER,
  "promptChars" INTEGER,
  "outputChars" INTEGER,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "reasoningTokens" INTEGER,
  "cachedInputTokens" INTEGER,
  "retryCount" INTEGER,
  "providerRequestId" TEXT,
  "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "AgentRun_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_AgentRun" (
  "id", "gameSessionId", "agentType", "roleId", "actId", "phase", "input", "output",
  "checkerResult", "status", "error", "errorMessage", "model", "latencyMs", "startedAt",
  "finishedAt", "createdAt", "updatedAt"
)
SELECT
  "id", "gameSessionId", "agentType", "roleId", "actId", "phase", "input", "output",
  "checkerResult", "status", "error", "errorMessage", "model", "latencyMs", "createdAt",
  CASE WHEN "status" IN ('success', 'failed') THEN "updatedAt" ELSE NULL END, "createdAt", "updatedAt"
FROM "AgentRun";

DROP TABLE "AgentRun";
ALTER TABLE "new_AgentRun" RENAME TO "AgentRun";

CREATE INDEX "AgentRun_gameSessionId_createdAt_idx" ON "AgentRun"("gameSessionId", "createdAt");
CREATE INDEX "AgentRun_traceId_startedAt_idx" ON "AgentRun"("traceId", "startedAt");
CREATE INDEX "AgentRun_parentRunId_idx" ON "AgentRun"("parentRunId");
CREATE INDEX "AgentRun_agentType_idx" ON "AgentRun"("agentType");
CREATE INDEX "AgentRun_roleId_idx" ON "AgentRun"("roleId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
