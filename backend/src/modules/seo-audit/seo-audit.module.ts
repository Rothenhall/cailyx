/**
 * SEO Audit Module — Search Console data, turned into fixes.
 *
 * The technical audit's sibling. Reads GSC (Search Analytics + URL Inspection
 * + Sitemaps) for a project's mapped property and attaches a concrete fix —
 * and where possible a paste-ready artifact or a Cailyx action — to every
 * issue and opportunity.
 *
 * Depends on GoogleModule (SearchConsoleService + GoogleConnectionService).
 *
 * @module seo-audit/seo-audit.module
 */

import { Module } from '@nestjs/common';
import { SeoAuditController } from './seo-audit.controller';
import { SeoAuditService } from './seo-audit.service';
import { SeoAuditSchedulerService } from './seo-audit-scheduler.service';
import { GoogleModule } from '../google/google.module';

@Module({
  imports: [GoogleModule],
  controllers: [SeoAuditController],
  providers: [SeoAuditService, SeoAuditSchedulerService],
  exports: [SeoAuditService],
})
export class SeoAuditModule {}
