-- AlterTable
ALTER TABLE "AgentRun" ADD COLUMN "errorMessage" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "latencyMs" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "model" TEXT;
ALTER TABLE "AgentRun" ADD COLUMN "phase" TEXT;
