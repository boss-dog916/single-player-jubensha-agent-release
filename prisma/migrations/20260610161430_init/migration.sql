-- CreateTable
CREATE TABLE "GameSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "currentActId" TEXT NOT NULL,
    "currentPhase" TEXT NOT NULL,
    "currentShareIndex" INTEGER NOT NULL DEFAULT 0,
    "userRoleId" TEXT,
    "aiRoleIds" TEXT NOT NULL,
    "discussionTurnCount" INTEGER NOT NULL DEFAULT 0,
    "maxDiscussionTurns" INTEGER NOT NULL DEFAULT 6,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameSessionId" TEXT NOT NULL,
    "speakerType" TEXT NOT NULL,
    "speakerRoleId" TEXT,
    "speakerName" TEXT,
    "targetRoleIds" TEXT NOT NULL,
    "replyToMessageId" TEXT,
    "phase" TEXT NOT NULL,
    "speechAct" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_replyToMessageId_fkey" FOREIGN KEY ("replyToMessageId") REFERENCES "Message" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoleMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameSessionId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "memory" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RoleMemory_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublicStoryBoard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameSessionId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PublicStoryBoard_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gameSessionId" TEXT NOT NULL,
    "agentType" TEXT NOT NULL,
    "roleId" TEXT,
    "actId" TEXT,
    "input" TEXT NOT NULL,
    "output" TEXT,
    "checkerResult" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRun_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Message_gameSessionId_createdAt_idx" ON "Message"("gameSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_replyToMessageId_idx" ON "Message"("replyToMessageId");

-- CreateIndex
CREATE INDEX "RoleMemory_gameSessionId_idx" ON "RoleMemory"("gameSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleMemory_gameSessionId_roleId_key" ON "RoleMemory"("gameSessionId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicStoryBoard_gameSessionId_key" ON "PublicStoryBoard"("gameSessionId");

-- CreateIndex
CREATE INDEX "AgentRun_gameSessionId_createdAt_idx" ON "AgentRun"("gameSessionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_agentType_idx" ON "AgentRun"("agentType");

-- CreateIndex
CREATE INDEX "AgentRun_roleId_idx" ON "AgentRun"("roleId");
