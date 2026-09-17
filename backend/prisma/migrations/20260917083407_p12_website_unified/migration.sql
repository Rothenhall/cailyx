-- CreateTable
CREATE TABLE "WebsitePageIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sourceUrls" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GoogleDataSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "windowStart" TEXT NOT NULL,
    "windowEnd" TEXT NOT NULL,
    "timezoneNote" TEXT NOT NULL,
    "rows" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT true,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WebsiteInsightSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "pageIdentityId" TEXT,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "limitations" TEXT NOT NULL DEFAULT '',
    "actionTarget" TEXT NOT NULL DEFAULT '',
    "sourceIds" TEXT NOT NULL DEFAULT '[]',
    "factsJson" TEXT NOT NULL DEFAULT '{}',
    "validFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WritingStyleProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL DEFAULT 'Default style',
    "summary" TEXT,
    "tone" TEXT,
    "preferredWords" TEXT NOT NULL DEFAULT '[]',
    "avoidWords" TEXT NOT NULL DEFAULT '[]',
    "exampleSentences" TEXT NOT NULL DEFAULT '[]',
    "ctaPreferences" TEXT,
    "formality" TEXT NOT NULL DEFAULT 'neutral',
    "audience" TEXT,
    "channelDifferences" TEXT NOT NULL DEFAULT '{}',
    "sourceType" TEXT NOT NULL DEFAULT 'manual',
    "suggestionSourceId" TEXT,
    "fingerprint" TEXT,
    "confirmedBy" TEXT,
    "confirmedAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "jobRunId" TEXT,
    "briefId" TEXT,
    "briefVersion" INTEGER,
    "assetType" TEXT NOT NULL,
    "requested" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider" TEXT,
    "model" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "input" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "requestedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "idempotencyKey" TEXT,
    "actorId" TEXT,
    "contentAssetId" TEXT,
    "writingStyleProfileId" TEXT,
    "writingStyleVersion" INTEGER,
    "writingStyleFingerprint" TEXT,
    "businessProfileVersion" INTEGER,
    "sourceEvidenceIds" TEXT NOT NULL DEFAULT '[]',
    "generationSettings" TEXT NOT NULL DEFAULT '{}',
    "costReservationUsd" REAL NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "cancelledAt" DATETIME,
    "revisionId" TEXT
);
INSERT INTO "new_GenerationJob" ("assetType", "briefId", "briefVersion", "costUsd", "createdAt", "error", "failed", "id", "input", "jobRunId", "model", "projectId", "provider", "requested", "requestedBy", "status", "succeeded", "updatedAt") SELECT "assetType", "briefId", "briefVersion", "costUsd", "createdAt", "error", "failed", "id", "input", "jobRunId", "model", "projectId", "provider", "requested", "requestedBy", "status", "succeeded", "updatedAt" FROM "GenerationJob";
DROP TABLE "GenerationJob";
ALTER TABLE "new_GenerationJob" RENAME TO "GenerationJob";
CREATE INDEX "GenerationJob_projectId_status_idx" ON "GenerationJob"("projectId", "status");
CREATE UNIQUE INDEX "GenerationJob_projectId_idempotencyKey_key" ON "GenerationJob"("projectId", "idempotencyKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "WebsitePageIdentity_projectId_idx" ON "WebsitePageIdentity"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "WebsitePageIdentity_projectId_canonicalUrl_key" ON "WebsitePageIdentity"("projectId", "canonicalUrl");

-- CreateIndex
CREATE INDEX "GoogleDataSnapshot_projectId_service_kind_idx" ON "GoogleDataSnapshot"("projectId", "service", "kind");

-- CreateIndex
CREATE INDEX "WebsiteInsightSnapshot_projectId_ruleId_idx" ON "WebsiteInsightSnapshot"("projectId", "ruleId");

-- CreateIndex
CREATE INDEX "WebsiteInsightSnapshot_pageIdentityId_idx" ON "WebsiteInsightSnapshot"("pageIdentityId");

-- CreateIndex
CREATE INDEX "WritingStyleProfile_projectId_idx" ON "WritingStyleProfile"("projectId");

-- CreateIndex
CREATE INDEX "WritingStyleProfile_projectId_confirmedAt_idx" ON "WritingStyleProfile"("projectId", "confirmedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WritingStyleProfile_projectId_version_key" ON "WritingStyleProfile"("projectId", "version");
