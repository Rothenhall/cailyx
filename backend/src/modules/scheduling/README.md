# Scheduling Module

> **Status:** ✅ Built
> **Type:** Infrastructure (shared — imported by feature modules that need recurring tasks)

## Purpose

Manages recurring audit jobs via BullMQ. Stores schedule config in PostgreSQL via PrismaService. Feature modules register their task handlers and the scheduling service manages execution.

## Architecture

```
scheduling/
├── scheduling.module.ts    # NestJS module — exports SchedulingService
└── scheduling.service.ts   # BullMQ queue + worker + DB-backed config
```

## Public API (NestJS service — injected via DI)

| Method | Signature | Description |
|---|---|---|
| `registerHandler()` | `registerHandler(taskName: string, handler: (projectId, targetUrl) => Promise<void>)` | Register a task handler (called by feature modules) |
| `setSchedule()` | `setSchedule(projectId, cadence, targetUrl, taskName?) → Promise<ScheduleConfig>` | Set up recurring audit (creates BullMQ repeatable job + DB record) |
| `getSchedule()` | `getSchedule(projectId) → Promise<ScheduleConfig>` | Get current schedule for a project |
| `removeSchedule()` | `removeSchedule(projectId, taskName?) → Promise<void>` | Remove recurring schedule for a project |

## Cadence Options

| Cadence | Cron Expression | Description |
|---|---|---|
| `weekly` | `0 0 * * 1` | Every Monday at 00:00 |
| `monthly` | `0 0 1 * *` | 1st of every month at 00:00 |
| `manual-only` | (none) | No automatic runs — manual trigger only |

## Dependencies

| Package | Purpose |
|---|---|
| `bullmq` | Job queue with repeatable/cron support |
| `ioredis` | Redis connection (same Redis as fetcher cache) |
| `PrismaService` | Schedule config persistence |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | Yes | `redis://localhost:6380` | Redis for BullMQ queue |

## Usage (in feature modules)

```typescript
import { SchedulingService } from '../scheduling/scheduling.service';

@Injectable()
export class TechnicalAuditService {
  constructor(
    private readonly scheduling: SchedulingService,
  ) {
    // Register handler for scheduled audits
    this.scheduling.registerHandler('technical-audit', async (projectId, targetUrl) => {
      await this.runAudit(targetUrl, projectId, 'scheduled');
    });
  }
}
```