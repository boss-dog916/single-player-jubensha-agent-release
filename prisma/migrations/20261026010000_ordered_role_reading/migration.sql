DROP INDEX "RoleActBooklet_scriptPackageId_roleName_actIndex_key";
ALTER TABLE "GameSession" ADD COLUMN "readingReceiptsJson" TEXT NOT NULL DEFAULT '[]';
