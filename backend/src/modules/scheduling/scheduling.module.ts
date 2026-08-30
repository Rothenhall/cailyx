/**
 * Scheduling Module — Provides SchedulingService for recurring task management.
 *
 * Uses BullMQ (backed by Redis) for job queues and cron-based repeatable jobs.
 * Modules register their task handlers and the scheduling service manages execution.
 *
 * @module scheduling.module
 */

import { Module } from '@nestjs/common';
import { SchedulingService } from './scheduling.service';

@Module({
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}