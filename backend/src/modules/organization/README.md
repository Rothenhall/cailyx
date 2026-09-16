# Organization Module (G20 — organization, brand, templates and service configuration)

Purpose: make the branding and layout a released document was published under a
pinned, checkable fact, and make "no public share links right now" a policy the
server enforces rather than a checkbox the UI respects.

Screens: OP20 (organization settings), OP21 (templates).

Every route in this module is `@Roles('admin')`. RolesGuard already rejects
client-type users from any route not marked `@ClientPortal()`; the decorator is
what additionally stops a non-admin **operator** (a delivery lead, say) from
rewriting the branding on every client's documents.

## File tree

```
organization/
  organization.controller.ts   3 controller classes (settings+branding, report
                               templates, program templates)
  organization.service.ts      versioned settings, branding snapshots, the
                               release snapshot, the public-share gate,
                               template CRUD, template apply
  organization.types.ts        vocabularies, DTO shapes, the two versioning models
  organization.module.ts       registers all 3 controllers, exports the service
  lib/branding.util.ts         hex-colour validation + CSS custom property output
  dto/organization.dto.ts      settings, report templates, program templates
```

## Endpoints (17)

### Settings and branding — `/api/organization`

| Method | Path | Returns |
|---|---|---|
| GET | `/settings` | the settings version **in force**; `?version=N` reads one exact version |
| GET | `/settings/versions` | `{ versions, versionInForce }`, newest first |
| PUT | `/settings` | the **new** settings version (200) |
| GET | `/branding` | `BrandingSnapshot` — branding + the settings version it came from + `cssVariables` |
| GET | `/release-snapshot` | `ReleaseSnapshot` — `?reportType=` names the type |
| GET | `/policy/public-share` | `{ allowPublicShare, settingsVersion, persisted }` |

### Report templates — `/api/organization/report-templates`

| Method | Path | Returns |
|---|---|---|
| GET | `/` | `{ templates }`; `?reportType=` filters |
| GET | `/resolve` | `{ template \| null, reason }` — the template in force for `?reportType=` |
| GET | `/:id` | one template, its sections and its version |
| POST | `/` | 201 template (starts at version 1) |
| PATCH | `/:id` | 200 template; a content change bumps `version` |
| POST | `/:id/default` | 200 — makes it the default for its report type |

`/resolve` is declared **before** `/:id` on purpose: Express matches in
declaration order, so the literal path wins and cannot be shadowed.

### Program templates — `/api/organization/program-templates`

| Method | Path | Returns |
|---|---|---|
| GET | `/` | `{ templates }`; `?kind=` and `?active=` filter |
| GET | `/:id` | one template, its items and its version |
| POST | `/` | 201 template (starts at version 1) |
| PATCH | `/:id` | 200 template; a content change bumps `version` |
| POST | `/:id/apply` | `ApplyProgramTemplateResult` — **copies** rows into a project |

## How the non-negotiable semantics are implemented

### 1. Versioning, and the method that returns the version in force

Two versioning shapes, and the difference is deliberate:

- **`OrganizationSettings` is append-only.** Every write INSERTs a row at
  `max(version) + 1` (`@@unique([version])`); nothing is ever updated. "The
  version in force" is the highest version.
- **`ReportTemplate` / `ProgramTemplate` are mutated in place with a bumped
  `version` counter.** A released report carries its own *copy* of the template
  plus the version it copied, so the counter is what makes the pin checkable
  afterwards. `isDefault` / `active` only make sense on a mutable current row,
  which is why these are not append-only.

Exported for the reporting module to adopt:

| Method | What it gives a release |
|---|---|
| `getSettingsVersionInForce()` | the settings in force; `version: null` + `persisted: false` when no row has ever been written (running on the schema's declared defaults is a real state, not a missing row) |
| `getBrandingForRelease()` | `{ settingsVersion, branding, cssVariables }`. `branding` is shaped like reporting's own `BrandingConfig` (`orgName` / `logoUrl` / `palette.primary`) so adoption is a swap, not a mapping |
| `getReleaseSnapshot(reportType)` | everything a release must pin in one call: settings version, branding, policy, and the resolved template **with its version**. `templateUnavailableReason` is populated rather than a silent `null` |
| `resolveReportTemplate(reportType)` | the default template of a type, else the most recently updated one, else `null` |

`BrandingSnapshot.branding` has no `tagline` field:
`OrganizationSettings` has no column for one, and inventing a value here is
exactly the fabricated field this build is meant to avoid. Reporting currently
sources its tagline from `REPORT_BRAND_TAGLINE` and may keep doing so; the
optional field in its `BrandingConfig` stays valid.

After this, a later settings edit creates a **new version** and a later
template edit **bumps that template's version**, so neither can retroactively
change a document that recorded what it was published under.

### 2. A template edit never mutates an already-committed cycle

`POST /program-templates/:id/apply` **copies rows; it does not link them.**
There is no foreign key, no back-reference and no cascade from a template to
anything it produced — editing the template afterwards cannot reach a row it
already created.

For `kind: 'cycle'`, the copy goes through
`DeliveryPlanService.createWorkItem` rather than writing `WorkItem` rows
directly, so every G06 rule applies to the copy for free:

- a **closed** cycle is refused;
- an already-**committed** cycle demands `scopeChangeReason` (409 without it)
  and records the addition in `Cycle.scopeChanges` instead of silently moving
  the frozen denominator;
- `dependsOn` cycle checks, engagement-paused checks and timezone-resolved due
  dates all run.

Each copied work item is stamped `sourceType: 'program-template'` /
`sourceId: <template id>` — which is what `WorkItem.sourceType` is documented
for. **`OnboardingRequest` has no provenance column**, so an onboarding copy's
origin is recorded in the activity trail only; that is stated in
`notCarried`-adjacent notes and here rather than papered over.

`kind: 'onboarding'` copies `OnboardingRequest` rows (the only
onboarding-checklist table in the schema). Its item shape is work-item-shaped,
so `category`, `discipline` and `estimateHours` have nowhere to go — they are
returned in `notCarried` rather than dropped quietly.

`kind: 'offboarding'` has **no target table**. It returns `applied: false` with
`unavailableReason` — an explicit unavailable state (§3.5), not an empty
result and not an error.

A copy is **not** one transaction across rows. A per-item failure is reported in
`skipped` and sets `partial: true`, rather than being hidden by a rollback that
would also discard the rows that did copy. `dryRun: true` previews everything
without writing; on a dry run `created[].id` is `null`.

### 3. `allowPublicShare` is a real policy switch

Two entry points, for two different jobs:

- `isPublicShareAllowed()` — a boolean read, for display.
- **`assertPublicShareAllowed(scope, subject)`** — the gate. A module about to
  mint a public share link calls this first; it throws `ForbiddenException`
  naming what was refused *and* the settings version that disabled it, so an
  operator can find the switch. A boolean a caller can forget to branch on is
  not a gate.

Both are exported on `OrganizationService`.

### 4. Multi-agency tenancy is out of scope — and is not faked

**This module has no tenant boundary, and no `tenantId` was added.** The
current single-service client model has no Organization boundary: settings,
branding, report templates and program templates are **application-wide**, and
one agency's settings are every agency's settings.

`design_plan.md` G20 says this plainly — "If multi-agency tenancy is required,
introduce Organization boundaries and enforce them throughout; the current
single-service client model does not implement that" — and the acceptance
criterion is one-directional: *client* branding must never cross projects,
which is satisfied trivially because there is no per-client branding store to
cross from. `OrganizationSettings` is one row per version, not one row per
tenant.

What this means in practice, stated rather than implied:

- There is no `organizationId` on `Client`, `Project`, `Report` or anywhere
  else, and none was invented here.
- Two clients of the same install share one display name, one logo, one primary
  colour, one support identity and one set of report templates.
- Anything that would need isolation (per-tenant template libraries, per-tenant
  SLAs) is **unavailable**, not partially implemented. The interim the plan
  names — "current server branding plus fixed application design; no fake
  editable settings" — is exactly what this is: the settings are real and
  editable, they are just not per-tenant.
- Introducing tenancy later is a schema change on every model plus an
  enforcement pass, not a flag on this module.

### 5. `primaryColor` is validated as a hex colour

`lib/branding.util.ts` accepts `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, with
the leading `#` optional on input, and always emits a lowercase
`#`-prefixed literal. Named CSS colours (`rebeccapurple`), `rgb()`/`hsl()`
functions and `var(...)` are **refused** — the value ends up inside a
stylesheet, so accepting them would mean accepting arbitrary CSS in a field the
model documents as hex.

It is applied as a CSS custom property override: `getBrandingForRelease()`
returns `cssVariables: { '--brand-primary': '#0a7c1e' }`. Only properties that
actually have a value are returned — an override set to an empty string would
blank the token instead of leaving the application default in place.

The read path is lenient: a value stored before validation existed is reported
as `null` rather than shipped into a stylesheet.

## Dependencies

- `PrismaService` — global via `DatabaseModule`, injected, never imported.
- `ActivityService` (`ActivityModule`) — audit events for every settings write,
  template create/edit/default and template apply. An audit failure is logged
  and does not fail the business write.
- `DeliveryPlanService` (`DeliveryPlanModule`) — used **only** by
  `applyProgramTemplate` for `kind: 'cycle'`, so copied work items inherit
  G06's closed-cycle refusal and committed-cycle scope-change rule instead of
  this module re-implementing them.
- `isValidTimeZone` from `../jobs/lib/cadence-schedule.util` — the timezone
  check is `Intl.DateTimeFormat`-based and already existed in G07; reusing it
  beats a fourth copy (`delivery-plan/lib/timezone.util.ts` and
  `budgets/lib/period.util.ts` each carry their own variant).

## Env vars

None introduced. `REPORT_BRAND_NAME` / `REPORT_BRAND_TAGLINE` belong to the
reporting module and are **not** read here: this module is the versioned store,
and reporting is the consumer that adopts it.

## PRD alignment (design_plan.md Appendix A, G20)

| Requirement | Status |
|---|---|
| Admin-only settings/branding/templates APIs for logo/colors/display name | ✅ `GET/PUT /settings`, `GET /branding`, `GET /settings/versions`, every route `@Roles('admin')` |
| Support identity | ✅ `supportEmail` / `supportName` on settings, with `null` to clear |
| Timezone | ✅ validated against `Intl`, not a hard-coded list; also surfaced in `ReleaseSnapshot.policy` |
| Service defaults | ✅ `defaultTier` (validated against G06's `SERVICE_TIERS`) and `reviewSlaHours` (1–720) |
| Report templates | ✅ full CRUD + `resolve` + `default`, sections ordered and key-uniqueness enforced |
| Review SLAs | ✅ `reviewSlaHours` stored and pinned into the release snapshot. ⚠ Nothing in this build *enforces* the SLA (no escalation job reads it); it is a configured value with a defined meaning, not a running timer. |
| Allowed sharing | ✅ `allowPublicShare` + the exported `assertPublicShareAllowed` gate |
| Persist versions | ✅ settings append-only with `@@unique([version])`; templates carry a `version` counter bumped on content change |
| Snapshot branding/template identity into released reports | ⚠ **prepared, not wired.** `getReleaseSnapshot()` returns exactly what a release must pin and is exported for reporting to adopt. The reporting module still writes its own local `defaultBranding` (from env) into `Report.branding` and does not yet call this, because `reporting/**` is another agent's lane. Adoption is a one-line call at release time; until then a delivered document does **not** pin settings or template identity. |
| Client branding never crosses projects | ✅ trivially — there is no per-client branding store. See "Tenancy" above for why that is a limitation as well as a guarantee. |
| Historical reports retain chosen brand/version | ⚠ follows from the previous row: a report that does not pin a version cannot be shown to retain one. The snapshot exists to make that possible; the pin is not yet taken. |
| Template changes do not mutate committed cycles | ✅ copies, never links; `cycle` copies route through `DeliveryPlanService.createWorkItem` so the committed-cycle scope-change rule applies |
| If multi-agency tenancy is required, introduce Organization boundaries | ⚠ **out of scope**, stated plainly: no `tenantId`, no boundary, application-wide settings. See "Tenancy". |
| Interim: current server branding plus fixed application design; no fake editable settings | ✅ the settings are real and editable; they are simply not per-tenant, and that is documented rather than disguised |

## Cross-module finding: `resolveDueAt` is off by ~999 ms

Not this module's file, reported rather than patched
(`backend/src/modules/delivery-plan/lib/timezone.util.ts`):

```
resolveDueAt('2026-09-03', 'UTC')          -> 2026-09-04T00:00:00.998Z   (expected …09-03T23:59:59.999Z)
resolveDueAt('2026-09-03', 'Europe/Dublin') -> 2026-09-03T23:00:00.998Z  (expected …23:59:59.999+00:00)
resolveDueAt('2026-09-03', 'Asia/Tokyo')    -> 2026-09-03T15:00:00.998Z  (expected …14:59:59.999Z)
```

`offsetMinutesAt` formats the instant with second precision, so the whole
`.999` sub-second part is lost and shows up as a `-999 ms` "offset" that is not
a whole minute. Every bare-date due date drifts 999 ms past end-of-day, which
lands it on the **next calendar day** for UTC. It is reachable from any caller
that passes a bare `dueOn`, including `applyProgramTemplate` — the copied work
item's `dueAt` came back `2026-09-04T00:00:00.998Z` for `startOn=2026-09-01,
offsetDays=2`. Only whole-minute offsets are computed correctly today by
accident of truncation.

## What was verified, and what was not

- `npx tsc --noEmit` on `backend/` → **0 errors**; `npx nest build` → succeeds.
- **90/90 smoke assertions pass** across G04+G20, run against a booted server
  (`PORT=3099 SCHEDULING_BACKEND=bullmq CADENCE_TICK_MS=0 node dist/main`, so
  the hourly audit schedulers and the cadence ticker stood down and a second
  instance could not trigger work). Script: `/tmp/g04-g20.smoke.sh`, sourcing
  the repo's own `smoke/_common.sh`. Directly exercised:
  - a settings write inserts a new version and the previous version still
    reads its original values afterwards; `#0A7C1E` normalizes to `#0a7c1e`
    and reaches `cssVariables['--brand-primary']`;
  - `primaryColor: "red"` → 400, `timezone: "Mars/Olympus"` → 400;
  - a content edit bumps a template's version, a no-op save does not;
    duplicate section keys → 409;
  - `resolve` for a type with no template returns `{template: null, reason}`,
    not a 404;
  - `getReleaseSnapshot` pins both the settings version and the template's
    version;
  - `apply` on an `offboarding` template returns `applied: false` **with** the
    reason; `dryRun` copies nothing (`created[].id` is null);
  - a copied work item carries `sourceType: 'program-template'`; **editing the
    template afterwards does not change it**; applying to a committed cycle
    without `scopeChangeReason` is refused per item, and succeeds with one;
  - a client login gets 403 from `/api/organization/settings`.
- **Not covered:** `assertPublicShareAllowed` has no HTTP caller by design, so
  it is verified by compilation and inspection only — no test toggles
  `allowPublicShare: false` and asserts the refusal.
- **Not implemented:** the reporting module does not yet call
  `getReleaseSnapshot()`, so no released document currently pins a settings or
  template version. See the alignment table above.
