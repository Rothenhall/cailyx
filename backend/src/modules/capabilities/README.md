# Capabilities — G18 (usable capability/readiness contract)

One place that answers "can this actually run?", keeping four different things
apart that are easy to collapse into one misleading boolean.

Contract: `design_plan.md` Appendix A, G18 (line 1703). Screens OP15 / PJ03 /
AE02 / CT03.

## Purpose

The acceptance criterion is literal: **no enabled button merely because an env
key exists.** A single `configured` flag cannot carry that — an env key proves
nothing about whether it works, whether *you* may use it, or whether *this
project* is wired up. So every capability reports four independent facts, and
the button state is derived from all four:

| Fact | Question | Source | Mutability |
|---|---|---|---|
| `configured` | Is the server config present? | env, re-read every request | never persisted |
| `verified` | Has a real call actually succeeded? | a recorded observation | **only** via `recordSuccess` |
| `authorized` | May this caller use it? | per-user OAuth connection / delegation | live |
| `resourceMapped` | Is this project wired to a resource? | `GoogleProjectResource` | live |

`allowedActions` is **empty unless `state === 'ready'`** — the criterion
expressed as data rather than as a UI rule someone could forget.

## File tree

```
capabilities/
├── capabilities.module.ts      exports CapabilitiesService (the contract)
├── capabilities.controller.ts  3 controller classes, 3 endpoints
├── capabilities.service.ts     seeding, recording, state derivation, the two audiences
├── capabilities.registry.ts    the 44 seeded keys + their config probes
├── capabilities.types.ts       states, blocked-by codes, operator & client shapes
└── README.md
```

## Endpoints

| # | Method | Path | Audience | What it returns |
|---|---|---|---|---|
| 1 | GET | `/api/capabilities` | operator | The full roster: 44 capabilities with the four facts, derived state, guidance, limits |
| 2 | GET | `/api/projects/:projectId/capabilities` | operator | The same, plus `resourceMapped` and per-task-kind scheduler state |
| 3 | GET | `/api/portal/projects/:projectId/capabilities` | **client** | A reduced DTO — 6 client-meaningful capabilities, no internal detail |

Route 3 is a separate controller class marked `@ClientPortal()` so the whole
surface is gated at once. Verified: an operator token receives **403** on it
(RolesGuard is default-deny for both audiences).

## The contract other modules adopt

`CapabilitiesService` is exported from the module and is the intended
integration point:

```ts
// Wrap the provider call — readiness updates itself.
return this.capabilities.withProbe('serp.dataforseo.serp', () => this.provider.fetch(...));

// Or gate on it first, so the rule holds server-side even for a caller
// that never looked at a UI.
await this.capabilities.assertReady('serp.dataforseo.serp', projectId);
```

| Method | Purpose |
|---|---|
| `recordSuccess(key, detail?)` | Sets `verified: true`, `lastSuccessAt`, clears `lastError*` |
| `recordFailure(key, error, {mock?})` | Sets `lastErrorAt`/`lastError`; **does not clear `verified`** |
| `recordProbe(key, {ok, error?, mock?})` | One-call outcome |
| `withProbe(key, fn)` | Runs `fn`, records the outcome, rethrows the original error |
| `assertReady(key, projectId?)` | Throws `ServiceUnavailableException` with the actionable state |

`verified` means "a real call has succeeded at least once". A later failure
leaves it true and moves the state to `degraded` — the earlier success does not
un-happen. Recording against an unregistered key **throws** rather than
creating a phantom row with readiness nobody can act on.

## Seeded capabilities (44)

Keys follow the dotted `domain.subject` convention documented on the Prisma
model. Env var names are the ones each provider's own code reads, taken from
its `config.get` / `process.env` calls — see the registry for each entry's
`envVars`.

| Group | Keys |
|---|---|
| AEO — Cloro credential | `aeo.cloro` |
| AEO — Cloro engines | `aeo.cloro.chatgpt`, `.perplexity`, `.gemini`, `.ai-overview`, `.ai-mode` |
| AEO — browser sessions | `aeo.chatgpt-browser`, `aeo.perplexity-browser`, `aeo.gemini-browser` |
| AEO — fixtures | `aeo.mock` (`mockMode`) |
| AEO — LLM analysis passes | `aeo.analysis` |
| LLM providers | `llm.openrouter`, `llm.anthropic` |
| Provider-backed features (LLM) | `content.article`, `content.ad`, `content.persona`, `content.page-analysis`, `content.authority`, `content.council`, `content.internal-link`, `content.findings` |
| First-party answer surfaces | `ai-surface.claude`, `ai-surface.perplexity` |
| Entity / model measurement | `entity.model-diff` |
| DataForSEO | `serp.dataforseo`, `serp.dataforseo.serp`, `keywords.dataforseo`, `backlinks.dataforseo`, `business-data.dataforseo` |
| Journey execution | `journey.execute` |
| Google | `google.oauth`, `google.search-console`, `google.analytics` |
| Site health | `site-health.psi` |
| Social | `presence.apify` |
| Content | `content.agent-readiness`, `publishing.custom-webhook` |
| Email | `email.plunk` |
| Billing | `billing.stripe-links`, `billing.stripe-webhooks`, `billing.public-intake` |
| Infrastructure / mode | `infra.redis`, `swarm.live`, `scorecard.public` |

The fourteen `content.*` / `journey.*` / `entity.*` / `publishing.*` /
`billing.*-webhooks` / `billing.public-intake` / `scorecard.public` keys were
added by A5. They are separate keys rather than one row per provider because
each fails independently (a retired model id degrades one feature, not all of
them) and `verified` is recorded per call site — the point of an observation is
to know *which* feature worked. Every env var they name was read out of the
module that reads it; none is invented.

Registry keys are **code, not data**: removing a provider means editing
`capabilities.registry.ts`, so a capability that no longer exists stops being
reported instead of lingering as a stale row.

`CapabilityStatus` starts empty, and the pre-existing consumer
(`CadenceService.evaluatePrerequisites`) treats a missing row as *unknown,
therefore not ready*. `ensureSeeded` materialises one row per registered key on
boot (and lazily if the table is short), refreshing only the config-derived
columns — `verified` and `lastError*` are deliberately absent from the upsert's
`update`, so seeding can never invent an observation.

### Two probe shapes worth knowing

- **`llmFeature(...)`** — the eight LLM-backed features share one probe: the
  provider choice is an either/or (OpenRouter preferred, Anthropic fallback), so
  it cannot be a flat prerequisite list; the OR lives in the probe and the
  operator sentence names the winner. Unset credentials give `unconfigured` with
  the exact action, because a feature with no LLM provider produces nothing and
  must not look ready.
- **`publishing.custom-webhook`** — the only entry whose env var name is derived
  from data: `PUBLISH_CREDENTIAL_<UPPER_SNAKE_SLUG>` is built from a
  destination's `credentialRef` (`publishing/lib/credentials.util.ts`). `EnvReader`
  therefore grew a `list(prefix)` method, and the probe reports the *names* of the
  credentials it found — never their values — so an operator can match them
  against their destinations.

## States

`ready` · `unverified` · `unconfigured` · `blocked` · `mock` · `degraded` ·
`unauthorized` · `unmapped`

Precedence is the design: an unconfigured credential or an unmet prerequisite
outranks everything (nothing downstream can be true); `mock` outranks `ready`
(a fixture must never earn a green light); and `unverified` outranks `ready`
because configuration is not evidence.

`blockedBy` carries a machine-readable cause — `credential-missing`,
`master-switch-off`, `session-missing`, `session-file-missing`,
`prerequisite`, `not-authorized`, `resource-unmapped`, `never-verified`,
`last-call-failed`, `mock-only` — and `stateDetail` carries the sentence.

### The actionable states the package asks for

- **Missing browser session** → `unconfigured` with `blockedBy:
  'session-missing'` and the exact fix ("sign in to chatgpt.com once and save
  the storageState to `AEO_CHATGPT_SESSION_PATH`"). A configured path whose
  file is gone is a distinct `session-file-missing`. "We never turned it on"
  and "the session expired" are different problems.
- **Provider outage** → `degraded` with no actions offered, `operatorGuidance`
  for context and the raw `lastError` for the operator. Retry is a deliberate
  human act, not an automatic loop.
- **OAuth connected, resource unmapped** → `unmapped` with the action to take
  (choose the site/property for this project), matching design_plan §3.5.

## mockMode disclosure

`mockMode` is recomputed from env on every read and returned on **every**
capability it could affect, with a `mockDisclosure` sentence that is a field
rather than caller-supplied copy, so it cannot be dropped. The roster's
`summary.mockModeKeys` lists them. Fixture-backed capabilities offer **no**
actions — the same rule `CadenceService` already applies.

## The client view is built, not filtered

`ClientCapabilityView` has no field for an env var name, a provider key, an
internal error string, a prerequisite or a `blockedBy` code — there is nothing
to filter at the edge and nothing to forget to filter. Only the 6 capabilities
with a `clientFacing` block appear, under client-meaningful slugs
(`search-performance`, not `google.search-console`; `site-speed`, not
`site-health.psi`).

Fixture mode still reaches the client — as `dataSource: 'simulated-test'` with
`dataSourceDisclosure` — because a result a client has already seen must not be
silently re-labelled as a measurement. A simulated capability is never
`available`.

Verified: the serialized client payload contains no `envVars`, `configDetail`,
`lastError`, `blockedBy`, `prerequisites`, `mockMode` or `unmetPrerequisites`,
and no literal `CLORO_API_KEY`, `ANTHROPIC_API_KEY`, `PSI_API_KEY`,
`DATAFORSEO`, `APIFY`, `SWARM_ALLOW_LIVE` or `session`.

## Dependencies

| Depends on | Why |
|---|---|
| `PrismaService` (global) | `CapabilityStatus`, `GoogleConnection`, `GoogleProjectResource`, `ConnectionDelegation`, `CadenceRule` |
| `ScopeValidationService` (global) | G03 project-scope enforcement |
| `ConfigService` (global) | The config probes |

Imports nothing else. Exports `CapabilitiesService`.

`ConnectionDelegation.connectionId` is a plain column (no Prisma relation), so
the delegated-service lookup is two queries rather than a join — noted in
`buildContext`.

## Env vars

None of its own. It reads (never writes) the env of every provider it reports —
the authoritative list is each registry entry's `envVars`, and each matches the
`config.get` call in that provider's own module. Notable ones:

`CLORO_API_KEY`, `AEO_ALLOW_BROWSER_SURFACE`, `AEO_{CHATGPT,PERPLEXITY,GEMINI}_SESSION_PATH`,
`MEASUREMENT_ALLOW_MOCK`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`PERPLEXITY_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`,
`SWARM_ALLOW_LIVE`, `SERP_ALLOW_FIXTURE`, `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `PSI_API_KEY`, `APIFY_API_KEY`,
`AGENT_READINESS_CLI`, `PLUNK_SECRET_KEY`, `STRIPE_CHECKOUT_URL_FULL`,
`REDIS_URL`, `SCHEDULING_BACKEND`.

No new dependencies.

## PRD alignment

| design_plan G18 requirement | Where |
|---|---|
| `GET /api/capabilities` | Endpoint 1 |
| Project-specific capability readiness | Endpoint 2 |
| Allowed action | `allowedActions` (empty unless ready), `operatorGuidance` |
| Supported engine/provider IDs | `supportedProviders` |
| Configured / healthy / last-success / last-error | `configured`, `state`, `lastSuccessAt`, `lastErrorAt` + `lastError` |
| Prerequisites | `prerequisites` + `unmetPrerequisites` |
| Runtime limits | `limits` |
| Available output types | `availableOutputs` |
| Scheduler state | `scheduler[]` on the project route, from `CadenceRule` |
| **Separate config presence / tested credential / authorized user / mapped resource** | The four facts, each with its own field and its own derivation |
| **No enabled button merely because an env key exists** | `allowedActions` is `[]` unless `state === 'ready'`; verified with PSI configured-but-unverified |
| **Missing browser session or outage gives an actionable state** | `session-missing` / `session-file-missing` / `degraded` with `stateDetail` + `operatorGuidance` |
| **Mock/fixture mode visible** | `mockMode` + `mockDisclosure` on every affected entry; `dataSource` for clients |
| **Clients do not see secret names or infrastructure diagnostics** | `ClientCapabilityView` — a separate shape with no such fields |

## What this module does not do

- **Nothing records an observation yet, so every capability reads `unverified`.**
  `withProbe` / `recordSuccess` are the contract, and no adapter calls them: the
  roster is honest (configuration is not evidence) but it is also uniformly
  grey. Wiring an adapter is one line at its provider call —
  `return this.capabilities.withProbe('serp.dataforseo.serp', () => this.provider.fetch(...))`
  — and `CapabilitiesService` is exported from this module for exactly that.
  Until then `verified` means what it says: nothing has recorded a success.
- **No verification ("test connection") endpoint.** `assertReady` and the
  recording API exist; what does not exist is a zero-cost probe per provider.
  Only Cloro has one wired (`GET /v1/credits`, used by `budgets`). Adding 44
  test calls means 44 provider-specific code paths, several of which spend
  money — so no test button is offered rather than one that would bill.
- **Capabilities with no configuration surface are not registered.** `tech-stack`,
  `mention-tracking` and `crawler-monitor` crawl through the shared fetcher with
  no env gate of their own, so a key for them could only ever report
  `configured: true` and an observation nothing writes — noise on a screen whose
  whole point is that a green light means something. Their failures surface as
  job errors on the ledger instead.
- **No runtime probe on read.** `infra.redis` reports `configured` from
  `REDIS_URL` and leaves `verified` to recorded observations, rather than
  pinging Redis on every `GET /api/capabilities`. Reachability is an
  observation, not a configuration fact.
- **No persistence of `blockedBy`/`action`.** They are recomputed per request;
  `CapabilityStatus` has no column for them and storing a stale copy would be
  worse than none.
- **Prerequisite evaluation is depth-first with a cycle guard**, not a
  topological sort. The registry's graph is two levels deep; a cycle would be a
  registry authoring error and is reported as an unmet prerequisite rather than
  hanging.

## What was verified, and how

Same harness as `budgets` (96 assertions total, 0 failures). The G18 ones:

- 44 capabilities seeded; every required key present, including all 14 added by
  A5 (`journey.execute`, `scorecard.public`, `billing.stripe-webhooks`,
  `billing.public-intake`, `publishing.custom-webhook`, `entity.model-diff`, and
  the eight `content.*` LLM features).
- **PSI with `PSI_API_KEY` set is `configured: true`, `verified: false`,
  `state: 'unverified'` and `allowedActions: []`** — the acceptance criterion.
- `recordSuccess` flips it to `ready` with the action enabled; a subsequent
  `recordFailure` moves it to `degraded` with no actions and `verified` still
  true; the raw error is retained.
- An unset key is `unconfigured` with a non-empty actionable sentence naming
  the env var (on the operator surface only).
- The LLM provider order (OpenRouter preferred, Anthropic fallback) is visible
  via `operatorGuidance`, and survives the capability becoming ready.
- The project route reports `resourceMapped` and `scheduler[]`; the global
  route leaves `resourceMapped` null rather than guessing.
- The client payload leaks none of 16 forbidden strings and uses
  client-meaningful slugs.
- `assertReady` refuses a degraded capability and an unregistered key; a
  recording against an unregistered key throws and creates no row.

Also verified end-to-end over HTTP: all 3 routes serve on a booted server,
`GET /api/capabilities` returns ~29 KB of roster, and the client route returns
**403** for an operator token. All 3 appear in the generated OpenAPI document.

### A5 re-verification (2026-09-16, real `AppModule` context)

- **44 keys reported**, **44 `CapabilityStatus` rows** seeded — the roster and
  the table agree, so nothing is being reported from a missing row.
- Every capability carries a non-empty `stateDetail`; **no capability offers an
  action unless its state is `ready`**; **nothing is `verified`** (no call has
  recorded one, and configuration alone never sets it).
- A5's new keys behave like the rest: `content.article` is `configured` (key
  present) and `unverified` with `supportedProviders: ["openrouter","anthropic"]`
  and its model-override env vars in `limits`; `site-health.psi` names
  `PSI_API_KEY` in `envVars`; `billing.stripe-webhooks` is a separate key from
  the `billing.stripe-links` ledger and names `STRIPE_WEBHOOK_SECRET`;
  `publishing.custom-webhook` resolves the `PUBLISH_CREDENTIAL_` family.
- **The client payload still leaks nothing**: none of the 44 capabilities' env
  var names appears in it, none of `blockedBy`/`lastError`/`prerequisites`/
  `mockMode`/`configDetail`/`CLORO`/`DATAFORSEO`/`OPENROUTER`/`STRIPE`/`APIFY`/
  `PUBLISH_CREDENTIAL_` appears, no internal key name appears, and all six
  client-facing capabilities come back as the reduced shape (no `envVars`, no
  `lastError`, `dataSource` present).
