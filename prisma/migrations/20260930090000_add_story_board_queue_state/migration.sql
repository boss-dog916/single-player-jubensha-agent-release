ALTER TABLE "Message" ADD COLUMN "storyBoardStatus" TEXT NOT NULL DEFAULT 'not_queued';
ALTER TABLE "Message" ADD COLUMN "storyBoardAgentRunId" TEXT;
ALTER TABLE "Message" ADD COLUMN "storyBoardAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "storyBoardClaimedAt" DATETIME;
ALTER TABLE "Message" ADD COLUMN "storyBoardError" TEXT;

CREATE INDEX "Message_gameSessionId_storyBoardStatus_createdAt_idx"
ON "Message"("gameSessionId", "storyBoardStatus", "createdAt");
