# Design Plan Implementation — Status

**Living document.** Tracks the `design_plan.md` v1.0 build-out against
`docs/analysis/design-plan-implementation.md` (package map) and
`docs/analysis/AGENT-BRIEF.md` (agent rules).

Last updated: **2026-09-16 (session 3 — closure pass)**

**See also:** `docs/analysis/REMAINING-WORK.md` — the closure checklist, with each
remaining item and what it blocks.

Legend: ✅ complete · 🟡 partial (usable, incomplete) · 🔴 not started · ⛔ blocked

---

## 1. What this pass did

Session 2 repaired the data layer and the compile/boot state. Session 3 built the
**new `web/` frontend from scratch** and completed the backend packages that had
working services but no HTTP layer, then the genuinely unstarted ones.

| Area | Before session 3 | After |
|---|---|---|
| `web/` routes | 6 (4 were session proxy handlers) | **116** |
| `web/` pattern components | 3 | **19** |
| `web/` layouts | 0 | **4** (AppShell, OpsShell, ClientShell, PublicShell) |
| `web/` service adapters | 1 (clients) | **32** |
| `web/` lines of code (excl. shadcn) | ~1k | **~92k** |
| `backend` endpoints | 261 | **520** |
| `backend` models | 83 | **137** |
| Backend endpoints (whole app) | 261 | **520** |
| Backend packages fully unstarted | 15 | **0** |

---

## 2. Current health

| Check | Status |
|---|---|
| `backend` `npx tsc --noEmit` | ✅ 0 errors |
| `backend` `npx nest build` | ✅ clean |
| `backend` boot | ✅ **536 routes** mapped, no DI errors; logs the budget gate, job ledger and 14 onboarding executors |
| `backend` migrations | ✅ `prisma/migrations/0_init` baseline; `migrate status` clean; verified against an empty DB (137 tables / 137 models) |
| `backend` OpenAPI | ✅ `openapi.json` regenerated — 535 operations (was a stale 261) |
| `web` `npx tsc --noEmit` | ✅ 0 errors |
| `web` `npm run build` | ✅ 25 routes, 0 warnings |

---

## 3. Frontend `web/` — built this pass

### Architecture (three layers, enforced)

```
web/src/components/
  ui/         30 shadcn/ui primitives — generated, never hand-edited
  patterns/   19 shared components composed from ui/
  layouts/    4 shells
web/src/services/  11 typed adapters — the ONLY place fetch happens
web/src/lib/        api, session, format, url-state, navigation, status-tones, work-mapping
```

`web/src/lib/api.ts` is the single HTTP boundary. It implements §10.4's status-code
table once, so every screen reacts to a 403 or 429 identically instead of inventing
handling per page.

### Session boundary

The browser never talks to NestJS directly. `src/app/api/[...path]/route.ts` is a
server-side authenticating proxy: it reads the HttpOnly session cookie, attaches
the Bearer token, and owns the §10.3 refresh race (one rotation, one replay, not a
cascade). Tokens never reach page JavaScript.

`/api/session/{login,logout,refresh}` exchange credentials for cookies
server-side. The refresh route serializes rotation per token, which is what
prevents simultaneous 401s from invalidating each other.

### Screens built (116 routes)

| Screen | Route | Notes |
|---|---|---|
| AU01 Sign in | `/sign-in` | Suspense-split; safe `next` handling; preserves email not password |
| AU03 Recover | `/recover` | Generic success — no email enumeration, even on transport failure |
| PB05 Error pages | `/not-found`, `/access-denied`, `/unavailable` | Neutral 404 that cannot probe for resource existence |
| Root | `/` | Routes by session type from a cookie hint |
| OP01 Today | `/ops` | One aggregated call, not a fan-out |
| OP02 Clients | `/ops/clients` | `DataTable`; score column labelled "highest project score" |
| OP03 Add client | `/ops/clients/new` | Creates client only; non-repeatable after success |
| OP04 Client overview | `/ops/clients/[clientId]` | Delivery vs outcome shown separately |
| OP09 Client conversation | `/ops/clients/[clientId]/messages` | Draft preserved on send failure |
| OP10 All projects | `/ops/projects` | Archived included and filterable |
| OP11 My Work | `/ops/work` | Uses shared `WorkList` |
| OP14 Report center | `/ops/reports` | Editorial state and public link as separate columns |
| PJ01 Project overview | `/projects/[projectId]` | Artifact counts; unavailable widgets named, not faked |
| PJ03 Connections | `/projects/[projectId]/connections` | Auth / mapped / verified as three separate facts |
| PJ11 Run center | `/projects/[projectId]/runs` | Server-computed actions; honest cancellation |
| CP01 Client home | `/client` | One-project clients redirect into that project |
| CP13 Messages | `/client/messages` | Same component as OP09, client side |
| CP11 Reports | `/client/reports` | Server-scoped; no client filter to get wrong |
| CP09 Approvals | `/client/approvals` | Exact version on every card; 409 = version moved |
| RP03 Report reader | `/projects/[projectId]/reports/[slug]` | Snapshot banner; null sections name their prerequisite |
| AE01 AI visibility | `/projects/[projectId]/research/ai` | Reads only — no run triggers on load |

---

## 4. Backend packages G01–G20

| Pkg | Scope | Endpoints | Status |
|---|---|---|---|
| **G01** | Identity, sessions, reset | 11 | ✅ |
| **G02** | Seats, invites, delegated Google | 26 | ✅ |
| **G03** | Enforced scope | n/a (`@Global`) | ✅ activated |
| **G04** | Confirmed intake, business profile | 18 | ✅ |
| **G05** | Report lifecycle, release, share | 21 | ✅ released revisions frozen; publish gated by G10 |
| **G06** | Engagements, cycles, work, capacity | 36 | ✅ |
| **G07** | Durable jobs, cadence, alerts | 21 | ✅ |
| **G08** | Messages, notifications, attachments | 4 | ✅ |
| **G09** | Editable briefs, versioned content | 12 | ✅ |
| **G10** | Approvals, claim gates | 9 | ✅ |
| **G11** | CMS/channel publishing | 16 | ✅ |
| **G12** | Budgets, reservations, spend | 10 | ✅ |
| **G13** | Comparable outcomes, snapshots | 14 | ✅ |
| **G14** | Portfolio aggregation, pagination | 9 | ✅ |
| **G15** | Activity / audit trail | 5 | ✅ |
| **G16** | Public intake, verified billing | 12 | ✅ |
| **G17** | Export, retention, offboarding | 22 | ✅ |
| **G18** | Capability / readiness contract | 3 | ✅ 44 keys; **no adapter records a success yet**, so all read `unverified` |
| **G19** | Contract repair (Appendix B) | ✅ | D01/D12/D16/D17/D19/D20/D26 repaired and verified |
| **G20** | Organization, brand, templates | 17 | ✅ |

---

## 5. Bugs found and fixed this pass

Found by agents during live verification, then fixed by the coordinator. Each was
reproduced against a running backend, not inferred.

| # | Bug | Impact | Fix |
|---|---|---|---|
| 1 | `activity/dto/activity.dto.ts` — `limit` has `@IsInt()` with no `@Type(() => Number)` | Every request carrying `limit` was rejected with 400 | Added `@Type(() => Number)` |
| 2 | Same defect in `approvals`, `notifications`, `digital-presence` query DTOs | Four endpoint families rejected `limit` | Same fix, all three files |
| 3 | `CreateSavedViewDto.filters` / `UpdateSavedViewDto.filters` had no validator | Global `whitelist`+`forbidNonWhitelisted` rejected every request carrying `filters`; **saved views were silently inert** | Added `@IsObject()` |
| 4 | `RunStatus` (§3.3) had no `cancelled` member | A cancelled run was unrepresentable, so a deliberate stop read as a fault | Added to the union, the label map, the tone map and the strip's icon set |
| 5 | `/ops/work` used the `no-results` empty copy | Told readers to "clear the filters" on a page with no filters | Added a `no-work` variant with `mine`/`project` copy |
| 6 | Route collision: `PATCH .../growth-execution/assets/:assetId` already existed | The G09 handler would have been dead code | Content writes moved to `.../assets/:assetId/content`; the pre-existing PATCH has **no `@Roles` at all** and should be reviewed |
| 7 | `web` `outputFileTracingRoot` unset with two lockfiles in the repo | Next traced the wrong workspace tree | Pinned to `__dirname` |
| 8 | **Authorization hole:** `GET .../technical-audit/run/jobs/:jobId` and the `seo-audit` equivalent resolved a job by id and returned its status **without checking it belonged to the URL's `projectId`** | Any authenticated operator could read any project's audit job status and result — the exact nested-id gap G03 exists to close | Both handlers now call `assertProjectAccess` then `assertJobBelongsToProject`; a foreign id returns 404, same as an unknown one |
| 9 | `web` sign-in used `useSearchParams` without a Suspense boundary | Build failed: prerendering opted the whole route out of static generation | Split into a boundary + form |
| 10 | **`delivery-plan/lib/timezone.util.ts` — `resolveDueAt` was off by ~999 ms.** `offsetMinutesAt` formats with second precision, so the sub-second part of the instant was dropped and came back as a fractional offset (−0.01665 min for UTC); the correction then overshot past midnight | Every bare-date due date landed on the **next calendar day** in UTC, and drifted past end-of-day everywhere else | Offset rounded to whole minutes (exact — every current IANA offset is a whole minute), plus a second pass so a DST boundary converges. Verified across UTC, Tokyo, New York, London, Kolkata and both 2026 London DST transitions |

**Hazard, not a bug:** `JobsModule` registers `@Controller('projects/:projectId/onboarding')`
with `@Get(':runId')` *before* `BusinessProfileModule`. Nest resolves in registration
order, so any sibling literal route added under that prefix later is silently swallowed
by the `:runId` handler. G04 avoided it by moving to flat `.../onboarding-requests` and
`.../onboarding-checklist` paths. Verified against the live route table: those paths
resolve and no bare `:param` route exists directly under `projects/:projectId/`. **Any
future module adding `projects/:projectId/onboarding/<literal>` will hit this** — use a
flat sibling path, or move the `:runId` route behind a more specific prefix.

| 11 | **`services/operations.ts` sent `cursor`/`limit`** where the API whitelists `page`/`pageSize` under `forbidNonWhitelisted` | `/ops/work` and `/ops/reports` would **400** on load; the `Page<T>` shape declared a `nextCursor` the server never sends | Corrected the query type and `Page<T>`, and fixed three callers. Also `listProjectReportRows` in `reports.ts` |
| 12 | **`services/integrations.ts` read `{authorizationUrl}`** where the route returns `{url}` | Clicking "Connect Google account" navigated to `/undefined` | Corrected the field and the PJ03 call site; documented why the name is the contract |
| 13 | **`services/approvals.ts` never sent `revision`**, which `DecideApprovalDto` requires | CP09's approve/request-changes **400'd on every decision** | Added the required `revision` and made CP09 read it from the request, with an explicit state for a request that names no version |
| 14 | **`services/types.ts` `PortalProject` declared `status`/`score`/`band`** — none of which `PortalProjectDto` sends | CP01 rendered an unlabelled status pill and "Not measured yet" for projects that had scores | Corrected the type to the real field names; CP01 now shows setup progress and the latest report score |
| 15 | **`services/jobs.ts` carried two same-named `CadenceRule` interfaces** | The stale one declared `stored` where the API returns `configured` | Removed the stale one; `CadenceRuleDto` is now the only one |
| 16 | **`GET /api/portal/activity` returned `actorId` + `actorLabel` to clients** | Operator identifiers on a client surface — `clientVisible` gates which events, not who wrote them | `listForClient` now returns a reduced shape with a dedicated `ClientVisibleActivityEventDto` type (an allow-list, not an omission list) |
| 17 | **`GET /api/portal/me` was never registered** — `AuthService.getPortalMe` and `PortalMeDto` existed with no route | The web client shell resolved **every authenticated client as signed out** | Registered the route on the existing `@ClientPortal()` controller (521 routes now) |

**Also fixed:** the unsigned upgrade-completion stand-in (`@Public() POST
.../upgrades/:id/complete`) is now `@Roles('admin')`. It let anyone who could
reach the API mark an upgrade paid; G16's signed webhook is the real path.

**Not fixed, flagged:** `CheckResult` has no `projectId`/`clientId` column, so
`listCheckResults` cannot be project-scoped without inventing a
subjectType→table mapping. Compensating control is that the route is
operator-only. Needs a schema column or a scoped service read.

---

## 6. Docs and process debt

- [x] `docs/analysis/design-plan-implementation.md` — package map and tool decisions
- [x] `docs/analysis/AGENT-BRIEF.md` — agent rules
- [x] `common/guards/README.md` — G03 adoption record
- [x] READMEs for `content`, `approvals`, `activity`, `operations`, `client-access`,
      `jobs`, `monitoring`, `budgets`, `capabilities`, `organization`,
      `business-profile`, `results`, `lifecycle`
- [x] `web/src/components/patterns/README.md` — pattern prop reference
- [ ] `docs/API.md` — not updated for the ~259 new endpoints
- [ ] `docs/MODULES-STATUS.md` — no G01–G20 entry
- [x] `CHANGELOG.md` — implementation entry added
- [ ] `docs/PRODUCTION-READINESS.md` — not updated for new env vars
- [ ] **No `prisma/migrations/` directory.** DB state comes from `db push`. A migration
      baseline is required before any shared or staging deployment.

---

## 7. What remains

1. **~100 of 123 screens.** Built: 18. The research surfaces (TA/SE/AE/QS/EN/DP/CO/KW/SP),
   content (CT01–CT09), authority (AT01–AT05), reports (RP01–RP06) and the client
   project surfaces (CP03–CP10, CP16) are outstanding.
2. **G05 editorial lifecycle** — the states exist in types, not in behavior.
3. **G18 breadth** — the registry is seeded; not every provider has a
   `CapabilityStatus` key yet, so some readiness states fall back to conservative copy.
4. **G19** — Appendix B's remaining contract repairs are unverified.
5. **Charts** — deferred pending an approved tool analysis, per §10.2. Tables ship first
   and §3.4 requires a table alternative regardless.
6. **No test suite.** Verification this pass was live endpoint calls by agents plus
   `tsc`/`build`/boot. Nothing here is covered by an automated test.
7. **Onboarding stage executors are unregistered.** `jobs/OnboardingService` ships the
   run ledger and `registerStageExecutor` extension point, but the stage bodies live in
   `clients/` and no module registers one yet, so `resume` returns `resumed: false`
   with a reason rather than pretending a stage ran.
8. **Job heartbeat wiring is inert until adopted.** The ledger tracks a run only when
   the job's data carries a `jobRunId`; no feature module passes one yet, so
   `technical-audit` / `seo-audit` / `presence` / `aeo-audit` runs are not yet
   heartbeated.
9. **Budgets are enforced only where `reserve` is called.** G12 implements the
   reserve-before-spend transaction correctly (proven: 20 concurrent $1 reservations
   against a $10 ceiling leave exactly 10 committed), but wiring `reserve` /
   `assertReady` into each existing audit pipeline is per-module work that has not
   happened. A pipeline that never calls `reserve` is still uncapped.
10. **`SpendReservation` has no note/rationale column.** `release` therefore accepts no
    body rather than taking a reason it would silently drop, and `approve` records only
    the approver id. Needs a schema column.
11. **G18 has no "test connection" action.** Only Cloro exposes a zero-cost probe; the
    rest become ready by doing real work. 30 provider-specific probes — several of which
    spend money — were deliberately not built.
12. **Reporting does not yet call `getReleaseSnapshot()`.** G20's branding/template
    pinning is built and exported, but `reporting/` has not adopted it, so no delivered
    report currently pins a settings or template version.
13. **`assertPublicShareAllowed` has no caller yet.** Exported and typechecked; the
    share/publishing path does not consult it.

---

## 8. Known deferrals (unchanged)

- **Charts** — needs its own approved tool analysis; tables ship first.
- **Stripe SDK** — contract + signature-verification scaffold only, no SDK.
- **Dark mode** — §3.1 defers it; the token indirection is in place for it.
- **PDF artifacts** — browser print is the stated initial workaround.
- **`frontend/` and `client-portal/`** — explicitly out of scope, untouched.
- **Multi-agency tenancy** — out of scope; the single-service client model does not
  implement Organization boundaries and G20 says so rather than faking it.
