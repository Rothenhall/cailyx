# Health Module

> **Status:** ✅ Built
> **Type:** Infrastructure (always present)

## Purpose

Provides a simple health-check endpoint to verify the API server is running and responsive.

## Architecture

```
health/
├── health.module.ts       # NestJS module
├── health.controller.ts   # GET /api/health endpoint
└── health.service.ts      # Health logic (uptime, timestamp)
```

## REST API

| Method | Endpoint | Auth | Rate Limit | Description |
|---|---|---|---|---|
| `GET` | `/api/health` | None | 100/60s (global) | Returns health status, uptime, and timestamp |

### `GET /api/health`

**Response (200):**
```json
{
  "status": "ok",
  "timestamp": "2026-08-28T13:40:07.000Z",
  "uptime": 4.749
}
```

## Dependencies

None — this module is self-contained.

## Consumers

- Used by Docker health checks
- Used by load balancers to verify service is up
- Used by monitoring to track uptime