ALTER TABLE "UploadedAsset" ADD COLUMN "assetPurpose" TEXT NOT NULL DEFAULT 'BOTH';
ALTER TABLE "DocumentSection" ADD COLUMN "sectionPurpose" TEXT NOT NULL DEFAULT 'CONTENT';
ALTER TABLE "DocumentSection" ADD COLUMN "metadataJson" TEXT;
CREATE INDEX "UploadedAsset_assetPurpose_idx" ON "UploadedAsset"("assetPurpose");
CREATE INDEX "UploadedAsset_roleName_idx" ON "UploadedAsset"("roleName");
CREATE INDEX "DocumentSection_sectionPurpose_idx" ON "DocumentSection"("sectionPurpose");
CREATE INDEX "DocumentSection_roleName_actIndex_idx" ON "DocumentSection"("roleName", "actIndex");
