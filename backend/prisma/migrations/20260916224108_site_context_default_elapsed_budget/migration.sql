-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SiteContextRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "error" TEXT,
    "maxPages" INTEGER NOT NULL DEFAULT 12,
    "maxRequests" INTEGER NOT NULL DEFAULT 40,
    "maxChars" INTEGER NOT NULL DEFAULT 24000,
    "maxElapsedMs" INTEGER NOT NULL DEFAULT 300000,
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
INSERT INTO "new_SiteContextRun" ("charsSpent", "coveragePlan", "createdAt", "domain", "elapsedMs", "error", "finishedAt", "id", "maxChars", "maxElapsedMs", "maxPages", "maxRequests", "maxRetriesPerPage", "notes", "pagesSpent", "projectId", "refine", "requestsSpent", "stage", "startedAt", "status", "updatedAt") SELECT "charsSpent", "coveragePlan", "createdAt", "domain", "elapsedMs", "error", "finishedAt", "id", "maxChars", "maxElapsedMs", "maxPages", "maxRequests", "maxRetriesPerPage", "notes", "pagesSpent", "projectId", "refine", "requestsSpent", "stage", "startedAt", "status", "updatedAt" FROM "SiteContextRun";
DROP TABLE "SiteContextRun";
ALTER TABLE "new_SiteContextRun" RENAME TO "SiteContextRun";
CREATE INDEX "SiteContextRun_projectId_idx" ON "SiteContextRun"("projectId");
CREATE INDEX "SiteContextRun_projectId_createdAt_idx" ON "SiteContextRun"("projectId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
