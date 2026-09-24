/**
 * Root application module.
 * Imports all feature modules and shared configuration.
 *
 * @module AppModule
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { HealthModule } from './modules/health/health.module';
import { DatabaseModule } from './modules/database/database.module';
import { LlmModule } from './common/llm/llm.module';
import { FetcherModule } from './modules/fetcher/fetcher.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { TechnicalAuditModule } from './modules/technical-audit/technical-audit.module';
import { EntityAuditModule } from './modules/entity-audit/entity-audit.module';
import { GapAnalysisModule } from './modules/gap-analysis/gap-analysis.module';
import { StrategyModule } from './modules/strategy/strategy.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { IntakeModule } from './modules/intake/intake.module';
import { QuerySetModule } from './modules/query-set/query-set.module';
import { AuthModule } from './modules/auth/auth.module';
import { MeasurementModule } from './modules/measurement/measurement.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { FindingsModule } from './modules/findings/findings.module';
import { AttributionModule } from './modules/attribution/attribution.module';
import { CrawlerMonitorModule } from './modules/crawler-monitor/crawler-monitor.module';
import { MonitoringModule } from './modules/monitoring/monitoring.module';
import { RefreshCadenceModule } from './modules/refresh-cadence/refresh-cadence.module';
import { PageAnalysisModule } from './modules/page-analysis/page-analysis.module';
import { MentionTrackingModule } from './modules/mention-tracking/mention-tracking.module';
import { SleeperRefreshModule } from './modules/sleeper-refresh/sleeper-refresh.module';
import { DataAssetModule } from './modules/data-asset/data-asset.module';
import { PipelineMathModule } from './modules/pipeline-math/pipeline-math.module';
import { ScorecardModule } from './modules/scorecard/scorecard.module';
import { DeliveryModule } from './modules/delivery/delivery.module';
import { PersonaModule } from './modules/persona/persona.module';
import { JourneyModule } from './modules/journey/journey.module';
import { InternalLinkModule } from './modules/internal-link/internal-link.module';
import { CouncilModule } from './modules/council/council.module';
import { SerpIntelligenceModule } from './modules/serp-intelligence/serp-intelligence.module';
import { AuthorityModule } from './modules/authority/authority.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { GoogleModule } from './modules/google/google.module';
import { WebsiteModule } from './modules/website/website.module';
import { SeoAuditModule } from './modules/seo-audit/seo-audit.module';
import { AeoAuditModule } from './modules/aeo-audit/aeo-audit.module';
import { DigitalPresenceModule } from './modules/digital-presence/digital-presence.module';
import { TechStackModule } from './modules/tech-stack/tech-stack.module';
import { KeywordResearchModule } from './modules/keyword-research/keyword-research.module';
import { CompetitorsModule } from './modules/competitors/competitors.module';
import { GrowthExecutionModule } from './modules/growth-execution/growth-execution.module';
import { OpportunitiesModule } from './modules/opportunities/opportunities.module';
import { ClientsModule } from './modules/clients/clients.module';
import { ClientPortalModule } from './modules/client-portal/client-portal.module';
import { BacklinksModule } from './modules/backlinks/backlinks.module';
import { AgentsModule } from './modules/agents/agents.module';
import { UsersModule } from './modules/users/users.module';

// design_plan.md Appendix A — G01..G20 work packages.
// See docs/analysis/design-plan-implementation.md for the package map.
import { ClientAccessModule } from './modules/client-access/client-access.module';
import { BusinessProfileModule } from './modules/business-profile/business-profile.module';
import { DeliveryPlanModule } from './modules/delivery-plan/delivery-plan.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ContentModule } from './modules/content/content.module';
import { ContentWorkspaceModule } from './modules/content-workspace/content-workspace.module';
import { PromptRequestsModule } from './modules/prompt-requests/prompt-requests.module';
import { ContentRequestsModule } from './modules/content-requests/content-requests.module';
import { WritingStyleModule } from './modules/writing-style/writing-style.module';
import { ContentGenerationModule } from './modules/content-generation/content-generation.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { PublishingModule } from './modules/publishing/publishing.module';
import { ContentCalendarModule } from './modules/content-calendar/content-calendar.module';
import { BudgetsModule } from './modules/budgets/budgets.module';
import { ResultsModule } from './modules/results/results.module';
import { ProgressModule } from './modules/progress/progress.module';
import { OperationsModule } from './modules/operations/operations.module';
import { ActivityModule } from './modules/activity/activity.module';
import { BillingModule } from './modules/billing/billing.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import { CapabilitiesModule } from './modules/capabilities/capabilities.module';
import { OrganizationModule } from './modules/organization/organization.module';

@Module({
  imports: [
    // Global configuration module — loads .env variables. Every key the
    // backend needs lives in backend/.env; nothing is shared with frontend/
    // or client-portal/ via a monorepo-root .env (each app owns its own).
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // In-process cron. Drives recurring technical audits without Redis — see
    // technical-audit/audit-scheduler.service.ts for why that matters.
    ScheduleModule.forRoot(),

    // Global rate limiting — 100 requests per 60s per IP (default)
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),

    // Infrastructure modules (global)
    DatabaseModule,
    LlmModule,

    // Foundation — all outbound network requests go through this
    // Internal module — no REST endpoints, injected via DI
    FetcherModule,

    // Scheduling — recurring task management via BullMQ
    // Internal module — no REST endpoints, injected via DI
    SchedulingModule,

    // Pipeline job queue — runs technical/SEO/presence/AEO audits in the
    // background via BullMQ instead of inline on the HTTP request. Always
    // on (unlike SchedulingModule's cron/bullmq toggle): Redis is required.
    // Internal module — no REST endpoints, injected via DI
    JobsModule,

    // Feature modules
    HealthModule,
    TechnicalAuditModule,
    EntityAuditModule,
    GapAnalysisModule,
    StrategyModule,
    ReportingModule,
    ProjectsModule,
    IntakeModule,
    QuerySetModule,

    // Auth — registers global JwtAuthGuard + RolesGuard (APP_GUARD)
    AuthModule,

    // Measurement — AI-surface observation runs (the moat: n≥5, rates not positions)
    MeasurementModule,

    // Wave 2 — scoring rubric, claims discipline, findings copy
    ScoringModule,
    ClaimsModule,
    FindingsModule,

    // Wave 3 — AI-crawler log ingestion, health deltas + alerts
    CrawlerMonitorModule,
    AttributionModule,
    MonitoringModule,
    // C7 — automatic measurement+scoring refresh cadence, derived from plan tier
    RefreshCadenceModule,

    // Wave 4 — content & outreach tools (SOP-6/7/10/8)
    PageAnalysisModule,
    MentionTrackingModule,
    SleeperRefreshModule,
    DataAssetModule,

    // Wave 5 — sales & qualification (PLAN Phase 4)
    PipelineMathModule,
    ScorecardModule,
    DeliveryModule,

    // Swarm layer — synthetic-buyer research agents
    PersonaModule,
    JourneyModule,
    InternalLinkModule,
    CouncilModule,
    SerpIntelligenceModule,
    AuthorityModule,

    // Dashboard aggregation — connections + agents feed
    IntegrationsModule,

    // Google Search Console + Analytics (3-legged OAuth)
    GoogleModule,

    // Website (P12) — unified health/Google/visitors screen, joined page identity
    WebsiteModule,

    // SEO audit — Search Console data + fixes
    SeoAuditModule,

    // AEO audit — answer-engine visibility (ChatGPT first)
    AeoAuditModule,
    DigitalPresenceModule,

    // Wave 6 step 3 — technology-stack fingerprinting (headers/HTML/scripts,
    // no vendor). Runs against any domain, so competitor profiling reuses it.
    TechStackModule,

    // Wave 6 step 4 — keyword research (DataForSEO Keywords Data: volume,
    // competition/CPC, related/long-tail). Same vendor account as
    // serp-intelligence; pulled forward from stage 10 per decision D5.
    KeywordResearchModule,

    // Wave 6 step 6 — promotes Project.competitors (JSON) into first-class
    // rows, builds a light per-competitor profile (tech-stack + schema +
    // attached SERP/AEO presence), and produces the client-vs-competitor gap.
    CompetitorsModule,

    // Stage 11, "Marketing & Growth Execution" — the flowchart's last
    // previously-unbuilt stage before Final Output (stage 12, `reporting`).
    GrowthExecutionModule,
    OpportunitiesModule,

    // Lean admin/client-management layer (2026-09-13) — NOT the full
    // docs/analysis/client-portal.md plan. See clients/README.md.
    ClientsModule,
    ClientPortalModule,
    BacklinksModule,

    AgentsModule,

    // Operator administration (admin only)
    UsersModule,

    // ── design_plan.md Appendix A — G01..G20 ──────────────────────────
    // Identity (G01) and permission enforcement (G03) extend AuthModule /
    // UsersModule / common guards in place rather than adding a module.
    // Report lifecycle (G05) extends ReportingModule; durable jobs and
    // cadence (G07) extend JobsModule / MonitoringModule; contract repair
    // (G19) is spread across the existing modules it corrects.
    ClientAccessModule,      // G02
    BusinessProfileModule,   // G04
    DeliveryPlanModule,      // G06
    NotificationsModule,     // G08
    ContentModule,           // G09
    ContentWorkspaceModule,  // P08 — canonical content workspace on top of G09/G10/G11
    PromptRequestsModule,    // C4 — prompt add/delete request queue (client-portal.md §13/§20)
    ContentRequestsModule,   // C4 — structured "request new content" form (client-portal.md §14/§22)
    WritingStyleModule,      // P09 — versioned writing style profile (§13.8)
    ContentGenerationModule, // P09 — durable, resumable content generation (§13.7)
    ApprovalsModule,         // G10
    PublishingModule,        // G11
    ContentCalendarModule,   // P10 — the one content calendar (§6.4-§6.7)
    BudgetsModule,           // G12
    ResultsModule,           // G13
    ProgressModule,          // what moved across comparable AEO audits, and the work before it
    OperationsModule,        // G14
    ActivityModule,          // G15
    BillingModule,           // G16
    LifecycleModule,         // G17
    CapabilitiesModule,      // G18
    OrganizationModule,      // G20
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
