/**
 * ContentCalendar Module — P10, the one content calendar.
 *
 * Contract source: platform_improvement_plan.md §6.4-§6.7, §20.2 (P10).
 *
 * `PrismaService` is available globally via `DatabaseModule`, and
 * `ScopeValidationService` is global via `ScopeValidationModule` (activated in
 * `AuthModule`) — neither is imported here. `PublishingService` is injected
 * from its own module, which is deliberate: this module owns no approval,
 * destination or publication rule of its own. A calendar that re-implemented
 * publishing's gates would be a second authority on whether something may be
 * sent, and the two would disagree.
 *
 * @module content-calendar.module
 */

import { Module } from '@nestjs/common';
import {
  ContentSchedulesController,
  PortfolioContentCalendarController,
  PortalContentCalendarController,
  ProjectContentCalendarController,
} from './content-calendar.controller';
import { ContentCalendarService } from './content-calendar.service';
import { PublishingModule } from '../publishing/publishing.module';

@Module({
  imports: [PublishingModule],
  controllers: [
    ProjectContentCalendarController,
    ContentSchedulesController,
    PortfolioContentCalendarController,
    PortalContentCalendarController,
  ],
  providers: [ContentCalendarService],
  exports: [ContentCalendarService],
})
export class ContentCalendarModule {}
