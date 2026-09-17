-- CreateTable
CREATE TABLE "PresenceApplicabilityOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "actorEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" DATETIME
);

-- CreateTable
CREATE TABLE "PresenceRejection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reconsideredAt" DATETIME,
    "reconsideredBy" TEXT
);

-- CreateIndex
CREATE INDEX "PresenceApplicabilityOverride_projectId_platform_idx" ON "PresenceApplicabilityOverride"("projectId", "platform");

-- CreateIndex
CREATE INDEX "PresenceRejection_projectId_platform_normalizedUrl_idx" ON "PresenceRejection"("projectId", "platform", "normalizedUrl");
