# `common/guards` — authentication, roles, and project/client scope

**Purpose.** The three access-control layers every request passes through:
who the caller is (`JwtAuthGuard`), whether their operator role may reach the
route (`RolesGuard`), and whether the specific client/project/child resource in
the URL belongs to them (`ScopeValidationService`).

This file is the **G03 adoption record**. `design_plan.md` Appendix A (G03)
audited the source and found handlers that read a nested id and acted on it
without ever checking it belongs to the `:projectId` in the same URL. The audit
findings are reproduced below with their current status, because the fix is
per-call-site: the service cannot wire itself in.

---

## Architecture

```
common/guards/
  jwt-auth.guard.ts            Verifies the bearer token. GLOBAL via APP_GUARD in
                               AuthModule; opt out per-route with @Public().
  roles.guard.ts               Operator role restriction. GLOBAL via APP_GUARD.
                               @Roles(...) on a route; `admin` always passes.
                               @ClientPortal() routes are operator-forbidden and
                               client-type-only.
  scope-validation.module.ts   @Global() module exporting ScopeValidationService.
  scope-validation.service.ts  The reusable ownership checks (see API below).
```

## How the scope guard is activated

`ScopeValidationModule` is `@Global()`, but **declaring a global module does not
instantiate it**. A module must import it once. That import lives in
`modules/auth/auth.module.ts`:

```ts
imports: [
  PassportModule,
  JwtModule.register({}),
  ScopeValidationModule, // G03 — activates the @Global() scope guard
],
```

AuthModule is used because it is the one module `AppModule` always loads, and
because the two global `APP_GUARD`s are registered there. With that single
import, `ScopeValidationService` is injectable anywhere **without** every module
adding it to its own `imports:` array.

> This was broken on first build: the module existed but nothing imported it, so
> the provider was inert. Any controller that injected it would have failed with
> `UnknownDependenciesException` at boot.

---

## API

| Method | Use it for |
|---|---|
| `assertProjectAccess(user, projectId)` | Top of any `:projectId` handler. Returns `{ id, clientId }`; throws 404 if absent, 403 if unassigned. Admin passes; a client user is confined to their own `clientId`. |
| `assertClientAccess(user, clientId)` | Top of any `:clientId` handler (seats, threads, client-wide lists). |
| `assertProjectBelongsToClient(projectId, clientId)` | Cross-checking a nested project against a parent client. |
| `assertOwnedByProject(row, projectId, label?)` | After fetching a child row **by its own id**: asserts `row.projectId === projectId`. Throws 404 (not 403) so a caller cannot distinguish "exists elsewhere" from "does not exist". |
| `assertJobBelongsToProject(jobData, projectId, label?)` | For a BullMQ `job.data` payload rather than a Prisma row. **Blocked — see below.** |
| `getAccessibleProjectIds(user)` | For list endpoints. `null` means unrestricted (admin) — callers must skip the filter entirely rather than passing `null` through Prisma's `in`. |

---

## G03 adoption status

### Must fix — genuinely unprotected

These fetch the child row by its own id and never compare it to the URL's
`:projectId`. A caller who knows or enumerates another project's id can act on it
through a URL scoped to a project they legitimately hold.

| # | File | Route → method | Problem |
|---|---|---|---|
| 1 | `modules/measurement/measurement.service.ts:143` | `POST /api/projects/:projectId/measurement/runs/:runId/execute` → `executeRun(runId)` | `findUnique({ where: { id: runId } })`. `projectId` is never passed in. **Mutating** — re-executes the run and deletes partial observations. |
| 2 | `modules/measurement/measurement.service.ts` (get-run path) | `GET /api/projects/:projectId/measurement/runs/:runId` | Same fetch-by-id-only shape; reads another project's run and every observation on it. |
| 3 | `modules/aeo-audit/aeo-audit.controller.ts:199` | `POST /api/projects/:projectId/aeo/audits/:auditId/resume` → `resume(auditId)` | Controller drops `projectId`; `resume()` does `aeoAudit.findUnique({ where: { id: auditId } })`. **Mutating and billable** — starts a paid multi-engine run. |
| 4 | `modules/aeo-audit/aeo-audit.controller.ts:245` | `GET /api/projects/:projectId/aeo/audits/:auditId` → `get(auditId)` | Same — fetches by id only and returns the full audit including `surfaceRuns`, stages and verdict. |
| 5 | `modules/aeo-audit/aeo-audit.controller.ts:253` | `GET /api/projects/:projectId/aeo/audits/:auditId/verdict` → `verdict(auditId)` → `buildVerdict(auditId)` | By-id-only read of another project's verdict (incl. `projectId`-scoped evidence gathering resolved from the foreign project). |
| 6 | `modules/aeo-audit/aeo-audit.controller.ts:215` | `POST /api/projects/:projectId/aeo/audits/:auditId/stance` → `judgeStance(projectId, auditId)` | **Subtle:** it *does* take `projectId`, but only to load the project row and its site context — it never asserts `audit.projectId === projectId`. It then runs a (paid) LLM stance pass over the foreign audit and writes the result back to it. |

Fix shape for all six: inject `ScopeValidationService`, call
`await scope.assertProjectAccess(user, projectId)` at the top of the handler,
then pass `projectId` down to the service and use
`assertOwnedByProject(audit, projectId, 'Audit')` — or
`findFirst({ where: { id, projectId } })` — instead of `findUnique({ id })`.
For #6 the assertion belongs immediately after the `findUnique` that loads
`audit`, before the project/context reads.

### Already safe — keep the pattern

Verified during this pass; listed so nobody "fixes" them into a weaker form.

| File | Method | Why it is safe |
|---|---|---|
| `modules/technical-audit/technical-audit.service.ts` | `getAudit` / `getComparison` | `findFirst({ where: { id, projectId } })`. This is the reference pattern. |
| `modules/seo-audit/seo-audit.service.ts:384` | `getAudit` | `findFirst({ where: { id: auditId, projectId } })`. |
| `modules/scorecard/scorecard.service.ts:125` | `GET :runId` | `findFirst({ where: { id: runId, projectId } })`. |
| `modules/gap-analysis/gap-analysis.service.ts:228` | `getGap(projectId, gapId)` | Fetches by id, then asserts `gap.gapAnalysis.projectId !== projectId`. |
| `modules/data-asset/data-asset.service.ts:78` | `assertAsset(projectId, assetId)` | Fetches by id, then asserts `asset.projectId !== projectId`. |
| `modules/digital-presence/presence.service.ts:294` | `getRun(projectId, runId)` | `findFirst({ where: { id: runId, projectId } })`. |
| `modules/reporting/reporting.service.ts:223` | `setVisibility(projectId, slug, ...)` | Fetches by slug, then asserts `record.projectId !== projectId`. |
| `modules/reporting/reporting.service.ts:205` | `getBySlug(slug, includePrivate)` | Slug is globally unique by design; a `private` report is 404 regardless of `includePrivate`. **See the public-surface note below.** |

### Blocked — needs another package

| Site | Blocker |
|---|---|
| `technical-audit` `GET run/jobs/:jobId`, `seo-audit` `GET run/jobs/:jobId` | `PipelineQueueService.getStatus(jobId)` (`modules/jobs/pipeline-queue.service.ts:120`) returns only `{ status, result?, error?, attemptsMade? }` — it never exposes `job.data.projectId`, so there is nothing to compare against the URL. `ScopeValidationService.assertJobBelongsToProject` is written and waiting for a `getStatus` variant that also returns the job's `projectId`. That is **G07** (durable jobs) work. |

### Public surfaces — deliberate, not a gap

Routes that resolve a slug or token are intentionally reachable without operator
project scope. They are safe only because the value itself is unguessable and
the row carries its own visibility gate. As they exist today:

| Route | Gate |
|---|---|
| `GET /api/projects/:projectId/reports/:slug/render` (`@Public`) | Report must be `visibility: 'public'`; a private report 404s. This is the actual public report link — there is **no** unauthenticated `GET .../reports/:slug/view`, which stays operator-authenticated. |
| `GET /api/projects/:projectId/scorecard/public/:publicToken` (`@Public`) | Hard-gated behind `SCORECARD_PUBLIC=1`; disabled by default. |
| `GET|POST /api/portal/reports/:slug`, `/api/portal/messages` (`@ClientPortal`) | Confined to the caller's own `clientId`, re-checked in the handler. |

Note that the two public routes still carry a `:projectId` that is compared
against the resolved row, so the slug/token and the project must agree. Any
change that makes a slug or token enumerable, or that returns data before the
`visibility` / `SCORECARD_PUBLIC` / expiry checks, re-opens them — the release
and expiry semantics are **G05**.

---

## Related

- Contract source: `design_plan.md` Appendix A (G03), §2.2 (permission matrix).
- Build spec: `docs/analysis/design-plan-implementation.md`.
- `@Public()` / `@Roles()` / `@ClientPortal()` live in
  `common/decorators/auth.decorators.ts`.
- Enforcement of the **intended** assigned-project policy (as opposed to the
  current "any operator unless role-restricted") is G03 + G02 seat work; hiding
  a control in the UI is never the access control.
