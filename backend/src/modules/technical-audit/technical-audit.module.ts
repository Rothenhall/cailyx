/**
 * Technical Audit Module — AI visibility access diagnostic.
 *
 * Detects the access, structure and performance problems that stop a site
 * being crawled, read and cited by AI assistants.
 *
 * Eight checks:
 *   1. robots.txt AI-bot blocks
 *   2. CDN AI-bot blocking probe (header-sniffing, inferred confidence)
 *   3. Sitemap presence + freshness
 *   4. JS render dependency (Playwright headless browser)
 *   5. Lighthouse / Core Web Vitals (Google PageSpeed Insights API)
 *   6. Schema / JSON-LD (homepage)
 *   7. Agent readiness (`npx is-agentic`)
 *   8. Page inventory — every sitemap URL: JSON-LD, title/meta length, H1
 *
 * Plus a composite score, a run-over-run diff, and an LLM narrative that
 * carries the previous run's commentary forward as context.
 *
 * Depends on: FetcherModule (all HTTP/browser/API calls go through it)
 *
 * @module technical-audit.module
 */

import { Module } from '@nestjs/common';
import { TechnicalAuditService } from './technical-audit.service';
import { TechnicalAuditController } from './technical-audit.controller';
import { SitemapCheckService } from './checks/sitemap.check';
import { AgentReadinessCheckService } from './checks/agent-readiness.check';
import { PageInventoryCheckService } from './checks/page-inventory.check';
import { AuditNarrativeService } from './checks/audit-narrative.service';
import { AuditSchedulerService } from './audit-scheduler.service';
import { FetcherModule } from '../fetcher/fetcher.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [FetcherModule, SchedulingModule, JobsModule],
  controllers: [TechnicalAuditController],
  providers: [
    TechnicalAuditService,
    SitemapCheckService,
    AgentReadinessCheckService,
    PageInventoryCheckService,
    AuditNarrativeService,
    AuditSchedulerService,
  ],
  exports: [TechnicalAuditService],
})
export class TechnicalAuditModule {}
