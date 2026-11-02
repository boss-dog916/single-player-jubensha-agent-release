CREATE TABLE "ConversationState" (
  "gameSessionId" TEXT NOT NULL PRIMARY KEY, "revision" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'idle', "stage" TEXT NOT NULL DEFAULT 'idle', "roleId" TEXT,
  "seedMessageId" TEXT, "batchIdsJson" TEXT NOT NULL DEFAULT '[]', "leaseToken" TEXT,
  "heartbeatAt" DATETIME, "actId" TEXT, "errorMessage" TEXT, "updatedAt" DATETIME NOT NULL,
  FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "PendingUserTurn" (
  "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "id" TEXT NOT NULL,
  "gameSessionId" TEXT NOT NULL, "clientMessageId" TEXT NOT NULL, "content" TEXT NOT NULL,
  "roleId" TEXT NOT NULL, "roleName" TEXT NOT NULL, "targetRoleIdsJson" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued', "messageId" TEXT, "revision" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "committedAt" DATETIME,
  FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PendingUserTurn_id_key" ON "PendingUserTurn"("id");
CREATE UNIQUE INDEX "PendingUserTurn_messageId_key" ON "PendingUserTurn"("messageId");
CREATE UNIQUE INDEX "PendingUserTurn_gameSessionId_clientMessageId_key" ON "PendingUserTurn"("gameSessionId", "clientMessageId");
CREATE INDEX "PendingUserTurn_gameSessionId_status_sequence_idx" ON "PendingUserTurn"("gameSessionId", "status", "sequence");
