/*
  Warnings:

  - The required column `briefFamilyId` was added to the `ContentBrief` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- CreateTable
CREATE TABLE "Commitment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "workstream" TEXT NOT NULL DEFAULT 'other',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "targetCount" INTEGER,
    "targetUnit" TEXT,
    "targetDate" DATETIME,
    "outcomeMetricLabel" TEXT,
    "outcomeMetricUnit" TEXT,
    "outcomeMetricBaseline" REAL,
    "outcomeMetricTarget" REAL,
    "outcomeMetricCurrent" REAL,
    "outcomeMetricObservedAt" DATETIME,
    "accountableLead" TEXT,
    "clientVisibleLead" BOOLEAN NOT NULL DEFAULT false,
    "linkedWorkItemIds" TEXT NOT NULL DEFAULT '[]',
    "contentRef" TEXT,
    "agreedAt" DATETIME,
    "agreedBy" TEXT,
    "scopeChanges" TEXT NOT NULL DEFAULT '[]',
    "supersededBy" TEXT,
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ContentBrief" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "briefFamilyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "assetType" TEXT NOT NULL DEFAULT 'article',
    "targetQuery" TEXT,
    "supportingQueries" TEXT NOT NULL DEFAULT '[]',
    "audience" TEXT,
    "intent" TEXT,
    "angle" TEXT,
    "mustInclude" TEXT NOT NULL DEFAULT '[]',
    "claimIds" TEXT NOT NULL DEFAULT '[]',
    "references" TEXT NOT NULL DEFAULT '[]',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "wordTarget" INTEGER,
    "language" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ContentBrief" ("angle", "approvedAt", "approvedBy", "assetType", "audience", "claimIds", "createdAt", "createdBy", "id", "intent", "language", "mustInclude", "projectId", "references", "sourceId", "sourceType", "status", "supportingQueries", "targetQuery", "title", "updatedAt", "version", "wordTarget") SELECT "angle", "approvedAt", "approvedBy", "assetType", "audience", "claimIds", "createdAt", "createdBy", "id", "intent", "language", "mustInclude", "projectId", "references", "sourceId", "sourceType", "status", "supportingQueries", "targetQuery", "title", "updatedAt", "version", "wordTarget" FROM "ContentBrief";
DROP TABLE "ContentBrief";
ALTER TABLE "new_ContentBrief" RENAME TO "ContentBrief";
CREATE INDEX "ContentBrief_projectId_status_idx" ON "ContentBrief"("projectId", "status");
CREATE INDEX "ContentBrief_projectId_briefFamilyId_idx" ON "ContentBrief"("projectId", "briefFamilyId");
CREATE INDEX "ContentBrief_projectId_title_idx" ON "ContentBrief"("projectId", "title");
CREATE UNIQUE INDEX "ContentBrief_projectId_briefFamilyId_version_key" ON "ContentBrief"("projectId", "briefFamilyId", "version");
CREATE TABLE "new_ContentRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "fields" TEXT NOT NULL DEFAULT '{}',
    "briefId" TEXT,
    "briefVersion" INTEGER,
    "origin" TEXT NOT NULL DEFAULT 'generation',
    "generationItemId" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "authorId" TEXT,
    "contentHash" TEXT,
    "clientVisible" BOOLEAN NOT NULL DEFAULT false,
    "clientVisibleAt" DATETIME,
    "clientVisibleBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ContentRevision" ("assetId", "authorId", "body", "briefId", "briefVersion", "contentHash", "createdAt", "fields", "generationItemId", "id", "origin", "revision", "title", "wordCount") SELECT "assetId", "authorId", "body", "briefId", "briefVersion", "contentHash", "createdAt", "fields", "generationItemId", "id", "origin", "revision", "title", "wordCount" FROM "ContentRevision";
DROP TABLE "ContentRevision";
ALTER TABLE "new_ContentRevision" RENAME TO "ContentRevision";
CREATE INDEX "ContentRevision_assetId_idx" ON "ContentRevision"("assetId");
CREATE INDEX "ContentRevision_assetId_clientVisible_idx" ON "ContentRevision"("assetId", "clientVisible");
CREATE UNIQUE INDEX "ContentRevision_assetId_revision_key" ON "ContentRevision"("assetId", "revision");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Commitment_projectId_status_idx" ON "Commitment"("projectId", "status");

-- CreateIndex
CREATE INDEX "Commitment_cycleId_idx" ON "Commitment"("cycleId");
