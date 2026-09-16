-- CreateTable
CREATE TABLE "TechnicalAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score" INTEGER,
    "previousAuditId" TEXT,
    "deltas" TEXT,
    "sitemapUrl" TEXT,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "observability" TEXT,
    "narrative" TEXT,
    "narrativeModel" TEXT,
    "narrativeAt" DATETIME
);

-- CreateTable
CREATE TABLE "AuditPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "lastmod" DATETIME,
    "title" TEXT,
    "titleLength" INTEGER,
    "metaDescription" TEXT,
    "metaDescLength" INTEGER,
    "h1Count" INTEGER,
    "canonical" TEXT,
    "wordCount" INTEGER,
    "imageCount" INTEGER,
    "imagesMissingAlt" INTEGER,
    "contentHash" TEXT,
    "jsonLdTypes" TEXT,
    "jsonLdValid" BOOLEAN NOT NULL DEFAULT false,
    "jsonLdCount" INTEGER NOT NULL DEFAULT 0,
    "issues" TEXT,
    "score" INTEGER,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditPage_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "TechnicalAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "recommendedFix" TEXT NOT NULL,
    "reproductionCommands" TEXT,
    CONSTRAINT "AuditFinding_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "TechnicalAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScheduleConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'manual-only',
    "nextRunAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "targetUrl" TEXT,
    "lastRunAt" DATETIME,
    "lastError" TEXT,
    "seoCadence" TEXT NOT NULL DEFAULT 'manual-only',
    "seoNextRunAt" DATETIME,
    "seoActive" BOOLEAN NOT NULL DEFAULT false,
    "seoLastRunAt" DATETIME,
    "seoLastError" TEXT
);

-- CreateTable
CREATE TABLE "PageMetadata" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "title" TEXT,
    "metaDescription" TEXT,
    "headings" TEXT,
    "positioningCopy" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PageMetadata_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "TechnicalAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FetchLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "calledBy" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "userAgent" TEXT,
    "httpStatus" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "cost" REAL NOT NULL DEFAULT 0,
    "cached" BOOLEAN NOT NULL DEFAULT false,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EntityAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityAuditId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "descriptor" TEXT,
    "type" TEXT NOT NULL DEFAULT 'brand',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Entity_entityAuditId_fkey" FOREIGN KEY ("entityAuditId") REFERENCES "EntityAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SchemaCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "schemaType" TEXT,
    "fieldsPresent" TEXT,
    "fieldsMissing" TEXT,
    "sameAsCount" INTEGER NOT NULL DEFAULT 0,
    "sameAsUrls" TEXT,
    "sameAsVerification" TEXT,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pass',
    CONSTRAINT "SchemaCheck_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlatformRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "recordedName" TEXT,
    "recordedDescriptor" TEXT,
    "sourceUrl" TEXT,
    "consistencyStatus" TEXT NOT NULL DEFAULT 'not-checked',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformRecord_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelDiff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "rawAnswer" TEXT,
    "citations" TEXT,
    "divergence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'not-run',
    "costUsd" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelDiff_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GapAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Gap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "gapAnalysisId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "dimensionAutoAssigned" BOOLEAN NOT NULL DEFAULT true,
    "action" TEXT NOT NULL,
    "actionAutoAssigned" BOOLEAN NOT NULL DEFAULT true,
    "category" TEXT NOT NULL DEFAULT 'issue',
    "categoryAutoAssigned" BOOLEAN NOT NULL DEFAULT true,
    "recommendationCategory" TEXT,
    "impactScore" INTEGER,
    "effortScore" INTEGER,
    "scoreAutoAssigned" BOOLEAN NOT NULL DEFAULT true,
    "quadrant" TEXT,
    "demandPotential" INTEGER,
    "credibilityImpact" INTEGER,
    "citationLikelihood" INTEGER,
    "priorityScore" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "copyAutoAssigned" BOOLEAN NOT NULL DEFAULT true,
    "severity" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Gap_gapAnalysisId_fkey" FOREIGN KEY ("gapAnalysisId") REFERENCES "GapAnalysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActionPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Recommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionPlanId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "gapIds" TEXT NOT NULL DEFAULT '[]',
    "quickWinCount" INTEGER NOT NULL DEFAULT 0,
    "majorProjectCount" INTEGER NOT NULL DEFAULT 0,
    "fillInCount" INTEGER NOT NULL DEFAULT 0,
    "thanklessTaskCount" INTEGER NOT NULL DEFAULT 0,
    "priorityRank" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Recommendation_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "category" TEXT,
    "clientName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'diagnostic',
    "notes" TEXT,
    "userId" TEXT,
    "competitors" TEXT,
    "clientId" TEXT,
    "onboardingStatus" TEXT NOT NULL DEFAULT 'pending',
    "onboardingStep" TEXT,
    "onboardingError" TEXT,
    "engagementId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "ownerUserId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ClientMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "projectId" TEXT,
    "authorUserId" TEXT NOT NULL,
    "authorType" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "internal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AttributionResponse" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "prompt" TEXT,
    "note" TEXT,
    "contactEmail" TEXT,
    "page" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "executiveSummary" TEXT NOT NULL,
    "scoreTotal" INTEGER NOT NULL,
    "scoreBand" TEXT NOT NULL,
    "subScores" TEXT NOT NULL,
    "findingsSnapshot" TEXT NOT NULL,
    "roadmapSnapshot" TEXT NOT NULL,
    "growthPlanSnapshot" TEXT,
    "backlinksSnapshot" TEXT,
    "presenceSnapshot" TEXT,
    "competitorsSnapshot" TEXT,
    "branding" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "releasedRevision" INTEGER,
    "releasedAt" DATETIME,
    "releasedBy" TEXT,
    "periodId" TEXT,
    "cohortId" TEXT,
    "manifestId" TEXT,
    "templateId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "QuerySet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "persona" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" DATETIME
);

-- CreateTable
CREATE TABLE "QuerySetItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "querySetId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "funnelStage" TEXT NOT NULL,
    "dimension" TEXT,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuerySetItem_querySetId_fkey" FOREIGN KEY ("querySetId") REFERENCES "QuerySet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'technical',
    "type" TEXT NOT NULL DEFAULT 'operator',
    "clientId" TEXT,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoogleConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "googleEmail" TEXT,
    "scope" TEXT NOT NULL DEFAULT '',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "connectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastError" TEXT
);

-- CreateTable
CREATE TABLE "GoogleProjectResource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceLabel" TEXT,
    "lastSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GoogleProjectResource_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GoogleConnection" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeoAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowDays" INTEGER NOT NULL DEFAULT 28,
    "score" INTEGER,
    "previousAuditId" TEXT,
    "deltas" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "ctr" REAL NOT NULL DEFAULT 0,
    "position" REAL NOT NULL DEFAULT 0,
    "page1Queries" INTEGER NOT NULL DEFAULT 0,
    "top3Queries" INTEGER NOT NULL DEFAULT 0,
    "metrics" TEXT,
    "pagesInspected" INTEGER NOT NULL DEFAULT 0,
    "observability" TEXT,
    "narrative" TEXT,
    "narrativeModel" TEXT,
    "narrativeAt" DATETIME
);

-- CreateTable
CREATE TABLE "SeoQuery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "ctr" REAL NOT NULL DEFAULT 0,
    "position" REAL NOT NULL DEFAULT 0,
    "positionDelta" REAL,
    "impressionsDelta" INTEGER,
    "clicksDelta" INTEGER,
    "topPage" TEXT,
    "opportunities" TEXT,
    CONSTRAINT "SeoQuery_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "SeoAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeoPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "ctr" REAL NOT NULL DEFAULT 0,
    "position" REAL NOT NULL DEFAULT 0,
    "coverageState" TEXT,
    "indexVerdict" TEXT,
    "indexingState" TEXT,
    "robotsTxtState" TEXT,
    "pageFetchState" TEXT,
    "googleCanonical" TEXT,
    "userCanonical" TEXT,
    "lastCrawlTime" DATETIME,
    "issues" TEXT,
    "richResults" TEXT,
    "richIssues" TEXT,
    CONSTRAINT "SeoPage_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "SeoAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SeoFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "recommendedFix" TEXT NOT NULL,
    "affected" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "fixArtifact" TEXT,
    "action" TEXT,
    CONSTRAINT "SeoFinding_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "SeoAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MeasurementRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "querySetId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "geo" TEXT NOT NULL DEFAULT 'US',
    "runCount" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalRequests" INTEGER NOT NULL DEFAULT 0,
    "completedRequests" INTEGER NOT NULL DEFAULT 0,
    "failedRequests" INTEGER NOT NULL DEFAULT 0,
    "costTotal" REAL NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Observation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "runNumber" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "mentioned" BOOLEAN NOT NULL DEFAULT false,
    "cited" BOOLEAN NOT NULL DEFAULT false,
    "citedUrl" TEXT,
    "position" INTEGER,
    "competitors" TEXT NOT NULL DEFAULT '[]',
    "characterization" TEXT,
    "rawAnswer" TEXT NOT NULL,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Observation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MeasurementRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScoreRubric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "weights" TEXT NOT NULL,
    "bands" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ScoreRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "rubricVersion" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "band" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'complete',
    "subScores" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScoreRun_rubricVersion_fkey" FOREIGN KEY ("rubricVersion") REFERENCES "ScoreRubric" ("version") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sourceName" TEXT,
    "grade" TEXT,
    "gradeReason" TEXT,
    "checkResult" TEXT NOT NULL DEFAULT 'pending',
    "checkJson" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "gapId" TEXT,
    "title" TEXT NOT NULL,
    "whatExecutive" TEXT,
    "whatTechnical" TEXT,
    "whyExecutive" TEXT,
    "whyTechnical" TEXT,
    "fixExecutive" TEXT,
    "fixTechnical" TEXT,
    "thinRun" BOOLEAN NOT NULL DEFAULT false,
    "disclosedGap" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CrawlerHit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "hitAt" DATETIME NOT NULL,
    "url" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "ipAddress" TEXT,
    "botVendor" TEXT NOT NULL,
    "botName" TEXT NOT NULL,
    "botType" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "message" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PageAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "blufScore" INTEGER NOT NULL DEFAULT 0,
    "questionH2Score" INTEGER NOT NULL DEFAULT 0,
    "formatScore" INTEGER NOT NULL DEFAULT 0,
    "claimsScore" INTEGER NOT NULL DEFAULT 0,
    "structureScore" INTEGER NOT NULL DEFAULT 0,
    "blufText" TEXT,
    "headingStructure" TEXT NOT NULL DEFAULT '[]',
    "extractableClaims" TEXT NOT NULL DEFAULT '[]',
    "formatFindings" TEXT NOT NULL DEFAULT '{}',
    "llmNotes" TEXT,
    "fetchedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'complete',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MentionCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mentioned" BOOLEAN NOT NULL,
    "evidence" TEXT,
    "fetchedTitle" TEXT,
    "httpStatus" INTEGER,
    CONSTRAINT "MentionCheck_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "MentionTarget" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MentionTarget" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'listicle',
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "campaignId" TEXT,
    CONSTRAINT "MentionTarget_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MentionCampaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MentionCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "listicleQuery" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SleeperPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "label" TEXT,
    "trafficDeclinePct" REAL,
    "referringDomains" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'flagged',
    "dateModifiedBefore" TEXT,
    "dateModifiedAfter" TEXT,
    "refreshedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DataAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brandAlignment" TEXT NOT NULL DEFAULT 'brand-named',
    "methodologyNote" TEXT,
    "surveySize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "publishedAt" DATETIME,
    "assetUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GrowthAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "targetKeyword" TEXT,
    "sourceGapId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recommended',
    "source" TEXT NOT NULL DEFAULT 'deterministic',
    "generationModel" TEXT,
    "content" TEXT,
    "publishedAt" DATETIME,
    "assetUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ScorecardRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "band" TEXT NOT NULL,
    "topFindings" TEXT NOT NULL DEFAULT '[]',
    "nonObvious" BOOLEAN NOT NULL DEFAULT false,
    "depth" TEXT NOT NULL DEFAULT 'free',
    "publicToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PipelineMath" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "revenueTarget" REAL NOT NULL,
    "acv" REAL NOT NULL,
    "winRate" REAL NOT NULL,
    "meetingToSql" REAL NOT NULL,
    "leadToMeeting" REAL NOT NULL,
    "visitorToLead" REAL NOT NULL,
    "marketSize" REAL,
    "stages" TEXT NOT NULL DEFAULT '{}',
    "verdict" TEXT NOT NULL DEFAULT 'feasible',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "source" TEXT NOT NULL DEFAULT 'form',
    "status" TEXT NOT NULL DEFAULT 'new',
    "scorecardRunId" TEXT,
    "ctaEvents" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Upgrade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "leadId" TEXT,
    "tier" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "checkoutUrl" TEXT,
    "stripeSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Persona" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "seniority" TEXT NOT NULL DEFAULT 'lead',
    "companyStage" TEXT NOT NULL DEFAULT 'growth',
    "awareness" TEXT NOT NULL DEFAULT 'problem-aware',
    "primaryGoal" TEXT NOT NULL,
    "researchObjective" TEXT NOT NULL,
    "painPoints" TEXT NOT NULL DEFAULT '[]',
    "buyingTriggers" TEXT NOT NULL DEFAULT '[]',
    "objections" TEXT NOT NULL DEFAULT '[]',
    "vocabulary" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "source" TEXT NOT NULL DEFAULT 'generated',
    "generationModel" TEXT,
    "seed" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Journey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "campaignId" TEXT,
    "label" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'mock',
    "geo" TEXT NOT NULL DEFAULT 'US',
    "maxDepth" INTEGER NOT NULL DEFAULT 4,
    "maxBranches" INTEGER NOT NULL DEFAULT 2,
    "planSource" TEXT NOT NULL DEFAULT 'deterministic',
    "planModel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "executedSteps" INTEGER NOT NULL DEFAULT 0,
    "mentionedSteps" INTEGER NOT NULL DEFAULT 0,
    "citedSteps" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "note" TEXT,
    "error" TEXT,
    "plannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "Journey_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Journey_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "JourneyCampaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JourneyStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "journeyId" TEXT NOT NULL,
    "parentId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL DEFAULT 'query',
    "awareness" TEXT NOT NULL DEFAULT 'problem-aware',
    "query" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answerText" TEXT,
    "citations" TEXT NOT NULL DEFAULT '[]',
    "mentioned" BOOLEAN NOT NULL DEFAULT false,
    "cited" BOOLEAN NOT NULL DEFAULT false,
    "citedUrl" TEXT,
    "position" INTEGER,
    "competitorsSeen" TEXT NOT NULL DEFAULT '[]',
    "costUsd" REAL NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "model" TEXT,
    "executedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JourneyStep_journeyId_fkey" FOREIGN KEY ("journeyId") REFERENCES "Journey" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "JourneyStep_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "JourneyStep" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JourneyCampaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "surface" TEXT NOT NULL DEFAULT 'mock',
    "geo" TEXT NOT NULL DEFAULT 'US',
    "planSource" TEXT NOT NULL DEFAULT 'deterministic',
    "journeyTarget" INTEGER NOT NULL DEFAULT 10,
    "maxDepth" INTEGER NOT NULL DEFAULT 4,
    "maxBranches" INTEGER NOT NULL DEFAULT 2,
    "personaRoles" TEXT NOT NULL DEFAULT '[]',
    "budgetUsd" REAL NOT NULL DEFAULT 5.0,
    "spentUsd" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "journeysPlanned" INTEGER NOT NULL DEFAULT 0,
    "journeysExecuted" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "LinkGraph" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "rootUrl" TEXT NOT NULL,
    "maxPages" INTEGER NOT NULL DEFAULT 50,
    "maxDepth" INTEGER NOT NULL DEFAULT 3,
    "source" TEXT NOT NULL DEFAULT 'http',
    "status" TEXT NOT NULL DEFAULT 'crawling',
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "orphanCount" INTEGER NOT NULL DEFAULT 0,
    "recommendationCount" INTEGER NOT NULL DEFAULT 0,
    "recSource" TEXT NOT NULL DEFAULT 'deterministic',
    "recModel" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "LinkNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "graphId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "title" TEXT,
    "h1" TEXT,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "topicKeywords" TEXT NOT NULL DEFAULT '[]',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "httpStatus" INTEGER NOT NULL DEFAULT 0,
    "inboundCount" INTEGER NOT NULL DEFAULT 0,
    "outboundCount" INTEGER NOT NULL DEFAULT 0,
    "isOrphan" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME,
    CONSTRAINT "LinkNode_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "LinkGraph" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LinkEdge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "graphId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "anchorText" TEXT NOT NULL DEFAULT '',
    "rel" TEXT,
    "context" TEXT,
    CONSTRAINT "LinkEdge_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "LinkGraph" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LinkRecommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "graphId" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "toPath" TEXT NOT NULL,
    "suggestedAnchor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "topicOverlap" REAL NOT NULL DEFAULT 0,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    CONSTRAINT "LinkRecommendation_graphId_fkey" FOREIGN KEY ("graphId") REFERENCES "LinkGraph" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CouncilSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "question" TEXT NOT NULL DEFAULT 'Which interventions will most improve our AI visibility?',
    "rounds" INTEGER NOT NULL DEFAULT 1,
    "agentRoles" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'deterministic',
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'complete',
    "evidenceRefs" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "CouncilContribution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "agentRole" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "positions" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CouncilContribution_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CouncilSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CouncilRanking" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "interventionKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "consensus" REAL NOT NULL DEFAULT 0,
    "expectedImpact" INTEGER NOT NULL DEFAULT 0,
    "effort" TEXT NOT NULL DEFAULT 'medium',
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "sourceRefs" TEXT NOT NULL DEFAULT '[]',
    "dissent" TEXT,
    CONSTRAINT "CouncilRanking_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CouncilSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SerpTracker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locationName" TEXT NOT NULL DEFAULT 'United States',
    "languageCode" TEXT NOT NULL DEFAULT 'en',
    "device" TEXT NOT NULL DEFAULT 'desktop',
    "provider" TEXT NOT NULL DEFAULT 'dataforseo',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SerpQuery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackerId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SerpQuery_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "SerpTracker" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SerpSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "trackerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "queriesRun" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "note" TEXT,
    "error" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "SerpSnapshot_trackerId_fkey" FOREIGN KEY ("trackerId") REFERENCES "SerpTracker" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SerpResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "subjectRank" INTEGER,
    "subjectUrl" TEXT,
    "aiOverviewPresent" BOOLEAN NOT NULL DEFAULT false,
    "aiOverviewMentionsSubject" BOOLEAN NOT NULL DEFAULT false,
    "featuredSnippetDomain" TEXT,
    "topDomains" TEXT NOT NULL DEFAULT '[]',
    "competitorsSeen" TEXT NOT NULL DEFAULT '[]',
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "rawItemCount" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "localPackApplicable" BOOLEAN NOT NULL DEFAULT true,
    "localPackReason" TEXT,
    "localPackPresent" BOOLEAN,
    "localPackRank" INTEGER,
    "localPackEntries" TEXT NOT NULL DEFAULT '[]',
    CONSTRAINT "SerpResult_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "SerpSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SerpResult_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "SerpQuery" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuthorityScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'combined',
    "status" TEXT NOT NULL DEFAULT 'running',
    "listicleQueries" TEXT NOT NULL DEFAULT '[]',
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "promotedCount" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "model" TEXT,
    "note" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "AuthorityCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'publication',
    "discoveredVia" TEXT NOT NULL,
    "rank" INTEGER,
    "relevance" REAL NOT NULL DEFAULT 0,
    "rationale" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "promotedTargetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthorityCandidate_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "AuthorityScan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SiteContext" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AeoAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "contextId" TEXT,
    "querySetId" TEXT,
    "runId" TEXT,
    "surface" TEXT NOT NULL DEFAULT 'chatgpt-browser',
    "surfaces" TEXT NOT NULL DEFAULT '[]',
    "markets" TEXT NOT NULL DEFAULT '[]',
    "tier" TEXT NOT NULL DEFAULT 'standard',
    "runCount" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stage" TEXT,
    "promptCount" INTEGER NOT NULL DEFAULT 0,
    "observations" INTEGER NOT NULL DEFAULT 0,
    "stanceJudged" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "verdict" TEXT,
    "error" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AeoAudit_contextId_fkey" FOREIGN KEY ("contextId") REFERENCES "SiteContext" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AeoSurfaceRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "market" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "observations" INTEGER NOT NULL DEFAULT 0,
    "stanceJudged" INTEGER NOT NULL DEFAULT 0,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "failureKind" TEXT,
    "error" TEXT,
    "attemptedVia" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AeoSurfaceRun_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AeoAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AeoStance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "auditId" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "surface" TEXT,
    "dimension" TEXT,
    "stance" TEXT NOT NULL,
    "rankAmongBrands" INTEGER,
    "brandsNamed" TEXT NOT NULL DEFAULT '[]',
    "recommendedOver" TEXT NOT NULL DEFAULT '[]',
    "losesTo" TEXT NOT NULL DEFAULT '[]',
    "otherNamesSeen" TEXT NOT NULL DEFAULT '[]',
    "evidenceQuote" TEXT,
    "rationale" TEXT,
    "judgeModel" TEXT NOT NULL,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AeoStance_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "AeoAudit" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PresenceAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "handle" TEXT,
    "source" TEXT NOT NULL,
    "entity" TEXT NOT NULL DEFAULT 'company',
    "state" TEXT NOT NULL,
    "reason" TEXT,
    "statusCode" INTEGER,
    "title" TEXT,
    "foundOn" TEXT,
    "confidence" REAL,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PresenceDiscovery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pagesFetched" INTEGER NOT NULL DEFAULT 0,
    "found" INTEGER NOT NULL DEFAULT 0,
    "confirmed" INTEGER NOT NULL DEFAULT 0,
    "unverified" INTEGER NOT NULL DEFAULT 0,
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "serpQueries" INTEGER NOT NULL DEFAULT 0,
    "serpCostUsd" REAL NOT NULL DEFAULT 0,
    "serpSkipped" TEXT,
    "sources" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "TechStackScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TechFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "confidence" REAL NOT NULL DEFAULT 1,
    "evidence" TEXT NOT NULL,
    CONSTRAINT "TechFinding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "TechStackScan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KeywordSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "seedInput" TEXT NOT NULL,
    "locationName" TEXT,
    "languageCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "setId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "searchVolume" INTEGER,
    "competition" TEXT,
    "competitionIndex" INTEGER,
    "cpc" REAL,
    "lowTopOfPageBid" REAL,
    "highTopOfPageBid" REAL,
    "isRelated" BOOLEAN NOT NULL DEFAULT false,
    "isLongTail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Keyword_setId_fkey" FOREIGN KEY ("setId") REFERENCES "KeywordSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BacklinksSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "rank" INTEGER,
    "backlinks" INTEGER,
    "backlinksSpamScore" INTEGER,
    "referringDomains" INTEGER,
    "referringMainDomains" INTEGER,
    "referringPages" INTEGER,
    "referringIps" INTEGER,
    "referringSubnets" INTEGER,
    "brokenBacklinks" INTEGER,
    "brokenPages" INTEGER,
    "firstSeen" DATETIME,
    "lostDate" DATETIME,
    "referringLinksTld" TEXT,
    "referringLinksTypes" TEXT,
    "referringLinksAttributes" TEXT,
    "referringLinksPlatformTypes" TEXT,
    "referringLinksCountries" TEXT,
    "topBacklinks" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "source" TEXT NOT NULL DEFAULT 'project-json',
    "status" TEXT NOT NULL DEFAULT 'tracked',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CompetitorProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "competitorId" TEXT NOT NULL,
    "domain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "error" TEXT,
    "techScanId" TEXT,
    "schemaTypes" TEXT NOT NULL DEFAULT '[]',
    "schemaRaw" TEXT NOT NULL DEFAULT '[]',
    "aeoStatus" TEXT NOT NULL DEFAULT 'unknown',
    "aeoStanding" TEXT,
    "aeoAuditId" TEXT,
    "serpStatus" TEXT NOT NULL DEFAULT 'unknown',
    "serpPresence" TEXT,
    "presenceStatus" TEXT NOT NULL DEFAULT 'unknown',
    "presenceAccounts" TEXT NOT NULL DEFAULT '[]',
    "presenceError" TEXT,
    "seoStatus" TEXT NOT NULL DEFAULT 'unknown',
    "seoScore" INTEGER,
    "seoIssues" TEXT NOT NULL DEFAULT '[]',
    "contentSignals" TEXT,
    "seoError" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'unknown',
    "reviewRatings" TEXT NOT NULL DEFAULT '[]',
    "reviewError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompetitorProfile_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PresenceProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'google-my-business',
    "name" TEXT,
    "categories" TEXT,
    "hours" TEXT,
    "rating" REAL,
    "reviewCount" INTEGER,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "raw" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PresenceReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "rating" REAL,
    "reviewCount" INTEGER,
    "url" TEXT,
    "raw" TEXT,
    "source" TEXT NOT NULL DEFAULT 'dataforseo',
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PresencePost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "accountId" TEXT,
    "platform" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'post',
    "postedAt" DATETIME,
    "url" TEXT,
    "caption" TEXT,
    "likeCount" INTEGER,
    "commentCount" INTEGER,
    "shareCount" INTEGER,
    "viewCount" INTEGER,
    "followerCount" INTEGER,
    "followingCount" INTEGER,
    "postCount" INTEGER,
    "actorId" TEXT,
    "raw" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PresencePost_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "PresenceAccount" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PresenceBrandVoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT '[]',
    "themes" TEXT NOT NULL DEFAULT '[]',
    "vocabulary" TEXT NOT NULL DEFAULT '[]',
    "callToActions" TEXT NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "postSample" INTEGER NOT NULL DEFAULT 0,
    "byPlatform" TEXT NOT NULL DEFAULT '[]',
    "extraction" TEXT NOT NULL DEFAULT 'insufficient-data',
    "llmModel" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "scope" TEXT NOT NULL DEFAULT '{}',
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "refreshaudit" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "deviceLabel" TEXT,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedvia" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ClientMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'client-collaborator',
    "projectIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "invitedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "removedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ConnectionDelegation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "granteeUserId" TEXT NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "accessLevel" TEXT NOT NULL DEFAULT 'read',
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OperatorAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "clientId" TEXT,
    "projectId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'contributor',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" DATETIME
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
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

-- CreateTable
CREATE TABLE "OnboardingRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "requestedOf" TEXT,
    "requestedBy" TEXT,
    "dueAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'open',
    "blockedWork" TEXT NOT NULL DEFAULT '[]',
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReportRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT,
    "snapshot" TEXT NOT NULL DEFAULT '{}',
    "manifestId" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" DATETIME,
    "decision" TEXT,
    "decisionNote" TEXT,
    "publishedBy" TEXT,
    "publishedAt" DATETIME,
    "withdrawnAt" DATETIME,
    "supersededBy" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReportShareLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "revisionId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "createdBy" TEXT,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "lastViewedAt" DATETIME,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ReportDeliveryAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "revisionId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "attemptedBy" TEXT,
    "attemptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Engagement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serviceTier" TEXT NOT NULL DEFAULT 'retainer',
    "status" TEXT NOT NULL DEFAULT 'active',
    "startsOn" DATETIME,
    "endsOn" DATETIME,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "deliveryLead" TEXT,
    "hoursPerCycle" REAL,
    "notes" TEXT,
    "pausedAt" DATETIME,
    "pauseReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Cycle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "engagementId" TEXT,
    "name" TEXT NOT NULL,
    "startsOn" DATETIME NOT NULL,
    "endsOn" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "goal" TEXT,
    "committedAt" DATETIME,
    "committedBy" TEXT,
    "committedCount" INTEGER NOT NULL DEFAULT 0,
    "scopeChanges" TEXT NOT NULL DEFAULT '[]',
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "cycleId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'fix',
    "discipline" TEXT NOT NULL DEFAULT 'technical',
    "status" TEXT NOT NULL DEFAULT 'backlog',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "assigneeId" TEXT,
    "reviewerId" TEXT,
    "dueAt" DATETIME,
    "estimateHours" REAL,
    "actualHours" REAL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "dependsOn" TEXT NOT NULL DEFAULT '[]',
    "blockedReason" TEXT,
    "blockedOn" TEXT,
    "clientVisible" BOOLEAN NOT NULL DEFAULT false,
    "internalNotes" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AcceptanceCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "checkedBy" TEXT,
    "checkedAt" DATETIME,
    "note" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "runId" TEXT,
    "runType" TEXT,
    "artifact" TEXT,
    "observedAt" DATETIME,
    "reviewerId" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'accepted',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "engagementId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "clientVisible" BOOLEAN NOT NULL DEFAULT true,
    "metAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CapacityAllocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "cycleId" TEXT,
    "projectId" TEXT,
    "startsOn" DATETIME NOT NULL,
    "endsOn" DATETIME NOT NULL,
    "availableHours" REAL NOT NULL DEFAULT 0,
    "allocatedHours" REAL NOT NULL DEFAULT 0,
    "absenceKind" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskKind" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "heartbeatAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "input" TEXT NOT NULL DEFAULT '{}',
    "artifacts" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "costCredits" REAL NOT NULL DEFAULT 0,
    "reversible" BOOLEAN NOT NULL DEFAULT true,
    "triggeredBy" TEXT,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "cadenceRuleId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "JobStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobRunId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "costUsd" REAL NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "CadenceRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskKind" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'off',
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 3,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "params" TEXT NOT NULL DEFAULT '{}',
    "prerequisites" TEXT NOT NULL DEFAULT '[]',
    "maxCostUsd" REAL,
    "lastRunAt" DATETIME,
    "lastJobRunId" TEXT,
    "lastStatus" TEXT,
    "lastError" TEXT,
    "nextRunAt" DATETIME,
    "pausedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AlertLifecycle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "alertId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" DATETIME,
    "assigneeId" TEXT,
    "workItemId" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "resolution" TEXT,
    "dedupeKey" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "clientId" TEXT,
    "projectId" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MessageReadCursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "lastReadAt" DATETIME NOT NULL,
    "lastReadMessageId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT,
    "projectId" TEXT,
    "contextType" TEXT NOT NULL,
    "contextId" TEXT,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'operator-only',
    "uploadedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ContentBrief" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "ContentRevision" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "GenerationJob" (
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
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GenerationItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "generationJobId" TEXT NOT NULL,
    "subject" TEXT,
    "topicId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "assetId" TEXT,
    "revisionId" TEXT,
    "error" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT true,
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT,
    "artifactType" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "artifactRevision" INTEGER,
    "revisionId" TEXT,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "reviewerType" TEXT NOT NULL DEFAULT 'client',
    "requiredReviewerId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "dueAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "invalidatedAt" DATETIME,
    "invalidatedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "approvalRequestId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decidedBy" TEXT NOT NULL,
    "decidedByType" TEXT NOT NULL,
    "decidedRevision" INTEGER,
    "supersededBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RevisionClaimLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "revisionType" TEXT NOT NULL DEFAULT 'content-revision',
    "claimId" TEXT NOT NULL,
    "excerpt" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CheckResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "checkKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "checkedBy" TEXT,
    "checkedVia" TEXT NOT NULL DEFAULT 'automated',
    "projectId" TEXT,
    "clientId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PublishDestination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceLabel" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "credentialRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'unconfigured',
    "lastTestedAt" DATETIME,
    "lastError" TEXT,
    "createdBy" TEXT,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Publication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "approvalId" TEXT,
    "mode" TEXT NOT NULL DEFAULT 'draft',
    "scheduledFor" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "remoteId" TEXT,
    "remoteUrl" TEXT,
    "verifiedAt" DATETIME,
    "verifiedUrl" TEXT,
    "verifyError" TEXT,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "publishedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BudgetPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "taskKind" TEXT,
    "limitUsd" REAL,
    "limitCredits" REAL,
    "period" TEXT NOT NULL DEFAULT 'month',
    "enforcement" TEXT NOT NULL DEFAULT 'hard',
    "perRunCapUsd" REAL,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SpendReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskKind" TEXT NOT NULL,
    "jobRunId" TEXT,
    "note" TEXT,
    "estimateLowUsd" REAL NOT NULL DEFAULT 0,
    "estimateHighUsd" REAL NOT NULL DEFAULT 0,
    "reservedUsd" REAL NOT NULL DEFAULT 0,
    "reservedCredits" REAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'held',
    "settledUsd" REAL,
    "settledCredits" REAL,
    "settledAt" DATETIME,
    "expiresAt" DATETIME,
    "requestedBy" TEXT,
    "approvedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SpendEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "clientId" TEXT,
    "taskKind" TEXT,
    "jobRunId" TEXT,
    "reservationId" TEXT,
    "provider" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'usd',
    "amount" REAL NOT NULL,
    "quantity" REAL,
    "quantityUnit" TEXT,
    "note" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MeasurementCohort" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "querySetId" TEXT,
    "querySetVersion" INTEGER,
    "engines" TEXT NOT NULL DEFAULT '[]',
    "markets" TEXT NOT NULL DEFAULT '[]',
    "transport" TEXT,
    "methodologyHash" TEXT,
    "baselineRunId" TEXT,
    "baselineAt" DATETIME,
    "breaks" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReportPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "startsOn" DATETIME NOT NULL,
    "endsOn" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "cohortId" TEXT,
    "baselinePeriodId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "EvidenceManifest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'report',
    "subjectId" TEXT,
    "periodId" TEXT,
    "cohortId" TEXT,
    "sources" TEXT NOT NULL DEFAULT '{}',
    "coverage" TEXT NOT NULL DEFAULT '{}',
    "sourceDates" TEXT NOT NULL DEFAULT '{}',
    "scoreRunId" TEXT,
    "rubricVersion" TEXT,
    "omissions" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" TEXT NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ActivityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "actorId" TEXT,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceVersion" TEXT,
    "clientId" TEXT,
    "projectId" TEXT,
    "summary" TEXT,
    "changes" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT NOT NULL DEFAULT 'success',
    "requestId" TEXT,
    "jobRunId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'api',
    "ipAddress" TEXT,
    "clientVisible" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "providerPriceId" TEXT,
    "amountCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "interval" TEXT NOT NULL DEFAULT 'monthly',
    "entitlements" TEXT NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "offerId" TEXT,
    "providerId" TEXT,
    "providerCustomerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "currentPeriodStart" DATETIME,
    "currentPeriodEnd" DATETIME,
    "cancelAt" DATETIME,
    "canceledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerEventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "eventType" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "clientId" TEXT,
    "subscriptionId" TEXT,
    "amountCents" INTEGER,
    "currency" TEXT,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "grantedByEventId" TEXT,
    "subscriptionId" TEXT,
    "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ExportRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'json',
    "sections" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "storageKey" TEXT,
    "sizeBytes" INTEGER,
    "expiresAt" DATETIME,
    "downloadedAt" DATETIME,
    "omittedNote" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RetentionPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceType" TEXT NOT NULL,
    "retainDays" INTEGER,
    "action" TEXT NOT NULL DEFAULT 'archive',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" DATETIME,
    "updatedBy" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OffboardingRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'preview',
    "planned" TEXT NOT NULL DEFAULT '{}',
    "executed" TEXT NOT NULL DEFAULT '{}',
    "shareLinkPolicy" TEXT NOT NULL DEFAULT 'revoke',
    "exportRequestId" TEXT,
    "requestedBy" TEXT NOT NULL,
    "confirmedBy" TEXT,
    "confirmedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CapabilityStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "configured" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastError" TEXT,
    "mockMode" BOOLEAN NOT NULL DEFAULT false,
    "supports" TEXT NOT NULL DEFAULT '[]',
    "prerequisites" TEXT NOT NULL DEFAULT '[]',
    "limits" TEXT NOT NULL DEFAULT '{}',
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OrganizationSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL DEFAULT 1,
    "displayName" TEXT NOT NULL DEFAULT 'Cailyx',
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "supportEmail" TEXT,
    "supportName" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "defaultTier" TEXT NOT NULL DEFAULT 'retainer',
    "reviewSlaHours" INTEGER NOT NULL DEFAULT 48,
    "allowPublicShare" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReportTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "reportType" TEXT NOT NULL DEFAULT 'monthly',
    "sections" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProgramTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'cycle',
    "description" TEXT,
    "items" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "TechnicalAudit_projectId_idx" ON "TechnicalAudit"("projectId");

-- CreateIndex
CREATE INDEX "TechnicalAudit_createdAt_idx" ON "TechnicalAudit"("createdAt");

-- CreateIndex
CREATE INDEX "TechnicalAudit_projectId_createdAt_idx" ON "TechnicalAudit"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditPage_auditId_idx" ON "AuditPage"("auditId");

-- CreateIndex
CREATE INDEX "AuditPage_url_idx" ON "AuditPage"("url");

-- CreateIndex
CREATE INDEX "AuditPage_score_idx" ON "AuditPage"("score");

-- CreateIndex
CREATE UNIQUE INDEX "AuditPage_auditId_url_key" ON "AuditPage"("auditId", "url");

-- CreateIndex
CREATE INDEX "AuditFinding_auditId_idx" ON "AuditFinding"("auditId");

-- CreateIndex
CREATE INDEX "AuditFinding_type_idx" ON "AuditFinding"("type");

-- CreateIndex
CREATE INDEX "AuditFinding_status_idx" ON "AuditFinding"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleConfig_projectId_key" ON "ScheduleConfig"("projectId");

-- CreateIndex
CREATE INDEX "ScheduleConfig_projectId_idx" ON "ScheduleConfig"("projectId");

-- CreateIndex
CREATE INDEX "ScheduleConfig_active_nextRunAt_idx" ON "ScheduleConfig"("active", "nextRunAt");

-- CreateIndex
CREATE INDEX "ScheduleConfig_seoActive_seoNextRunAt_idx" ON "ScheduleConfig"("seoActive", "seoNextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "PageMetadata_auditId_key" ON "PageMetadata"("auditId");

-- CreateIndex
CREATE INDEX "PageMetadata_auditId_idx" ON "PageMetadata"("auditId");

-- CreateIndex
CREATE INDEX "FetchLog_runId_idx" ON "FetchLog"("runId");

-- CreateIndex
CREATE INDEX "FetchLog_calledBy_idx" ON "FetchLog"("calledBy");

-- CreateIndex
CREATE INDEX "FetchLog_timestamp_idx" ON "FetchLog"("timestamp");

-- CreateIndex
CREATE INDEX "EntityAudit_projectId_idx" ON "EntityAudit"("projectId");

-- CreateIndex
CREATE INDEX "Entity_entityAuditId_idx" ON "Entity"("entityAuditId");

-- CreateIndex
CREATE INDEX "SchemaCheck_entityId_idx" ON "SchemaCheck"("entityId");

-- CreateIndex
CREATE INDEX "PlatformRecord_entityId_idx" ON "PlatformRecord"("entityId");

-- CreateIndex
CREATE INDEX "ModelDiff_entityId_idx" ON "ModelDiff"("entityId");

-- CreateIndex
CREATE INDEX "ModelDiff_provider_idx" ON "ModelDiff"("provider");

-- CreateIndex
CREATE INDEX "ModelDiff_status_idx" ON "ModelDiff"("status");

-- CreateIndex
CREATE UNIQUE INDEX "GapAnalysis_projectId_key" ON "GapAnalysis"("projectId");

-- CreateIndex
CREATE INDEX "GapAnalysis_projectId_idx" ON "GapAnalysis"("projectId");

-- CreateIndex
CREATE INDEX "Gap_gapAnalysisId_idx" ON "Gap"("gapAnalysisId");

-- CreateIndex
CREATE INDEX "Gap_dimension_idx" ON "Gap"("dimension");

-- CreateIndex
CREATE INDEX "Gap_action_idx" ON "Gap"("action");

-- CreateIndex
CREATE INDEX "Gap_category_idx" ON "Gap"("category");

-- CreateIndex
CREATE INDEX "Gap_status_idx" ON "Gap"("status");

-- CreateIndex
CREATE INDEX "Gap_priorityScore_idx" ON "Gap"("priorityScore");

-- CreateIndex
CREATE INDEX "Gap_quadrant_idx" ON "Gap"("quadrant");

-- CreateIndex
CREATE UNIQUE INDEX "Gap_sourceType_sourceId_key" ON "Gap"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionPlan_projectId_key" ON "ActionPlan"("projectId");

-- CreateIndex
CREATE INDEX "ActionPlan_projectId_idx" ON "ActionPlan"("projectId");

-- CreateIndex
CREATE INDEX "Recommendation_actionPlanId_idx" ON "Recommendation"("actionPlanId");

-- CreateIndex
CREATE INDEX "Recommendation_priorityRank_idx" ON "Recommendation"("priorityRank");

-- CreateIndex
CREATE UNIQUE INDEX "Recommendation_actionPlanId_category_key" ON "Recommendation"("actionPlanId", "category");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "Project_clientId_idx" ON "Project"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_domain_key" ON "Project"("domain");

-- CreateIndex
CREATE INDEX "Client_status_idx" ON "Client"("status");

-- CreateIndex
CREATE INDEX "ClientMessage_clientId_idx" ON "ClientMessage"("clientId");

-- CreateIndex
CREATE INDEX "ClientMessage_projectId_idx" ON "ClientMessage"("projectId");

-- CreateIndex
CREATE INDEX "AttributionResponse_projectId_idx" ON "AttributionResponse"("projectId");

-- CreateIndex
CREATE INDEX "AttributionResponse_source_idx" ON "AttributionResponse"("source");

-- CreateIndex
CREATE INDEX "AttributionResponse_createdAt_idx" ON "AttributionResponse"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Report_slug_key" ON "Report"("slug");

-- CreateIndex
CREATE INDEX "Report_projectId_idx" ON "Report"("projectId");

-- CreateIndex
CREATE INDEX "Report_slug_idx" ON "Report"("slug");

-- CreateIndex
CREATE INDEX "Report_visibility_idx" ON "Report"("visibility");

-- CreateIndex
CREATE INDEX "Report_projectId_status_idx" ON "Report"("projectId", "status");

-- CreateIndex
CREATE INDEX "QuerySet_projectId_idx" ON "QuerySet"("projectId");

-- CreateIndex
CREATE INDEX "QuerySet_status_idx" ON "QuerySet"("status");

-- CreateIndex
CREATE UNIQUE INDEX "QuerySet_projectId_version_persona_key" ON "QuerySet"("projectId", "version", "persona");

-- CreateIndex
CREATE INDEX "QuerySetItem_querySetId_idx" ON "QuerySetItem"("querySetId");

-- CreateIndex
CREATE INDEX "QuerySetItem_funnelStage_idx" ON "QuerySetItem"("funnelStage");

-- CreateIndex
CREATE INDEX "QuerySetItem_dimension_idx" ON "QuerySetItem"("dimension");

-- CreateIndex
CREATE INDEX "QuerySetItem_querySetId_dimension_idx" ON "QuerySetItem"("querySetId", "dimension");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_type_idx" ON "User"("type");

-- CreateIndex
CREATE INDEX "User_clientId_idx" ON "User"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE INDEX "GoogleConnection_userId_idx" ON "GoogleConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleConnection_userId_service_key" ON "GoogleConnection"("userId", "service");

-- CreateIndex
CREATE INDEX "GoogleProjectResource_connectionId_idx" ON "GoogleProjectResource"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleProjectResource_projectId_service_key" ON "GoogleProjectResource"("projectId", "service");

-- CreateIndex
CREATE INDEX "SeoAudit_projectId_idx" ON "SeoAudit"("projectId");

-- CreateIndex
CREATE INDEX "SeoAudit_projectId_createdAt_idx" ON "SeoAudit"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "SeoAudit_createdAt_idx" ON "SeoAudit"("createdAt");

-- CreateIndex
CREATE INDEX "SeoQuery_auditId_idx" ON "SeoQuery"("auditId");

-- CreateIndex
CREATE UNIQUE INDEX "SeoQuery_auditId_query_key" ON "SeoQuery"("auditId", "query");

-- CreateIndex
CREATE INDEX "SeoPage_auditId_idx" ON "SeoPage"("auditId");

-- CreateIndex
CREATE INDEX "SeoPage_url_idx" ON "SeoPage"("url");

-- CreateIndex
CREATE UNIQUE INDEX "SeoPage_auditId_url_key" ON "SeoPage"("auditId", "url");

-- CreateIndex
CREATE INDEX "SeoFinding_auditId_idx" ON "SeoFinding"("auditId");

-- CreateIndex
CREATE INDEX "SeoFinding_type_idx" ON "SeoFinding"("type");

-- CreateIndex
CREATE INDEX "SeoFinding_status_idx" ON "SeoFinding"("status");

-- CreateIndex
CREATE INDEX "MeasurementRun_projectId_idx" ON "MeasurementRun"("projectId");

-- CreateIndex
CREATE INDEX "MeasurementRun_querySetId_idx" ON "MeasurementRun"("querySetId");

-- CreateIndex
CREATE INDEX "MeasurementRun_status_idx" ON "MeasurementRun"("status");

-- CreateIndex
CREATE INDEX "Observation_runId_idx" ON "Observation"("runId");

-- CreateIndex
CREATE INDEX "Observation_itemId_idx" ON "Observation"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ScoreRubric_version_key" ON "ScoreRubric"("version");

-- CreateIndex
CREATE INDEX "ScoreRun_projectId_idx" ON "ScoreRun"("projectId");

-- CreateIndex
CREATE INDEX "ScoreRun_projectId_createdAt_idx" ON "ScoreRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Claim_projectId_idx" ON "Claim"("projectId");

-- CreateIndex
CREATE INDEX "Claim_status_idx" ON "Claim"("status");

-- CreateIndex
CREATE INDEX "Finding_projectId_idx" ON "Finding"("projectId");

-- CreateIndex
CREATE INDEX "CrawlerHit_projectId_idx" ON "CrawlerHit"("projectId");

-- CreateIndex
CREATE INDEX "CrawlerHit_projectId_hitAt_idx" ON "CrawlerHit"("projectId", "hitAt");

-- CreateIndex
CREATE INDEX "Alert_projectId_idx" ON "Alert"("projectId");

-- CreateIndex
CREATE INDEX "Alert_projectId_createdAt_idx" ON "Alert"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "PageAnalysis_projectId_idx" ON "PageAnalysis"("projectId");

-- CreateIndex
CREATE INDEX "PageAnalysis_projectId_structureScore_idx" ON "PageAnalysis"("projectId", "structureScore");

-- CreateIndex
CREATE INDEX "MentionCheck_targetId_idx" ON "MentionCheck"("targetId");

-- CreateIndex
CREATE INDEX "MentionCheck_targetId_checkedAt_idx" ON "MentionCheck"("targetId", "checkedAt");

-- CreateIndex
CREATE INDEX "MentionTarget_projectId_idx" ON "MentionTarget"("projectId");

-- CreateIndex
CREATE INDEX "MentionTarget_projectId_status_idx" ON "MentionTarget"("projectId", "status");

-- CreateIndex
CREATE INDEX "MentionCampaign_projectId_idx" ON "MentionCampaign"("projectId");

-- CreateIndex
CREATE INDEX "SleeperPage_projectId_idx" ON "SleeperPage"("projectId");

-- CreateIndex
CREATE INDEX "SleeperPage_projectId_status_idx" ON "SleeperPage"("projectId", "status");

-- CreateIndex
CREATE INDEX "DataAsset_projectId_idx" ON "DataAsset"("projectId");

-- CreateIndex
CREATE INDEX "GrowthAsset_projectId_idx" ON "GrowthAsset"("projectId");

-- CreateIndex
CREATE INDEX "GrowthAsset_projectId_assetType_idx" ON "GrowthAsset"("projectId", "assetType");

-- CreateIndex
CREATE INDEX "GrowthAsset_projectId_status_idx" ON "GrowthAsset"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScorecardRun_publicToken_key" ON "ScorecardRun"("publicToken");

-- CreateIndex
CREATE INDEX "ScorecardRun_projectId_idx" ON "ScorecardRun"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineMath_projectId_key" ON "PipelineMath"("projectId");

-- CreateIndex
CREATE INDEX "PipelineMath_projectId_idx" ON "PipelineMath"("projectId");

-- CreateIndex
CREATE INDEX "Lead_projectId_idx" ON "Lead"("projectId");

-- CreateIndex
CREATE INDEX "Lead_projectId_status_idx" ON "Lead"("projectId", "status");

-- CreateIndex
CREATE INDEX "Upgrade_projectId_idx" ON "Upgrade"("projectId");

-- CreateIndex
CREATE INDEX "Upgrade_projectId_status_idx" ON "Upgrade"("projectId", "status");

-- CreateIndex
CREATE INDEX "Persona_projectId_idx" ON "Persona"("projectId");

-- CreateIndex
CREATE INDEX "Persona_projectId_status_idx" ON "Persona"("projectId", "status");

-- CreateIndex
CREATE INDEX "Persona_role_idx" ON "Persona"("role");

-- CreateIndex
CREATE INDEX "Journey_projectId_idx" ON "Journey"("projectId");

-- CreateIndex
CREATE INDEX "Journey_projectId_status_idx" ON "Journey"("projectId", "status");

-- CreateIndex
CREATE INDEX "Journey_personaId_idx" ON "Journey"("personaId");

-- CreateIndex
CREATE INDEX "Journey_campaignId_idx" ON "Journey"("campaignId");

-- CreateIndex
CREATE INDEX "JourneyStep_journeyId_idx" ON "JourneyStep"("journeyId");

-- CreateIndex
CREATE INDEX "JourneyStep_journeyId_depth_idx" ON "JourneyStep"("journeyId", "depth");

-- CreateIndex
CREATE INDEX "JourneyStep_parentId_idx" ON "JourneyStep"("parentId");

-- CreateIndex
CREATE INDEX "JourneyCampaign_projectId_idx" ON "JourneyCampaign"("projectId");

-- CreateIndex
CREATE INDEX "JourneyCampaign_projectId_status_idx" ON "JourneyCampaign"("projectId", "status");

-- CreateIndex
CREATE INDEX "LinkGraph_projectId_idx" ON "LinkGraph"("projectId");

-- CreateIndex
CREATE INDEX "LinkGraph_projectId_status_idx" ON "LinkGraph"("projectId", "status");

-- CreateIndex
CREATE INDEX "LinkNode_graphId_idx" ON "LinkNode"("graphId");

-- CreateIndex
CREATE INDEX "LinkNode_graphId_isOrphan_idx" ON "LinkNode"("graphId", "isOrphan");

-- CreateIndex
CREATE UNIQUE INDEX "LinkNode_graphId_path_key" ON "LinkNode"("graphId", "path");

-- CreateIndex
CREATE INDEX "LinkEdge_graphId_idx" ON "LinkEdge"("graphId");

-- CreateIndex
CREATE INDEX "LinkEdge_graphId_toPath_idx" ON "LinkEdge"("graphId", "toPath");

-- CreateIndex
CREATE INDEX "LinkRecommendation_graphId_idx" ON "LinkRecommendation"("graphId");

-- CreateIndex
CREATE INDEX "LinkRecommendation_graphId_status_idx" ON "LinkRecommendation"("graphId", "status");

-- CreateIndex
CREATE INDEX "LinkRecommendation_graphId_priority_idx" ON "LinkRecommendation"("graphId", "priority");

-- CreateIndex
CREATE INDEX "CouncilSession_projectId_idx" ON "CouncilSession"("projectId");

-- CreateIndex
CREATE INDEX "CouncilSession_projectId_status_idx" ON "CouncilSession"("projectId", "status");

-- CreateIndex
CREATE INDEX "CouncilContribution_sessionId_idx" ON "CouncilContribution"("sessionId");

-- CreateIndex
CREATE INDEX "CouncilContribution_sessionId_round_idx" ON "CouncilContribution"("sessionId", "round");

-- CreateIndex
CREATE INDEX "CouncilRanking_sessionId_idx" ON "CouncilRanking"("sessionId");

-- CreateIndex
CREATE INDEX "CouncilRanking_sessionId_rank_idx" ON "CouncilRanking"("sessionId", "rank");

-- CreateIndex
CREATE INDEX "SerpTracker_projectId_idx" ON "SerpTracker"("projectId");

-- CreateIndex
CREATE INDEX "SerpTracker_projectId_status_idx" ON "SerpTracker"("projectId", "status");

-- CreateIndex
CREATE INDEX "SerpQuery_trackerId_idx" ON "SerpQuery"("trackerId");

-- CreateIndex
CREATE UNIQUE INDEX "SerpQuery_trackerId_keyword_key" ON "SerpQuery"("trackerId", "keyword");

-- CreateIndex
CREATE INDEX "SerpSnapshot_trackerId_idx" ON "SerpSnapshot"("trackerId");

-- CreateIndex
CREATE INDEX "SerpSnapshot_trackerId_capturedAt_idx" ON "SerpSnapshot"("trackerId", "capturedAt");

-- CreateIndex
CREATE INDEX "SerpResult_snapshotId_idx" ON "SerpResult"("snapshotId");

-- CreateIndex
CREATE INDEX "SerpResult_queryId_idx" ON "SerpResult"("queryId");

-- CreateIndex
CREATE INDEX "AuthorityScan_projectId_idx" ON "AuthorityScan"("projectId");

-- CreateIndex
CREATE INDEX "AuthorityScan_projectId_status_idx" ON "AuthorityScan"("projectId", "status");

-- CreateIndex
CREATE INDEX "AuthorityCandidate_scanId_idx" ON "AuthorityCandidate"("scanId");

-- CreateIndex
CREATE INDEX "AuthorityCandidate_scanId_status_idx" ON "AuthorityCandidate"("scanId", "status");

-- CreateIndex
CREATE INDEX "AuthorityCandidate_projectId_idx" ON "AuthorityCandidate"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorityCandidate_scanId_domain_key" ON "AuthorityCandidate"("scanId", "domain");

-- CreateIndex
CREATE INDEX "SiteContext_projectId_idx" ON "SiteContext"("projectId");

-- CreateIndex
CREATE INDEX "SiteContext_projectId_createdAt_idx" ON "SiteContext"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AeoAudit_projectId_idx" ON "AeoAudit"("projectId");

-- CreateIndex
CREATE INDEX "AeoAudit_status_idx" ON "AeoAudit"("status");

-- CreateIndex
CREATE INDEX "AeoAudit_runId_idx" ON "AeoAudit"("runId");

-- CreateIndex
CREATE INDEX "AeoSurfaceRun_auditId_idx" ON "AeoSurfaceRun"("auditId");

-- CreateIndex
CREATE INDEX "AeoSurfaceRun_runId_idx" ON "AeoSurfaceRun"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "AeoSurfaceRun_auditId_surface_market_key" ON "AeoSurfaceRun"("auditId", "surface", "market");

-- CreateIndex
CREATE INDEX "AeoStance_auditId_idx" ON "AeoStance"("auditId");

-- CreateIndex
CREATE INDEX "AeoStance_auditId_stance_idx" ON "AeoStance"("auditId", "stance");

-- CreateIndex
CREATE INDEX "AeoStance_auditId_surface_idx" ON "AeoStance"("auditId", "surface");

-- CreateIndex
CREATE UNIQUE INDEX "AeoStance_auditId_observationId_key" ON "AeoStance"("auditId", "observationId");

-- CreateIndex
CREATE INDEX "PresenceAccount_projectId_idx" ON "PresenceAccount"("projectId");

-- CreateIndex
CREATE INDEX "PresenceAccount_projectId_platform_idx" ON "PresenceAccount"("projectId", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "PresenceAccount_projectId_platform_url_key" ON "PresenceAccount"("projectId", "platform", "url");

-- CreateIndex
CREATE INDEX "PresenceDiscovery_projectId_startedAt_idx" ON "PresenceDiscovery"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "TechStackScan_projectId_idx" ON "TechStackScan"("projectId");

-- CreateIndex
CREATE INDEX "TechStackScan_projectId_domain_createdAt_idx" ON "TechStackScan"("projectId", "domain", "createdAt");

-- CreateIndex
CREATE INDEX "TechFinding_scanId_idx" ON "TechFinding"("scanId");

-- CreateIndex
CREATE INDEX "TechFinding_scanId_category_idx" ON "TechFinding"("scanId", "category");

-- CreateIndex
CREATE INDEX "KeywordSet_projectId_idx" ON "KeywordSet"("projectId");

-- CreateIndex
CREATE INDEX "KeywordSet_projectId_createdAt_idx" ON "KeywordSet"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Keyword_setId_idx" ON "Keyword"("setId");

-- CreateIndex
CREATE INDEX "Keyword_setId_searchVolume_idx" ON "Keyword"("setId", "searchVolume");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_setId_keyword_key" ON "Keyword"("setId", "keyword");

-- CreateIndex
CREATE INDEX "BacklinksSummary_projectId_idx" ON "BacklinksSummary"("projectId");

-- CreateIndex
CREATE INDEX "BacklinksSummary_projectId_createdAt_idx" ON "BacklinksSummary"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "Competitor_projectId_idx" ON "Competitor"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Competitor_projectId_name_key" ON "Competitor"("projectId", "name");

-- CreateIndex
CREATE INDEX "CompetitorProfile_competitorId_idx" ON "CompetitorProfile"("competitorId");

-- CreateIndex
CREATE INDEX "CompetitorProfile_competitorId_createdAt_idx" ON "CompetitorProfile"("competitorId", "createdAt");

-- CreateIndex
CREATE INDEX "PresenceProfile_projectId_idx" ON "PresenceProfile"("projectId");

-- CreateIndex
CREATE INDEX "PresenceProfile_projectId_source_fetchedAt_idx" ON "PresenceProfile"("projectId", "source", "fetchedAt");

-- CreateIndex
CREATE INDEX "PresenceReview_projectId_idx" ON "PresenceReview"("projectId");

-- CreateIndex
CREATE INDEX "PresenceReview_projectId_platform_fetchedAt_idx" ON "PresenceReview"("projectId", "platform", "fetchedAt");

-- CreateIndex
CREATE INDEX "PresencePost_projectId_idx" ON "PresencePost"("projectId");

-- CreateIndex
CREATE INDEX "PresencePost_projectId_platform_fetchedAt_idx" ON "PresencePost"("projectId", "platform", "fetchedAt");

-- CreateIndex
CREATE INDEX "PresencePost_accountId_idx" ON "PresencePost"("accountId");

-- CreateIndex
CREATE INDEX "PresenceBrandVoice_projectId_idx" ON "PresenceBrandVoice"("projectId");

-- CreateIndex
CREATE INDEX "PresenceBrandVoice_projectId_createdAt_idx" ON "PresenceBrandVoice"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_idx" ON "AuthToken"("userId");

-- CreateIndex
CREATE INDEX "AuthToken_email_idx" ON "AuthToken"("email");

-- CreateIndex
CREATE INDEX "AuthToken_purpose_expiresAt_idx" ON "AuthToken"("purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "ClientMember_userId_idx" ON "ClientMember"("userId");

-- CreateIndex
CREATE INDEX "ClientMember_clientId_status_idx" ON "ClientMember"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMember_clientId_userId_key" ON "ClientMember"("clientId", "userId");

-- CreateIndex
CREATE INDEX "ConnectionDelegation_projectId_idx" ON "ConnectionDelegation"("projectId");

-- CreateIndex
CREATE INDEX "ConnectionDelegation_granteeUserId_idx" ON "ConnectionDelegation"("granteeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectionDelegation_connectionId_granteeUserId_projectId_key" ON "ConnectionDelegation"("connectionId", "granteeUserId", "projectId");

-- CreateIndex
CREATE INDEX "OperatorAssignment_userId_removedAt_idx" ON "OperatorAssignment"("userId", "removedAt");

-- CreateIndex
CREATE INDEX "OperatorAssignment_clientId_idx" ON "OperatorAssignment"("clientId");

-- CreateIndex
CREATE INDEX "OperatorAssignment_projectId_idx" ON "OperatorAssignment"("projectId");

-- CreateIndex
CREATE INDEX "BusinessProfile_projectId_idx" ON "BusinessProfile"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_projectId_version_key" ON "BusinessProfile"("projectId", "version");

-- CreateIndex
CREATE INDEX "OnboardingRequest_projectId_status_idx" ON "OnboardingRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "ReportRevision_reportId_status_idx" ON "ReportRevision"("reportId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReportRevision_reportId_revision_key" ON "ReportRevision"("reportId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ReportShareLink_tokenHash_key" ON "ReportShareLink"("tokenHash");

-- CreateIndex
CREATE INDEX "ReportShareLink_reportId_idx" ON "ReportShareLink"("reportId");

-- CreateIndex
CREATE INDEX "ReportDeliveryAttempt_reportId_idx" ON "ReportDeliveryAttempt"("reportId");

-- CreateIndex
CREATE INDEX "Engagement_clientId_status_idx" ON "Engagement"("clientId", "status");

-- CreateIndex
CREATE INDEX "Cycle_projectId_status_idx" ON "Cycle"("projectId", "status");

-- CreateIndex
CREATE INDEX "Cycle_engagementId_idx" ON "Cycle"("engagementId");

-- CreateIndex
CREATE INDEX "WorkItem_projectId_status_idx" ON "WorkItem"("projectId", "status");

-- CreateIndex
CREATE INDEX "WorkItem_cycleId_idx" ON "WorkItem"("cycleId");

-- CreateIndex
CREATE INDEX "WorkItem_assigneeId_status_idx" ON "WorkItem"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "AcceptanceCheck_workItemId_idx" ON "AcceptanceCheck"("workItemId");

-- CreateIndex
CREATE INDEX "Verification_workItemId_idx" ON "Verification"("workItemId");

-- CreateIndex
CREATE INDEX "Milestone_projectId_status_idx" ON "Milestone"("projectId", "status");

-- CreateIndex
CREATE INDEX "CapacityAllocation_userId_startsOn_idx" ON "CapacityAllocation"("userId", "startsOn");

-- CreateIndex
CREATE INDEX "CapacityAllocation_cycleId_idx" ON "CapacityAllocation"("cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_idempotencyKey_key" ON "JobRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "JobRun_projectId_taskKind_status_idx" ON "JobRun"("projectId", "taskKind", "status");

-- CreateIndex
CREATE INDEX "JobRun_status_heartbeatAt_idx" ON "JobRun"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "JobStep_jobRunId_idx" ON "JobStep"("jobRunId");

-- CreateIndex
CREATE INDEX "CadenceRule_enabled_nextRunAt_idx" ON "CadenceRule"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "CadenceRule_projectId_taskKind_key" ON "CadenceRule"("projectId", "taskKind");

-- CreateIndex
CREATE UNIQUE INDEX "AlertLifecycle_alertId_key" ON "AlertLifecycle"("alertId");

-- CreateIndex
CREATE INDEX "AlertLifecycle_status_idx" ON "AlertLifecycle"("status");

-- CreateIndex
CREATE INDEX "AlertLifecycle_dedupeKey_idx" ON "AlertLifecycle"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_kind_key" ON "NotificationPreference"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "MessageReadCursor_userId_clientId_key" ON "MessageReadCursor"("userId", "clientId");

-- CreateIndex
CREATE INDEX "Attachment_contextType_contextId_idx" ON "Attachment"("contextType", "contextId");

-- CreateIndex
CREATE INDEX "Attachment_projectId_idx" ON "Attachment"("projectId");

-- CreateIndex
CREATE INDEX "ContentBrief_projectId_status_idx" ON "ContentBrief"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ContentBrief_projectId_version_title_key" ON "ContentBrief"("projectId", "version", "title");

-- CreateIndex
CREATE INDEX "ContentRevision_assetId_idx" ON "ContentRevision"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentRevision_assetId_revision_key" ON "ContentRevision"("assetId", "revision");

-- CreateIndex
CREATE INDEX "GenerationJob_projectId_status_idx" ON "GenerationJob"("projectId", "status");

-- CreateIndex
CREATE INDEX "GenerationItem_generationJobId_status_idx" ON "GenerationItem"("generationJobId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_projectId_status_idx" ON "ApprovalRequest"("projectId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_clientId_status_idx" ON "ApprovalRequest"("clientId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_artifactType_artifactId_idx" ON "ApprovalRequest"("artifactType", "artifactId");

-- CreateIndex
CREATE INDEX "ApprovalDecision_approvalRequestId_idx" ON "ApprovalDecision"("approvalRequestId");

-- CreateIndex
CREATE INDEX "RevisionClaimLink_claimId_idx" ON "RevisionClaimLink"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionClaimLink_revisionId_claimId_key" ON "RevisionClaimLink"("revisionId", "claimId");

-- CreateIndex
CREATE INDEX "CheckResult_subjectType_subjectId_idx" ON "CheckResult"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "CheckResult_projectId_idx" ON "CheckResult"("projectId");

-- CreateIndex
CREATE INDEX "CheckResult_clientId_idx" ON "CheckResult"("clientId");

-- CreateIndex
CREATE INDEX "PublishDestination_projectId_provider_idx" ON "PublishDestination"("projectId", "provider");

-- CreateIndex
CREATE INDEX "Publication_projectId_status_idx" ON "Publication"("projectId", "status");

-- CreateIndex
CREATE INDEX "Publication_assetId_idx" ON "Publication"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "BudgetPolicy_scopeType_scopeId_taskKind_period_key" ON "BudgetPolicy"("scopeType", "scopeId", "taskKind", "period");

-- CreateIndex
CREATE INDEX "SpendReservation_projectId_status_idx" ON "SpendReservation"("projectId", "status");

-- CreateIndex
CREATE INDEX "SpendEvent_projectId_occurredAt_idx" ON "SpendEvent"("projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "SpendEvent_provider_idx" ON "SpendEvent"("provider");

-- CreateIndex
CREATE INDEX "MeasurementCohort_projectId_idx" ON "MeasurementCohort"("projectId");

-- CreateIndex
CREATE INDEX "ReportPeriod_projectId_startsOn_idx" ON "ReportPeriod"("projectId", "startsOn");

-- CreateIndex
CREATE INDEX "EvidenceManifest_projectId_idx" ON "EvidenceManifest"("projectId");

-- CreateIndex
CREATE INDEX "EvidenceManifest_subjectType_subjectId_idx" ON "EvidenceManifest"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "SavedView_userId_surface_idx" ON "SavedView"("userId", "surface");

-- CreateIndex
CREATE INDEX "ActivityEvent_clientId_createdAt_idx" ON "ActivityEvent"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_projectId_createdAt_idx" ON "ActivityEvent"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ActivityEvent_resourceType_resourceId_idx" ON "ActivityEvent"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "ActivityEvent_actorId_createdAt_idx" ON "ActivityEvent"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_code_key" ON "Offer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerId_key" ON "Subscription"("providerId");

-- CreateIndex
CREATE INDEX "Subscription_clientId_status_idx" ON "Subscription"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentEvent_providerEventId_key" ON "PaymentEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "PaymentEvent_clientId_idx" ON "PaymentEvent"("clientId");

-- CreateIndex
CREATE INDEX "PaymentEvent_status_idx" ON "PaymentEvent"("status");

-- CreateIndex
CREATE INDEX "Entitlement_clientId_status_idx" ON "Entitlement"("clientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_clientId_key_key" ON "Entitlement"("clientId", "key");

-- CreateIndex
CREATE INDEX "ExportRequest_scopeType_scopeId_idx" ON "ExportRequest"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "RetentionPolicy_resourceType_key" ON "RetentionPolicy"("resourceType");

-- CreateIndex
CREATE INDEX "OffboardingRun_clientId_idx" ON "OffboardingRun"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityStatus_key_key" ON "CapabilityStatus"("key");

-- CreateIndex
CREATE INDEX "CapabilityStatus_category_idx" ON "CapabilityStatus"("category");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSettings_version_key" ON "OrganizationSettings"("version");

-- CreateIndex
CREATE INDEX "ReportTemplate_reportType_idx" ON "ReportTemplate"("reportType");

-- CreateIndex
CREATE INDEX "ProgramTemplate_kind_active_idx" ON "ProgramTemplate"("kind", "active");

