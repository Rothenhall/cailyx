-- Progress module + outstanding Report column — additive only, idempotent.
--
-- Apply to the shared Supabase database BEFORE deploying the backend that
-- carries these schema changes. Prisma selects every scalar column, so a
-- deploy that reaches a database without `WorkItem.targets` fails every
-- work-item query, and one without `Report.aeoVisibilitySnapshot` fails every
-- report query.
--
-- Written by hand because `prisma migrate` is blocked (P3019, see
-- docs/PRODUCTION-READINESS.md §5) and `db push` hangs over the pooled URL.
-- Safe to run more than once.

-- 1. Outstanding from commit 734a9a0 ("AEO visibility section"): the column
--    was added to schema.prisma but never applied to the shared database.
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "aeoVisibilitySnapshot" TEXT;

-- 2. What a work item is aimed at moving in the AEO audit (JSON ProgressTarget[]).
ALTER TABLE "WorkItem" ADD COLUMN IF NOT EXISTS "targets" TEXT;

-- 3. One progress review per completed AEO audit.
CREATE TABLE IF NOT EXISTS "ProgressReview" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "auditFinishedAt" TIMESTAMP(3) NOT NULL,
    "previousAuditId" TEXT,
    "baselineAuditId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reason" TEXT,
    "layout" TEXT NOT NULL DEFAULT 'compact',
    "ledger" TEXT NOT NULL DEFAULT '{}',
    "story" TEXT,
    "storySource" TEXT,
    "model" TEXT,
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProgressReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProgressReview_auditId_key" ON "ProgressReview"("auditId");
CREATE INDEX IF NOT EXISTS "ProgressReview_projectId_status_idx" ON "ProgressReview"("projectId", "status");
CREATE INDEX IF NOT EXISTS "ProgressReview_projectId_auditFinishedAt_idx" ON "ProgressReview"("projectId", "auditFinishedAt");
