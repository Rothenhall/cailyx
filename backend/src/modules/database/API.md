# Database Module — API Reference

> **⚠️ Internal module — no REST endpoints exposed.**
>
> Provides `PrismaService` via dependency injection to all modules.

## Public Service Methods

`PrismaService` extends `PrismaClient`, so all Prisma model accessors are available:

| Model | Methods |
|---|---|
| `prisma.technicalAudit` | `create()`, `findMany()`, `findUnique()`, `update()`, `delete()` |
| `prisma.auditFinding` | `create()`, `createMany()`, `findMany()`, `findUnique()`, `delete()` |
| `prisma.pageMetadata` | `create()`, `findUnique()`, `delete()` |
| `prisma.scheduleConfig` | `create()`, `findUnique()`, `update()`, `upsert()`, `delete()` |
| `prisma.fetchLog` | `create()`, `createMany()`, `findMany()`, `delete()` |

## Lifecycle

- `onModuleInit()` — connects to database
- `onModuleDestroy()` — disconnects gracefully