-- CreateTable
CREATE TABLE "RoleActBooklet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scriptPackageId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "actIndex" INTEGER NOT NULL,
    "sourceSectionId" TEXT NOT NULL,
    "privateText" TEXT NOT NULL DEFAULT '',
    "mustShareJson" TEXT NOT NULL DEFAULT '[]',
    "mayShareJson" TEXT NOT NULL DEFAULT '[]',
    "mustNotShareJson" TEXT NOT NULL DEFAULT '[]',
    "emotionalPointsJson" TEXT NOT NULL DEFAULT '[]',
    "relationshipPointsJson" TEXT NOT NULL DEFAULT '[]',
    "timelineFragmentsJson" TEXT NOT NULL DEFAULT '[]',
    "parseStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "parseError" TEXT,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RoleActBooklet_scriptPackageId_fkey" FOREIGN KEY ("scriptPackageId") REFERENCES "ScriptPackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RoleActBooklet_sourceSectionId_fkey" FOREIGN KEY ("sourceSectionId") REFERENCES "DocumentSection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RoleActBooklet_sourceSectionId_key" ON "RoleActBooklet"("sourceSectionId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleActBooklet_scriptPackageId_roleName_actIndex_key" ON "RoleActBooklet"("scriptPackageId", "roleName", "actIndex");

-- CreateIndex
CREATE INDEX "RoleActBooklet_scriptPackageId_idx" ON "RoleActBooklet"("scriptPackageId");

-- CreateIndex
CREATE INDEX "RoleActBooklet_roleName_actIndex_idx" ON "RoleActBooklet"("roleName", "actIndex");

-- CreateIndex
CREATE INDEX "RoleActBooklet_parseStatus_idx" ON "RoleActBooklet"("parseStatus");
