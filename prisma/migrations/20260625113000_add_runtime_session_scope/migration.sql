-- AlterTable
ALTER TABLE "GameSession" ADD COLUMN "runtimeDefinitionId" TEXT;
ALTER TABLE "GameSession" ADD COLUMN "testMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GameSession" ADD COLUMN "runtimeScopeJson" TEXT;

-- CreateIndex
CREATE INDEX "GameSession_runtimeDefinitionId_idx" ON "GameSession"("runtimeDefinitionId");
