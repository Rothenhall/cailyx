-- P14 — the Cailyx digital-performance score family (platform_improvement_plan.md
-- §5.2–§5.5). Purely additive: four new tables, no column is changed on any
-- existing table, and nothing here reads or rewrites a legacy ScoreRun /
-- ScoreRubric row — old reports keep their old score name and methodology.

-- CreateTable
CREATE TABLE "ScoreMethodology" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "family" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ScoreFamilyRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "family" TEXT NOT NULL DEFAULT 'digital-performance',
    "methodologyVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "total" INTEGER,
    "band" TEXT,
    "applicableWeightTotal" INTEGER NOT NULL,
    "weightedPointsTotal" INTEGER,
    "evidenceCoverage" INTEGER NOT NULL,
    "comparisonKey" TEXT NOT NULL,
    "segmentIndex" INTEGER NOT NULL,
    "comparisonState" TEXT NOT NULL,
    "previousRunId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "applicabilitySnapshot" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ScoreBucketRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "applicability" TEXT NOT NULL,
    "applicabilityReason" TEXT,
    "state" TEXT NOT NULL,
    "value" INTEGER,
    "weightedPoints" INTEGER NOT NULL DEFAULT 0,
    "effectiveWeight" INTEGER NOT NULL DEFAULT 0,
    "contribution" REAL NOT NULL DEFAULT 0,
    "windowStart" DATETIME,
    "windowEnd" DATETIME,
    "methodologyVersion" INTEGER NOT NULL,
    "metricVersion" TEXT NOT NULL,
    "metricInputs" TEXT NOT NULL DEFAULT '[]',
    "thresholds" TEXT NOT NULL DEFAULT '{}',
    "sources" TEXT NOT NULL DEFAULT '[]',
    "maxAgeDays" INTEGER NOT NULL,
    "minSample" INTEGER NOT NULL,
    "missingReasons" TEXT NOT NULL DEFAULT '[]',
    "notes" TEXT NOT NULL DEFAULT '[]',
    "detailPath" TEXT,
    "detailQuery" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoreBucketRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScoreFamilyRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScoreApplicabilityDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorEmail" TEXT,
    "methodologyVersion" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" DATETIME
);

-- CreateIndex
CREATE INDEX "ScoreMethodology_family_active_idx" ON "ScoreMethodology"("family", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreMethodology_family_version_key" ON "ScoreMethodology"("family", "version");

-- CreateIndex
CREATE INDEX "ScoreFamilyRun_projectId_createdAt_idx" ON "ScoreFamilyRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ScoreFamilyRun_projectId_family_createdAt_idx" ON "ScoreFamilyRun"("projectId", "family", "createdAt");

-- CreateIndex
CREATE INDEX "ScoreFamilyRun_projectId_family_comparisonKey_idx" ON "ScoreFamilyRun"("projectId", "family", "comparisonKey");

-- CreateIndex
CREATE INDEX "ScoreBucketRun_key_state_idx" ON "ScoreBucketRun"("key", "state");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreBucketRun_runId_key_key" ON "ScoreBucketRun"("runId", "key");

-- CreateIndex
CREATE INDEX "ScoreApplicabilityDecision_projectId_bucketKey_idx" ON "ScoreApplicabilityDecision"("projectId", "bucketKey");

-- CreateIndex
CREATE INDEX "ScoreApplicabilityDecision_projectId_supersededAt_idx" ON "ScoreApplicabilityDecision"("projectId", "supersededAt");
