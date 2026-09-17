-- CreateTable
CREATE TABLE "CompetitorRejection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "domainKey" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CompetitorComparisonSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "competitorSetVersion" TEXT NOT NULL,
    "extractionVersion" TEXT NOT NULL DEFAULT 'gap-v1',
    "sourceObservationIds" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Competitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "source" TEXT NOT NULL DEFAULT 'project-json',
    "status" TEXT NOT NULL DEFAULT 'tracked',
    "relevance" TEXT NOT NULL DEFAULT 'direct-competitor',
    "discoveryReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Competitor" ("createdAt", "domain", "id", "name", "projectId", "source", "status") SELECT "createdAt", "domain", "id", "name", "projectId", "source", "status" FROM "Competitor";
DROP TABLE "Competitor";
ALTER TABLE "new_Competitor" RENAME TO "Competitor";
CREATE INDEX "Competitor_projectId_idx" ON "Competitor"("projectId");
CREATE UNIQUE INDEX "Competitor_projectId_name_key" ON "Competitor"("projectId", "name");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CompetitorRejection_projectId_domainKey_idx" ON "CompetitorRejection"("projectId", "domainKey");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorRejection_projectId_nameKey_key" ON "CompetitorRejection"("projectId", "nameKey");

-- CreateIndex
CREATE INDEX "CompetitorComparisonSnapshot_projectId_generatedAt_idx" ON "CompetitorComparisonSnapshot"("projectId", "generatedAt");
