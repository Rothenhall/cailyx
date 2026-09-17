-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BusinessProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "brandName" TEXT,
    "legalName" TEXT,
    "description" TEXT,
    "services" TEXT NOT NULL DEFAULT '[]',
    "icp" TEXT NOT NULL DEFAULT '{}',
    "markets" TEXT NOT NULL DEFAULT '[]',
    "languages" TEXT NOT NULL DEFAULT '[]',
    "targets" TEXT NOT NULL DEFAULT '[]',
    "facts" TEXT NOT NULL DEFAULT '[]',
    "competitors" TEXT NOT NULL DEFAULT '[]',
    "goals" TEXT NOT NULL DEFAULT '[]',
    "approvers" TEXT NOT NULL DEFAULT '[]',
    "publishing" TEXT NOT NULL DEFAULT '{}',
    "confirmedBy" TEXT,
    "confirmedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_BusinessProfile" ("approvers", "brandName", "competitors", "confirmedAt", "confirmedBy", "createdAt", "description", "facts", "goals", "icp", "id", "languages", "legalName", "markets", "projectId", "publishing", "services", "updatedAt", "version") SELECT "approvers", "brandName", "competitors", "confirmedAt", "confirmedBy", "createdAt", "description", "facts", "goals", "icp", "id", "languages", "legalName", "markets", "projectId", "publishing", "services", "updatedAt", "version" FROM "BusinessProfile";
DROP TABLE "BusinessProfile";
ALTER TABLE "new_BusinessProfile" RENAME TO "BusinessProfile";
CREATE INDEX "BusinessProfile_projectId_idx" ON "BusinessProfile"("projectId");
CREATE UNIQUE INDEX "BusinessProfile_projectId_version_key" ON "BusinessProfile"("projectId", "version");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
