/**
 * Notifications Module — notification inbox, preferences, attachments and
 * message read state (G08).
 *
 * Contract source: design_plan.md Appendix A (G08).
 * Build spec: docs/analysis/design-plan-implementation.md
 *
 * PrismaService is available globally via DatabaseModule; no explicit import needed.
 *
 * Exports `NotificationsService` for other modules to call
 * `notifications.record({...})` — see README.md for the call signature.
 *
 * @module notifications.module
 */

import { Module } from '@nestjs/common';
import { NotificationsController, NotificationPreferencesController } from './notifications.controller';
import { AttachmentsController, PortalAttachmentsController } from './attachments.controller';
import { MessageThreadsController, PortalMessageThreadsController } from './message-threads.controller';
import { NotificationsService } from './notifications.service';
import { AttachmentsService } from './attachments.service';
import { MessageThreadsService } from './message-threads.service';

@Module({
  controllers: [
    NotificationsController,
    NotificationPreferencesController,
    AttachmentsController,
    PortalAttachmentsController,
    MessageThreadsController,
    PortalMessageThreadsController,
  ],
  providers: [NotificationsService, AttachmentsService, MessageThreadsService],
  exports: [NotificationsService, AttachmentsService, MessageThreadsService],
})
export class NotificationsModule {}
