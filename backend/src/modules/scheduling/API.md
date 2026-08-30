# Scheduling Module — API Reference

> **⚠️ Internal module — no REST endpoints exposed.**
>
> Provides `SchedulingService` via dependency injection. Feature modules call its methods to manage recurring tasks.

## Public Service Methods

### registerHandler(taskName, handler)
Register a function to be called when a scheduled job runs.
```typescript
scheduling.registerHandler('technical-audit', async (projectId, targetUrl) => {
  await auditService.runAudit(targetUrl, projectId, 'scheduled');
});
```

### setSchedule(projectId, cadence, targetUrl, taskName?)
Create or update a recurring schedule. Stores in DB + creates BullMQ repeatable job.
```typescript
const result = await scheduling.setSchedule('proj_1', 'weekly', 'https://example.com');
// { cadence: 'weekly', nextRunAt: '2026-09-04T00:00:00.000Z', active: true }
```

### getSchedule(projectId)
Get the current schedule config for a project.
```typescript
const config = await scheduling.getSchedule('proj_1');
// { cadence: 'manual-only', nextRunAt: null, active: false }
```

### removeSchedule(projectId, taskName?)
Remove a recurring schedule and cancel pending jobs.
```typescript
await scheduling.removeSchedule('proj_1');
```