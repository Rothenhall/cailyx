-- AlterTable
ALTER TABLE "GrowthAsset" ADD COLUMN "assigneeId" TEXT;

-- CreateIndex
CREATE INDEX "GrowthAsset_assigneeId_idx" ON "GrowthAsset"("assigneeId");
