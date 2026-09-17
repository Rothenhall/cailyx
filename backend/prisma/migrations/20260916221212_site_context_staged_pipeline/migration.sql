-- CreateTable
CREATE TABLE "SiteContextRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "error" TEXT,
    "maxPages" INTEGER NOT NULL DEFAULT 12,
    "maxRequests" INTEGER NOT NULL DEFAULT 40,
    "maxChars" INTEGER NOT NULL DEFAULT 24000,
    "maxElapsedMs" INTEGER NOT NULL DEFAULT 120000,
    "maxRetriesPerPage" INTEGER NOT NULL DEFAULT 2,
    "pagesSpent" INTEGER NOT NULL DEFAULT 0,
    "requestsSpent" INTEGER NOT NULL DEFAULT 0,
    "charsSpent" INTEGER NOT NULL DEFAULT 0,
    "elapsedMs" INTEGER NOT NULL DEFAULT 0,
    "refine" BOOLEAN NOT NULL DEFAULT true,
    "coveragePlan" TEXT NOT NULL DEFAULT '{}',
    "notes" TEXT NOT NULL DEFAULT '[]',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SiteContextRunPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "discoverySource" TEXT NOT NULL,
    "fetched" BOOLEAN NOT NULL DEFAULT false,
    "statusCode" INTEGER,
    "fetchedAt" DATETIME,
    "html" TEXT,
    "text" TEXT,
    "title" TEXT,
    "description" TEXT,
    "headings" TEXT NOT NULL DEFAULT '[]',
    "language" TEXT,
    "pageType" TEXT,
    "contentHash" TEXT,
    "duplicateOfUrl" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "selectionReason" TEXT,
    "purposeCategory" TEXT,
    "extractStatus" TEXT NOT NULL DEFAULT 'pending',
    "extractError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "SiteContextRunPage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SiteContextRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteContextFact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "excerpt" TEXT,
    "contentHash" TEXT,
    "observedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "validationNote" TEXT,
    CONSTRAINT "SiteContextFact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SiteContextRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SiteContext" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "category" TEXT,
    "vertical" TEXT,
    "description" TEXT,
    "geo" TEXT,
    "markets" TEXT NOT NULL DEFAULT '[]',
    "services" TEXT NOT NULL DEFAULT '[]',
    "icp" TEXT NOT NULL DEFAULT '[]',
    "valueProps" TEXT NOT NULL DEFAULT '[]',
    "painPoints" TEXT NOT NULL DEFAULT '[]',
    "outcomes" TEXT NOT NULL DEFAULT '[]',
    "competitors" TEXT NOT NULL DEFAULT '[]',
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "pageUrls" TEXT NOT NULL DEFAULT '[]',
    "extraction" TEXT NOT NULL DEFAULT 'deterministic',
    "llmModel" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT,
    "fieldSources" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "SiteContext_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SiteContextRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_SiteContext" ("brand", "category", "competitors", "costUsd", "createdAt", "description", "domain", "extraction", "geo", "icp", "id", "llmModel", "markets", "outcomes", "pageUrls", "pagesFetched", "painPoints", "projectId", "services", "valueProps", "vertical") SELECT "brand", "category", "competitors", "costUsd", "createdAt", "description", "domain", "extraction", "geo", "icp", "id", "llmModel", "markets", "outcomes", "pageUrls", "pagesFetched", "painPoints", "projectId", "services", "valueProps", "vertical" FROM "SiteContext";
DROP TABLE "SiteContext";
ALTER TABLE "new_SiteContext" RENAME TO "SiteContext";
CREATE UNIQUE INDEX "SiteContext_runId_key" ON "SiteContext"("runId");
CREATE INDEX "SiteContext_projectId_idx" ON "SiteContext"("projectId");
CREATE INDEX "SiteContext_projectId_createdAt_idx" ON "SiteContext"("projectId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "SiteContextRun_projectId_idx" ON "SiteContextRun"("projectId");

-- CreateIndex
CREATE INDEX "SiteContextRun_projectId_createdAt_idx" ON "SiteContextRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteContextRunPage_runId_idx" ON "SiteContextRunPage"("runId");

-- CreateIndex
CREATE INDEX "SiteContextRunPage_runId_selected_idx" ON "SiteContextRunPage"("runId", "selected");

-- CreateIndex
CREATE UNIQUE INDEX "SiteContextRunPage_runId_url_key" ON "SiteContextRunPage"("runId", "url");

-- CreateIndex
CREATE INDEX "SiteContextFact_runId_idx" ON "SiteContextFact"("runId");

-- CreateIndex
CREATE INDEX "SiteContextFact_runId_field_idx" ON "SiteContextFact"("runId", "field");
