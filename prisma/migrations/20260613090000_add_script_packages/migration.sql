-- CreateTable
CREATE TABLE "ScriptPackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scriptJson" TEXT NOT NULL,
    "validationJson" TEXT,
    "sourceMetaJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UploadedAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scriptPackageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "localPath" TEXT NOT NULL,
    "parsedText" TEXT,
    "parseStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadedAsset_scriptPackageId_fkey" FOREIGN KEY ("scriptPackageId") REFERENCES "ScriptPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestionJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scriptPackageId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "currentStep" TEXT,
    "inputJson" TEXT,
    "outputJson" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IngestionJob_scriptPackageId_fkey" FOREIGN KEY ("scriptPackageId") REFERENCES "ScriptPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestionStepRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ingestionJobId" TEXT NOT NULL,
    "stepName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "inputJson" TEXT,
    "outputJson" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "IngestionStepRun_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "IngestionJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "GameSession" ADD COLUMN "scriptPackageId" TEXT REFERENCES "ScriptPackage" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "ScriptPackage_slug_key" ON "ScriptPackage"("slug");

-- CreateIndex
CREATE INDEX "UploadedAsset_scriptPackageId_idx" ON "UploadedAsset"("scriptPackageId");

-- CreateIndex
CREATE INDEX "IngestionJob_scriptPackageId_idx" ON "IngestionJob"("scriptPackageId");

-- CreateIndex
CREATE INDEX "IngestionJob_status_idx" ON "IngestionJob"("status");

-- CreateIndex
CREATE INDEX "IngestionStepRun_ingestionJobId_idx" ON "IngestionStepRun"("ingestionJobId");

-- CreateIndex
CREATE INDEX "IngestionStepRun_stepName_idx" ON "IngestionStepRun"("stepName");

-- CreateIndex
CREATE INDEX "GameSession_scriptPackageId_idx" ON "GameSession"("scriptPackageId");
