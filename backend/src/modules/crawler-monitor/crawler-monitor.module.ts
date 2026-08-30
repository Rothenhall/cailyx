/**
 * Crawler Monitor Module — server-log ingestion + AI-crawler classification
 * (Wave 3, SOP-3/4.5). Unblocks the hallucinated-404 sweep downstream.
 *
 * Depends on: DatabaseModule
 *
 * @module crawler-monitor.module
 */

import { Module } from '@nestjs/common';
import { CrawlerMonitorService } from './crawler-monitor.service';
import { CrawlerMonitorController } from './crawler-monitor.controller';

@Module({
  controllers: [CrawlerMonitorController],
  providers: [CrawlerMonitorService],
  exports: [CrawlerMonitorService],
})
export class CrawlerMonitorModule {}