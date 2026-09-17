-- AlterTable
ALTER TABLE "GrowthAsset" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "GrowthAsset" ADD COLUMN "sourceOpportunityId" TEXT;

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "topicDisplay" TEXT NOT NULL,
    "market" TEXT,
    "language" TEXT,
    "intent" TEXT NOT NULL DEFAULT 'unspecified',
    "evidenceSourceFamily" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "measuredAt" DATETIME NOT NULL,
    "clientPositionStatus" TEXT NOT NULL DEFAULT 'unknown',
    "clientPosition" INTEGER,
    "rivalPositionStatus" TEXT NOT NULL DEFAULT 'unknown',
    "rivalPosition" INTEGER,
    "rivalName" TEXT,
    "rivalCompetitorId" TEXT,
    "relevance" INTEGER NOT NULL DEFAULT 0,
    "demandVolume" INTEGER,
    "demandCpc" REAL,
    "demandCompetition" TEXT,
    "suggestedContentType" TEXT,
    "existingContentMatchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "dismissedReason" TEXT,
    "dismissedAt" DATETIME,
    "linkedGrowthAssetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Opportunity_projectId_idx" ON "Opportunity"("projectId");

-- CreateIndex
CREATE INDEX "Opportunity_projectId_status_idx" ON "Opportunity"("projectId", "status");

-- CreateIndex
CREATE INDEX "Opportunity_projectId_origin_idx" ON "Opportunity"("projectId", "origin");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_projectId_topic_market_language_intent_evidenceSourceFamily_key" ON "Opportunity"("projectId", "topic", "market", "language", "intent", "evidenceSourceFamily");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthAsset_idempotencyKey_key" ON "GrowthAsset"("idempotencyKey");

-- CreateIndex
CREATE INDEX "GrowthAsset_sourceOpportunityId_idx" ON "GrowthAsset"("sourceOpportunityId");

