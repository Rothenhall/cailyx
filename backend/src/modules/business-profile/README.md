# Business Profile Module (G04 — confirmed intake, project attachment and access checklist)

> **Phases:** G04 (`design_plan.md` Appendix A, §5.3) — plus **P02**
> (§9.1–§9.2, business information: confirmed / suggested / needs
> information) and **P04** (§10, target locations) from
> `platform_improvement_plan.md`.

Purpose: make "the client told us this" a checkable fact rather than a note
somebody typed. A `BusinessProfile` version is either a **draft** (a proposal,
nobody has stood behind it) or **confirmed** (a human's id and a timestamp are
on the row), and the two are never blended — not with each other, and not with
the scraped guesses sitting in `SiteContext` on the same project.

Screens: OP06 (project setup), CP04 (welcome checklist), AE05 (site context),
SL03/PJ02 (project detail). §5.3 steps 4–5 of `design_plan.md`.

## File tree

```
business-profile/
  business-profile.controller.ts   4 controller classes (operator profile, attach,
                                   onboarding, client portal)
  business-profile.service.ts      versioning, confirmation, explicit rebuild,
                                   attachment, domain correction, checklist
  business-profile.types.ts        status vocabularies, transition table, DTO shapes
  market-provider-support.ts       P04 §10.3 — per-provider targeting support, read
                                   from each adapter's own request-building code
  business-profile.module.ts       registers all 4 controllers, exports the service
  lib/domain.util.ts               domain normalization + validation
  dto/business-profile.dto.ts      profile read/save/confirm/rebuild
  dto/attach.dto.ts                attach + domain correction
  dto/onboarding-request.dto.ts    requests, client-side update, list filters
```

## Endpoints (24)

### Operator — business profile (`/api/projects/:projectId/business-profile`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/` | operator | `{ profile \| null, confirmedVersion, versionCount, unavailableReason }`. `?version=N` reads one exact version; `?state=confirmed` reads the newest confirmed version and **404s when nothing has ever been confirmed** |
| PUT | `/` | admin, delivery-lead | `{ profile, warnings }` — merges the patch onto the working draft |
| GET | `/versions` | operator | `{ versions, latestConfirmedVersion }`, newest first |
| POST | `/confirm` | admin, delivery-lead | `{ profile (the NEW confirmed version), confirmedFrom, warnings }` |
| GET | `/candidates` | operator | `{ candidates, policy, latestConfirmedVersion }` — extracted `SiteContext` rows |
| GET | `/overview` | operator | **(P02 §9.2)** `BusinessInfoOverview` — the four sections, each with `confirmed` / `suggestions` / `gaps` |
| GET | `/target-locations` | operator | **(P04 §10.2/§10.4)** `TargetLocationsOverview` — structured targets, `suggestedCountries`, `providerSupport` preview |
| POST | `/candidates/reject` | admin, delivery-lead | **(P02 §9.2)** `{ field, rejected, detail }` — decline a suggestion ("keep current"). 404 unknown/unsuggestible field; 409 no site context, no current suggestion, or it already matches |
| POST | `/rebuild` | admin, delivery-lead | `RebuildResult` — per-target before/after + what was deliberately not touched |

### Operator — attachment (`/api/clients/:clientId/projects/:projectId`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/attach-check` | operator | `AttachmentCheckResult` — preflight, writes nothing |
| PUT | `/attach` | admin, delivery-lead | `ProjectAttachmentDto` — the project + its real ownership |
| PUT | `/domain` | admin, delivery-lead | `DomainCorrectionResult` — validated, conflict-checked, audited |

### Operator — onboarding requests and checklist (`/api/projects/:projectId`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/onboarding-requests` | operator | `{ requests, counts }`, filterable by `status`/`kind`/`outstanding` |
| POST | `/onboarding-requests` | admin, delivery-lead | 201 request |
| PATCH | `/onboarding-requests/:requestId` | admin, delivery-lead | 200 updated request |
| GET | `/onboarding-checklist` | operator | `OnboardingChecklistDto` |

**Why these are flat and not `.../onboarding/requests`.** `JobsModule` is
registered earlier in `app.module.ts` and already owns
`@Controller('projects/:projectId/onboarding')` with `@Get(':runId')`. Nest
resolves routes in registration order across modules, so
`GET /api/projects/:projectId/onboarding/checklist` was matched by that
controller's `:runId` route first and never reached this module — confirmed by
running it, not by reading it (it answered `Onboarding run checklist not found`).
The only fix available from inside this module is to not share the prefix;
`POST`/`PATCH` would have coexisted, but splitting one resource's reads from its
writes across two prefixes would be worse than moving all four. Reported rather
than worked around in `jobs/`, which is not this module's to edit.

### Client portal (`/api/portal/projects/:projectId` — `@ClientPortal()`)

| Method | Path | Returns |
|---|---|---|
| GET | `/business-profile` | same envelope as the operator read |
| PUT | `/business-profile` | `{ profile, warnings }` |
| POST | `/business-profile/confirm` | the new confirmed version (the CP04 "confirm your details" action) |
| GET | `/business-profile/overview` | **(P02)** the same `BusinessInfoOverview` the operator sees, client-safe by construction — source page + date, no run id, model name or cost |
| GET | `/business-profile/target-locations` | **(P04)** the same `TargetLocationsOverview` the operator sees |
| POST | `/business-profile/candidates/reject` | **(P02)** the client-facing "Keep current" beside a suggestion |
| GET | `/onboarding/checklist` | `OnboardingChecklistDto`, including `blocking` |
| PATCH | `/onboarding/requests/:requestId` | 200 updated request — status limited to `open`/`in-progress`/`done` |

`clientId` on the portal class comes from the JWT only, and every handler still
passes the URL's `projectId` to `ScopeValidationService.assertProjectAccess`,
so a client cannot reach another client's profile by editing the URL.

## How the non-negotiable semantics are implemented

### 1. Confirming writes a new version row

`confirm()` INSERTs a row at `max(version) + 1` carrying `confirmedBy` /
`confirmedAt`, and leaves the draft it read untouched. The draft is the record
of *exactly what the confirming human was shown*; stamping it would destroy
that record the moment somebody edited the profile again.

`saveDraft()` has two cases and no third one:

- newest row is an **unconfirmed draft** → updated in place (no human ever
  stood behind its contents, so no fact is at risk);
- newest row is **confirmed** (or absent) → a NEW draft is created from the
  confirmed values and then patched.

There is no code path in which a row with `confirmedAt != null` is written.

Refusals are specific, because "you cannot confirm this" is useless alone:
confirming an already-confirmed version, confirming a draft a newer confirmed
version has superseded, and confirming when no draft exists are three different
situations with three different fixes (409 each, with the fix in the message).

An **empty** draft is refused (`version N is an empty draft, so there is nothing
to confirm`): a confirmation record has to be a confirmation *of* something. An
incomplete but substantive profile confirms normally; its gaps come back in
`warnings` and go into the audit event, rather than being turned into a note
somebody types "ok" into.

### 2. Confirmed values stay separate from extracted candidates

`GET .../candidates` reads `SiteContext` and returns a shape with
`provenance: 'extracted'` and `confirmed: false`; it contains no `confirmedAt`
field anywhere, so nothing that renders one of these can present it as a fact.
`SiteContextCandidateDto` is a different TypeScript type from
`BusinessProfileData` — merging them is a compile error, not a code review
catch. No method in the service reads `SiteContext` on the profile's behalf: a
scrape becomes a fact only by a human typing it into a draft and confirming it.

### 3. `confirmedBy`/`confirmedAt` stay null until a human confirms

Every read response carries `state` (`'draft' | 'confirmed'`), `isDraft`, and
`confirmedVersion` (the newest *confirmed* version, or `null`). A consumer that
must not cite a guess asks for `?state=confirmed` and gets a 404 rather than a
draft.

### 4. Changed facts propagate only on an explicit rebuild

Confirming updates **nothing** else on the project. `POST /rebuild` is the only
path that moves confirmed facts outward, and it:

- requires `targets` (`@IsIn(REBUILD_TARGETS)`, non-empty) — nothing moves by
  implication;
- reads only from a **confirmed** version (naming a draft is a 409);
- supports `dryRun` to report the diff without writing;
- returns `notTouched`, listing the downstream artifacts it deliberately did
  not touch and the endpoint that owns each (gap-analysis sync, strategy build,
  findings generate, report generate) — the honest counterpart to the targets
  it did apply;
- records an audit event naming the source version and the reason.

The one target implemented, `project-competitors`, **merges** the confirmed
rival names into `Project.competitors` (the JSON column intake seeds and
share-of-voice reads). A merge, not a replace: it cannot lose evidence intake
already found. `GET ...?version=N` is the other way to pin a reading without
propagating anything.

### 5. Domain correction is a validated change, not a label edit

`lib/domain.util.ts` normalizes to the bare host (scheme, `www.`, port, path,
case, trailing dot only) and **throws** on anything that is not a hostname — an
unsupported scheme, an email address, an IPv4 literal. `PUT .../domain`
requires the project to actually belong to the `:clientId` in the URL (an
unattached project is a 404 — attach it first), checks every other project's
domain *after normalization* (so `https://www.Example.com/` collides with
`example.com`), demands a reason, and writes an audit event with before/after.
The `@unique` constraint is the last line of defence; a race that beats the
pre-check surfaces as a 409, not a 500.

### 6. `clientName` never masquerades as a `clientId`

`Project` has both a nullable `clientId` (relation) and a legacy `clientName`
(string). They are treated as different things everywhere:

- `ProjectOwnershipDto` reports both, plus `established` (true only when
  `clientId` is set) and `labelWithoutOwnership` (a label with no `clientId`).
- `PUT /attach` never resolves a client from `clientName`. A project whose only
  connection to a client is that string is **unattached**, and the response says
  so in `warnings`.
- The label is written *from* `clientId` (seeded from the owning client's name
  when the column is empty), never read *to* it.
- Moving a project away from another client requires `reassign: true`; a stale
  wizard tab resubmitting cannot relink somebody's project.
- Duplicate domains are refused globally, not per-client: one domain cannot be
  owned by two clients, so a collision against any project must be resolved
  rather than attached around.

### 7. `blockedWork` is exposed with its link

`OnboardingRequest.blockedWork` (JSON string[]) holds WorkItem ids. Every read
returns them **both** as the stored ids and resolved to `blockedWorkLinks`
(id, title, status, cycleId), so a client-facing view can say *what* is waiting
on them. An id that no longer resolves is reported `missing: true`, never
dropped. On write, every id is checked to belong to the same `projectId` — a
foreign or unknown id is a **404** (not a 403), so a caller who guesses another
project's work-item id learns nothing from the error.

## Business information (P02, §9.1–§9.2) — `GET .../overview`

One screen's worth of the profile, grouped the way §9.1 asks: **About your
business**, **Your customers**, **Target locations and languages**, **Brand
details**. Each section carries three lists, and the three are deliberately
never merged:

| List | Meaning |
|---|---|
| `confirmed` | The value on the current draft/confirmed row — what the client or staff have stood behind (or drafted) |
| `suggestions` | A still-open value the latest `SiteContext` extracted, **not** applied, with its `sourcePage` and `sourceDate` |
| `gaps` | Empty, and nothing suggesting it — a question for a human, not an inferred answer |

Twelve fields are tracked (`BUSINESS_INFO_FIELD_DEFS`): brand name, legal name,
what you do, **business category / type**, products/services, customer types,
buyer roles, customer problems, target locations, languages, named
competitors, commercial goals. Four of them — legal name, buyer roles,
languages, goals — have **no extraction source at all**: nothing in
`SiteContext` reads them, so the field is `confirmed`-or-`gap` only and no
suggestion is ever fabricated for it.

**C2 (2026-09-21, `docs/analysis/client-portal.md` §12):** `category` is new —
a `BusinessProfile.category` column (nullable string), wired through
`BusinessProfileData`, `SaveBusinessProfileDto`, `toData()`/`saveDraft()`/
`confirm()`/`emptyData()`/`merge()`, `BUSINESS_INFO_FIELD_DEFS` (section
`about`, suggested from `SiteContext.category`, which already existed and
was already read for the client-safe `listCandidates()` surface — only the
confirmed-facts side was missing it) and `BUSINESS_INFO_FIELDS`. Also wired
into both `business-info/page.tsx` screens (client and ops) via their
generic `buildPatch()` switches — no new UI component needed since both
pages already render `overview.sections` data-driven. This was §12's one
remaining unverified field from C1/C2 planning; "target markets" was
confirmed already covered by the existing `markets`/`targets` fields.

`hasSiteContext` + `sourceCheckedAt` say whether the module looked and when; a
project with no context shows gaps and zero suggestions, which is the honest
answer, not an empty profile.

### Declining a suggestion is a recorded fact (P02)

`POST .../candidates/reject` (operator, or the client's own "Keep current")
writes a `BusinessProfileRejection` row keyed on
`projectId + fieldPath + valueHash`, where `valueHash` is a **sha256 of a
canonical form** of the suggested value: arrays trimmed, blanks dropped,
sorted; strings trimmed. So reordering a service list or adding a space does
not defeat a rejection, and a genuinely changed value is a different hash.

Three refusals, each with its own fix, and each honest about which case it is:

- **404** — `"{field}" has no suggested value to decline.` (an unknown field,
  or one of the four with no extraction source);
- **409** — no site context at all, or nothing currently suggested for that
  field;
- **409** — `"{field}" already matches the current confirmed/drafted value —
  there is nothing to decline.` Declining a value you are already using would
  be a lie about what happened, so it is refused rather than swallowed.

The value rejected is read from the current `SiteContext`, **never from the
request body** — a caller cannot record a rejection of a value that was never
suggested. `overview` then withholds any suggestion whose
`field + valueHash` is on that list, and counts them in
`suppressedRejectedCount` so the withholding is visible rather than just
absent. §9.2's rule is "a declined suggestion must not resurface"; this
implementation is that rule plus the arithmetic that proves it fired.

## Target locations (P04, §10) — `GET .../target-locations`

The flat `markets: string[]` field is retained for existing readers, but the
structured unit is now `MarketTarget`:

```
{ country, region, city, language, priority, active, productApplicability }
```

`country` (ISO-3166 alpha-2) is the one required, and the one unit every
adapter understands; `active: false` keeps a target on file while excluding it
from measurement scope and cost estimates; lower `priority` is higher
priority, ties broken by array order.

**Targets ride the same draft/confirm versioning as every other profile
fact** — there is no per-target confirm gate, and there is no second write
path. A target exists as a draft until the profile is confirmed, exactly like
a description edit.

`suggestedCountries` comes from `SiteContext.markets` (P03's ranked
service-area evidence): ISO-2 codes the site names that are not already an
active target — offered, never applied.

### The provider-support preview is read from the adapters, not assumed

`providerSupport` answers "if we measured this target, what would the provider
actually do?" — per provider: `{ supported, effectiveGranularity, mode }`,
computed in `market-provider-support.ts` from what each adapter's
request-building code was **read to do**:

| Provider | Reality, traced to the adapter |
|---|---|
| ChatGPT / Perplexity / Gemini / AI Overview / AI Mode (via Cloro) | `provider-targeted` at `country` grain — the payload really carries `country: <geo>` |
| Google SERP (DataForSEO) | `provider-targeted` at `country` grain via `location_name`; **city only for a short whitelist** (New York, Los Angeles, Chicago, London, Mumbai, Bengaluru, Sydney mapped to their exact DataForSEO location strings) |
| Claude (Anthropic API) | `unsupported` — `geo` is received and explicitly discarded (no proxy egress yet) |
| Perplexity (Sonar API), ChatGPT/Perplexity/Gemini browser sessions | `unsupported` — `geo` is recorded on the observation and never enters the request or the prompt |

A target asking for a city that is not whitelisted reports
`supported: false` on **every** provider. That is the rule in the file's own
words: *"Never silently widen to country and call it the city."* The preview
makes no network call — it is a statement about the adapters as they exist
today, and it says so.

### `getConfirmedTargetCountries()` — the one method other modules call

Returns the active target countries on the newest **confirmed** row, in
priority order (§10.2 step 5). It returns `[]` when nothing is confirmed, and
its own doc says callers must not read that as "no opinion, pick something".
The consumer it was built for is `aeo-audit`'s `resolveDefaultMarket()`.

## §10.2 — the silent ccTLD → default-US path is gone

The measurement market used to fall back to a hardcoded `'US'`, which quietly
measured a US market for a project whose own site said `IN`. That rung of the
ladder has been removed. The precedence is now:

1. an explicit `geo` passed with the run (a staff-approved provisional run);
2. `BusinessProfileService.getConfirmedTargetCountries()`;
3. a provisional value derived from the project's own site context
   (`context.markets[0] ?? context.geo`) — the service logs a warning whenever
   the resolved source is anything other than `confirmed-target`, so a
   provisional market is visible in the log rather than indistinguishable from
   a confirmed one;

and then it **refuses**:

> `Project <id> has no confirmed target market (Business information -> Target
> locations) and no site-derived service-area signal to fall back to. Confirm
> at least one target country before running this audit, or pass an explicit
> "geo" for a staff-approved provisional run (results will be marked
> provisional).`

A conflict naming the fix, not a default — the fix is one screen away, and
the message says which screen. `target-markets.smoke.sh` is the proof that
this is a behaviour change and not just a comment: an India-ccTLD project with
a confirmed US target measures **US**, a project with no signal at all gets a
409, and the failed audit row is recorded `status=failed` rather than being
left pending forever.

## The checklist

`GET .../onboarding/checklist` is built from records, and every line names its
`source`:

| Key | Source | Rule |
|---|---|---|
| `confirm-profile` | `business-profile` | done when a confirmed version exists, regardless of any request |
| `invite-collaborators` | `client-member` | done when the client has more than one active seat; `unavailable` when no client is attached |
| `gsc-access` / `ga4-access` / `cms-access` / `brand-assets` | `onboarding-request` | the request's own status |
| `agree-scope` | `cycle` | done when a cycle exists with status ≠ `planning` |

A line with no backing record is `not-requested`, which is a different state
from `done`, and `unavailable` is a different state from a failure. `counts`
separates all four so a UI cannot collapse them.

`blocking` is the "why is this waiting on me" view: each outstanding request
with the work items it is holding up.

## Dependencies

- `PrismaService` — global via `DatabaseModule`, injected, never imported.
- `ScopeValidationService` — global via `ScopeValidationModule`, used by every
  handler to derive/validate `clientId`/`projectId` ownership before touching a
  row. It is imported explicitly in `BusinessProfileModule` only for
  `ActivityModule`, below.
- `ActivityService` (`ActivityModule`) — audit events for attach, domain
  correction, draft writes, confirmations, explicit rebuilds, request changes,
  and (P02) declined suggestions. An audit failure is logged and does not fail
  the business write.

**Consumers of the P02/P04 additions** (this module's exports are read-only
for them; nothing here calls back into them):

- `aeo-audit` — `getConfirmedTargetCountries()` in `resolveDefaultMarket()`
  (hence the §10.2 change documented above).
- `competitors` — the confirmed services/segments and target countries
  §12.2's market discovery composes its bounded searches from.
- `digital-presence` — the confirmed profile + target-country count behind the
  applicability policy's `hasMultipleMarkets` signal.

## Env vars

None. No LLM, no external provider, no queue.

## PRD alignment (design_plan.md Appendix A, G04 + §5.3)

| Requirement | Status |
|---|---|
| `PUT /api/clients/:clientId/projects/:projectId/attach` with explicit authorized reassignment | ✅ `reassign: true` required to move between clients; `expectedCurrentClientId` optional optimistic guard; `attach-check` preflight |
| `GET/PUT /api/projects/:projectId/business-profile` | ✅ plus `/versions`, `/confirm`, `/candidates`, `/rebuild` |
| Scoped portal equivalent | ✅ `/api/portal/projects/:projectId/business-profile`, `.../confirm`, `.../onboarding/checklist`, `.../onboarding/requests/:id` |
| `GET/POST/PATCH .../onboarding/requests` and checklist reads | ✅ all four verbs, at `.../onboarding-requests` and `.../onboarding-checklist` — see "Why these are flat" above for why the nested path is not usable |
| Business profile: version, brand/legal name, description/services, ICP, markets/languages, facts, competitors, goals, approvers, CMS/publishing, confirmedBy/time | ✅ every field on the model is read and written; `publishing` carries cms/constraints/styleNotes |
| Persist confirmed values separately from extracted candidates | ✅ separate endpoint, separate type, no shared read path |
| Sales handoff does not duplicate a unique domain | ✅ attach attaches the existing project; `attach-check` and `attach` both refuse a normalized duplicate |
| `clientName` does not masquerade as `clientId` | ✅ ownership reported structurally; legacy label reported, superseded, never resolved |
| Changed facts propagate only on explicit rebuild/version selection | ✅ `POST /rebuild` with required targets, confirmed-only source, dry run, `notTouched`; `?version=` for non-propagating reads |
| Domain correction requires validated normalization/conflict/ownership policy | ✅ `lib/domain.util.ts` + global conflict check + ownership 404 + mandatory reason + audit |
| Request: type, requested person, due, status, blocked work | ✅ plus `blockedWorkLinks`, `outstanding`, `overdue` |
| Draft-project / setup launch separation | ⚠ **not implemented.** §5.3 asks for "save draft, finish setup, then launch" without creating a project prematurely. `POST /api/clients/:id/projects` still creates the project and starts the pipeline immediately, and G07 owns durable orchestration/resume. Nothing in this module simulates a draft project — creating a hidden project to fake one is exactly what the plan forbids. |
| Interim: notes/messages and operator edits, labeled unstructured | ➖ not needed: the structured intake path exists, so no unstructured interim is served. |
| §9.2 — one business-information screen: confirmed / suggested / needs information, by section | ✅ | `GET .../overview` (operator + portal); four sections, eleven fields |
| §9.2 — a declined suggestion must not resurface | ✅ | `BusinessProfileRejection` on `field + sha256(canonical value)`; withheld on read, counted in `suppressedRejectedCount` |
| §9.2 — never fabricate a suggestion for a field nothing extracts | ✅ | Four fields (legal name, buyer roles, languages, goals) have `getSuggested: null` — gap-only |
| §10.2 — structured target locations (country/region/city/language/priority/active) | ✅ | `MarketTarget` + `GET .../target-locations`, riding the existing draft/confirm versioning |
| §10.2 — the confirmed target is the measurement scope; no silent default | ✅ | `getConfirmedTargetCountries()` is the one accessor; the hardcoded `'US'` rung was removed (see above) |
| §10.3 — provider targeting support is stated, never assumed | ✅ | `market-provider-support.ts`, traced per adapter; a non-whitelisted city is `unsupported` everywhere, never widened to country |
| §10.4 — site evidence suggests targets, a human confirms | ✅ | `suggestedCountries` from `SiteContext.markets`; offered, never auto-applied |
| §10.2 step 6 — remove the silent ccTLD → default-US measurement path | ✅ | `resolveDefaultMarket()` throws a conflict naming the fix; proven by `target-markets.smoke.sh` |
| C2 §12 — business category/type is client-editable in the confirm-details wizard step | ✅ | New `category` column, live end-to-end (verified: `PUT` a draft with `category`, `POST /confirm`, `category` round-trips in the confirmed row) — see client-portal/clients module READMEs for the wizard flow this feeds. |

## What was verified, and what was not

- `npx tsc --noEmit` on `backend/` → **0 errors**; `npx nest build` → succeeds.
- **90/90 smoke assertions pass**, run end to end against a booted server
  (`PORT=3099 SCHEDULING_BACKEND=bullmq CADENCE_TICK_MS=0 node dist/main`, so
  the hourly audit schedulers and the cadence ticker stood down and no second
  instance could trigger work). The script lives at `/tmp/g04-g20.smoke.sh` and
  sources the repo's own `smoke/_common.sh`; it was not added to `backend/smoke/`
  because that directory is outside this task's scope.
  Directly exercised, among others:
  - confirm writes version 2 while the draft is version 1, and
    `?state=confirmed` afterwards still returns version 2 carrying the
    *pre-edit* data after a later draft edit → the confirmed row is never
    mutated;
  - a rebuild from a draft version 409s; a dry run reports the change without
    writing; a real rebuild moves `Project.competitors`; **confirming a version
    propagates nothing**;
  - `blockedWork` with a foreign id 404s, and a valid one resolves to the work
    item's title;
  - attach refuses a normalized duplicate domain (409), is a no-op when the
    project is already owned by the named client, requires `reassign: true` to
    move a project between clients, and reports a legacy `clientName` as
    non-ownership;
  - domain correction refuses a collision (409) and invalid input (400), and
    normalizes `HTTPS://WWW.X/` to `x`;
  - the client portal returns 403 for another client's project, 403 on the
    operator route, and a client's edit produces a `draft`, not a fact.
- **Not covered by the smoke run:** `assertPublicShareAllowed` is a G20
  concern; nothing calls it over HTTP by design, so it is verified by
  compilation and inspection only.
- The 404 for a project id that does not exist is returned before the ownership
  check can distinguish it (both are 404 on the portal surface), which is
  intentional — see `ScopeValidationService.assertOwnedByProject`.

### P02/P04 additions (2026-09-17) — two new suites, **not re-run during documentation**

- `backend/smoke/business-info-portal.smoke.sh` — the P02 exit gate. Run with
  `/opt/homebrew/bin/bash` and `API=http://localhost:3002/api`. It seeds a
  confirmed profile (v1) plus a *disagreeing* `SiteContext`, and asserts:
  the operator and client overviews both carry the sectioned
  `confirmed`/`suggestions`/`gaps` shape; a **recursive allowlist** over the
  client response finds no run id, model name, cost or confirmed-by actor, and
  no forbidden internal JSON key / private model name / operator actor id;
  rejecting a suggestion is acknowledged and the suggestion is withheld on the
  very next read, with `suppressedRejectedCount` incremented; a **simulated
  recrawl** carrying the *same* value still withholds it while a genuinely
  *changed* description still surfaces; accepting a suggestion creates a
  `draft`, not a fact; confirming writes a **new version 3** with version 1's
  data untouched; rebuild stays a separate explicit act; and another client's
  overview discloses nothing.
- `backend/smoke/target-markets.smoke.sh` — the §10.2 exit gate. Builds a
  site context for an India-ccTLD project, saves a structured draft target
  `country=US`, confirms it, and asserts: `/target-locations` reports
  `profileState=confirmed` with the one target; the `providerSupport` preview
  covers 5+ rows with Cloro honestly `provider-targeted`/country, Claude and
  the browser surfaces honestly `unsupported`; an unvalidated city target is
  disclosed `unsupported` on **every** provider; a whitelisted city (New York
  on DataForSEO) reads `provider-targeted`/`city`/supported; then the run
  itself: with no explicit `geo` the audit's effective market is **US**, not
  the ccTLD's IN, with exactly one market measured and `markets` persisted as
  `["US"]`. For a project with no confirmed target and no site signal, the run
  is a **409** whose message names the fix, and the audit row is recorded
  `status=failed`. An explicit `geo` override still works and measures GB.
- **Not re-run during documentation**: both suites were read, not executed, in
  this pass — other agents were mid-flight on shared source and the dev
  database, so a failure could not have been attributed to this module. The
  assertions above are quoted from the scripts; treat them as claims about the
  scripts, not as a fresh pass result.

## C6 §29 — Competitor cap (added 2026-09-21)

`docs/analysis/client-portal.md` §29 / `docs/PLAN.md` §11.6. The number of competitors a client
can directly add (`saveDraft`, the client-editable path from `business-info/page.tsx` →
`portal-profile.ts`) is capped by the owning client's plan tier — same spirit as the C4 prompt
quota (§20), because each tracked competitor multiplies measurement-run cost.

**Per-tier caps** (proposed by this build; §29 deliberately left the numbers open — PRD FR-1.3's
"3 to 8" is a suggestion, not a tier table). All in one file,
`lib/competitor-cap.util.ts`, easy to retune:

| Tier | Cap | Why |
|---|---|---|
| `starter` | 5 | Within PRD's "3–8" range, but not its top end — the most cost-sensitive tier. |
| `growth` | 15 | 3× starter — mirrors §20's 100→300 step and `refresh-cadence`'s starter→growth jump. |
| `scale` | 50 | Another ~3× step (§20's 300→1000) — a category-tracking tier, still bounded. |
| `enterprise` | unlimited (`null`) | Matches §20 and `refresh-cadence`'s enterprise = uncapped precedent. |

**How it works.** `saveDraft` calls `enforceCompetitorCap(project.clientId, newCount)` only when
`dto.competitors` is present **and** the merged count is greater than the base count — so it blocks
only a save that *increases* the count. A client already over the cap (e.g. grandfathered from
before the cap existed) can still remove competitors or edit unrelated fields. The tier is read
directly from `Client.planTier` (the same read pattern `refresh-cadence` uses — never a derived
guess); a project with no `clientId` is treated as `starter` (the most conservative default).

Unlike C4's prompt quota (which snapshots `overQuota` and lets an admin decide — appropriate there
because a prompt *request* is itself a review step), a competitor is a direct, un-reviewed edit
(§12), so this **rejects** the save outright with a dedicated
`CompetitorCapExceededException` (HTTP 422). Its body is machine-readable
(`error: "competitor-cap-exceeded"`, `planTier`, `competitorCap`, `requestedCount`) so the client
portal renders it as an upsell (`web/.../business-info/page.tsx` via
`competitorCapExceeded()` in `portal-profile.ts`) rather than a generic validation error.

Files: `lib/competitor-cap.util.ts` (tier table + normalize + exception),
`business-profile.service.ts` (`enforceCompetitorCap` + the `saveDraft` check).

### C6 §29 verification status

**Code-complete; `npx tsc --noEmit` clean (backend) and `npm run typecheck` clean (web).** The
required live end-to-end run is **PENDING**: this session had no reachable Postgres (Docker
Desktop's engine would not start and no local Postgres was installed). To verify once a backend +
Postgres is up:

1. Attach a project to a client; `PATCH /api/clients/:clientId` `{ "planTier": "starter" }`.
2. `PUT /api/portal/projects/:projectId/business-profile` (as that client) with 6 competitors →
   expect `422 { "error": "competitor-cap-exceeded", "planTier": "starter", "competitorCap": 5,
   "requestedCount": 6 }`.
3. Save with 5 → `200`. Add a 6th → `422`. Remove one → `200` (removal never blocked).
4. `PATCH planTier` → `growth`; save 6+ → `200` (cap now 15).
5. Confirm the web upsell copy renders on `business-info` (the `competitorCapExceeded` branch).

