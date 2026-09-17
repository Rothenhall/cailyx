-- AlterTable
ALTER TABLE "Publication" ADD COLUMN "scheduleId" TEXT;

-- CreateTable
CREATE TABLE "ContentSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "briefId" TEXT,
    "commitmentId" TEXT,
    "contentType" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "deliveryMode" TEXT NOT NULL DEFAULT 'manual',
    "destinationId" TEXT,
    "plannedForUtc" DATETIME NOT NULL,
    "plannedLocalDate" TEXT NOT NULL,
    "plannedLocalTime" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "dstDisambiguation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "ownerId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ContentSchedule_projectId_plannedForUtc_idx" ON "ContentSchedule"("projectId", "plannedForUtc");

-- CreateIndex
CREATE INDEX "ContentSchedule_projectId_status_idx" ON "ContentSchedule"("projectId", "status");

-- CreateIndex
CREATE INDEX "ContentSchedule_assetId_idx" ON "ContentSchedule"("assetId");

-- CreateIndex
CREATE INDEX "ContentSchedule_plannedForUtc_idx" ON "ContentSchedule"("plannedForUtc");

-- CreateIndex
CREATE INDEX "ContentSchedule_ownerId_idx" ON "ContentSchedule"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentSchedule_projectId_idempotencyKey_key" ON "ContentSchedule"("projectId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Publication_scheduleId_idx" ON "Publication"("scheduleId");
