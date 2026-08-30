# Database Module

> **Status:** ✅ Built
> **Type:** Infrastructure (global — available to all modules)

## Purpose

Provides Prisma ORM access to PostgreSQL. All modules that need persistence inject `PrismaService`.

## Architecture

```
database/
├── database.module.ts    # Global NestJS module
└── prisma.service.ts     # PrismaClient wrapper with lifecycle management
```

## Database

- **Engine:** PostgreSQL 17 (Docker container `cailyx-postgres` on port 5436)
- **ORM:** Prisma v7
- **Schema:** `prisma/schema.prisma`

## Models

| Model | Purpose | Used by |
|---|---|---|
| `TechnicalAudit` | Audit run record (id, project, URL, trigger, timestamp) | technical-audit |
| `AuditFinding` | Individual finding within an audit (type, status, severity, detail, fix, repro commands) | technical-audit |
| `PageMetadata` | Captured page metadata (title, meta, headings, positioning copy) | technical-audit |
| `ScheduleConfig` | Per-project audit scheduling (cadence, next run, active) | technical-audit, scheduling |
| `FetchLog` | Fetcher operation log (observability — URL, UA, status, cost, timing) | fetcher, observability |

## Usage (in other modules)

```typescript
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class MyService {
  constructor(private readonly prisma: PrismaService) {}

  async createAudit(projectId: string, targetUrl: string) {
    return this.prisma.technicalAudit.create({
      data: { projectId, targetUrl },
    });
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection URL |

## Docker

PostgreSQL runs as a Docker container:
```bash
docker run -d --name cailyx-postgres --restart unless-stopped \
  -e POSTGRES_USER=cailyx -e POSTGRES_PASSWORD=cailyx_dev \
  -e POSTGRES_DB=cailyx -p 5436:5432 -v cailyx-pgdata:/var/lib/postgresql/data \
  postgres:17-alpine
```