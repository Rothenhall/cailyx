# Pattern components

Shared, contract-bearing components for the Cailyx web app. Each one encodes a
rule from `design_plan.md` that screens should not have to remember: the §3.3
component table, the §3.4 responsive/accessibility rules, the §3.5 common-state
copy, and the §10.4 mutation/error rules.

Two conventions hold across every component here:

- **Tokens only.** Colors come from `tailwind.config.ts` (`canvas`, `surface`,
  `foreground`, `muted-foreground`, `border`, `primary`, `success`, `warning`,
  `danger`, `info`, `unmeasured`), never a raw hex. Type uses the scale
  `text-meta | text-table | text-body | text-subsection | text-title | text-kpi`.
- **The rule lives in the component.** Where §3.3 lists a behavior, these files
  enforce it structurally (a required prop, a discriminated union, a fixed
  string) rather than documenting a convention a screen can forget.

## Contents

- UI primitives live in `src/components/ui/` (shadcn). Compose them; do not
  re-implement them.
- `ProvenanceBadge`, `StatusPill`, `Timestamp` — the original foundations.
- Run/lifecycle: `RunStatusStrip`, `RunConfigurator`, `ConfirmDialog`.
- Work and decisions: `WorkRow`, `ApprovalCard`.
- Page furniture: `PageHeader`, `FilterBar`.
- States: `EmptyState`, `ErrorState`.
- Evidence and metrics: `MetricTile`, `CoveragePanel`, `ChangeComparison`,
  `EvidenceDrawer`, `ScopeBanner`.
- Lists: `DataTable` — the one table for the whole app.

---

## ErrorState

`@/components/patterns/ErrorState` · §3.5, §10.4

Switches on `ApiError.kind` and renders that class's required *behavior*, not
just a message: a 400 links to its invalid fields, a 401 offers a session
refresh and sign-in, a 403 explains the restriction and **renders no retry
control at all**, a 404 names which kind of "not found" it is, a 409 offers
reload/compare, a 429 counts down a bounded cooldown honoring `Retry-After`,
and a 503 names the unavailable provider. Context is preserved for every other
class.

```tsx
<ErrorState
  error={error}
  onRetry={() => refetch()}
  preserveNotice="Your draft is still on this page."
/>
```

| Prop | Type | Notes |
| --- | --- | --- |
| `error` | `ApiError` | Required. Use `toApiError(unknown)` from the same module when all you have is a `catch` value. |
| `layout` | `'page' \| 'inline'` | Default `'page'`. `inline` is for a form, dialog or card. |
| `onRetry` | `() => void` | Rendered for every class **except** `invalid` and `forbidden`. |
| `retryLabel` | `string` | Overrides the per-class default (`"Refresh session"` for a 401). |
| `signInHref` | `string` | Offered alongside retry on a 401. |
| `restrictedAction` | `string` | Verb phrase for 403 copy, e.g. `"publish this report"`. |
| `permittedPath` | `string` | What the user *can* do instead (403). |
| `notFoundReason` | `'missing-or-private' \| 'missing' \| 'private' \| 'prerequisite'` | Default `'missing-or-private'`, which does not leak whether the record exists. |
| `providerName` | `string` | Named in 503 copy, e.g. `"Google Search Console"`. |
| `onReload` | `() => void` | Primary action for a 409 — reload the server version. |
| `onCompare` | `() => void` | Secondary action for a 409 — open a diff. |
| `preserveNotice` | `string` | Say what survived, e.g. `"Your draft was kept."` |
| `fieldIdPrefix` | `string` | DOM id prefix for invalid fields; default `"field-"`. Set it to match your form's ids. |
| `showServerMessage` | `boolean` | Default `true`. Shows the real server message under the fixed copy. |
| `className` | `string` | |

Also exports **`toApiError(cause: unknown): ApiError`** — normalizes a `catch`
value so a screen never branches on `unknown`.

## EmptyState

`@/components/patterns/EmptyState` · §3.5

One named variant per §3.5 empty state. **Copy is fixed per variant and is not
passed in**: a screen cannot invent its own wording, but it can add specifics
through `children`. Two variants take the fact that decides their copy as a
required prop, so the trap cannot be rendered by accident:

- `no-reports` requires `runExists` — "Your first report is being prepared" is
  only ever shown when a run actually exists; otherwise "No report has been
  created".
- `no-projects` requires `audience` — the operator sees "Add project", the
  client sees "Contact your lead".

| Variant | Required props | Optional |
| --- | --- | --- |
| `no-projects` | `audience: 'operator' \| 'client'` | `onCreate` (operator only) |
| `no-reports` | `runExists: boolean` | `action` |
| `not-measured` | `subject: string` | `prerequisite`, `action` |
| `no-comparison-baseline` | — | `action` |
| `insufficient-role` | `restrictedAction: string` | `permittedPath` |
| `source-unmapped` | `sourceName: string`, `action` | — |
| `no-results` | — | `onClearFilters` |
| `no-messages` | `viewer: 'operator' \| 'client'` | — |

All variants also accept `children`, `className`, and `layout?: 'panel' |
'inline'`. `action` is `{ label, onClick?, href? }`.

`not-measured` uses the `unmeasured` token, never `danger` — a missing
observation is not a failure. `no-results` is deliberately separate from the
"nothing exists" variants: offering "create one" to someone whose filter merely
excluded everything is a wrong answer.

## PageHeader

`@/components/patterns/PageHeader` · §3.2

Breadcrumb → title/context → **one** primary action → status. The
single-primary-action rule is an API constraint, not a convention: there is one
`primaryAction` prop, and everything else goes in `secondaryActions`.

```tsx
<PageHeader
  breadcrumbs={[{ label: 'Clients', href: '/clients' }, { label: 'Acme' }]}
  title="Acme"
  context="acme.example · Retainer · Lead: Jordan"
  status={<StatusPill label="Partial" tone="warning" />}
  primaryAction={{ label: 'Start SEO audit', onClick: start }}
  secondaryActions={<Button variant="outline">Export</Button>}
/>
```

| Prop | Type | Notes |
| --- | --- | --- |
| `breadcrumbs` | `{ label: string; href?: string }[]` | Optional; no crumbs renders no breadcrumb. |
| `title` | `string` | Required. |
| `context` | `ReactNode` | Owner, cycle, domain, market. |
| `status` | `ReactNode` | Status pills/badges under the title. |
| `primaryAction` | `PageHeaderAction` | At most one. `{ label, onClick?, href?, disabled?, disabledReason?, icon?, destructive? }`. |
| `secondaryActions` | `ReactNode` | A separate slot so they can never be styled as the primary. |
| `headingLevel` | `'h1' \| 'h2'` | Default `'h1'`. |
| `className` | `string` | |

A `disabled` primary action must carry `disabledReason`; it is rendered as text
and wired to the button with `aria-describedby`.

## FilterBar

`@/components/patterns/FilterBar` · §3.3, §10.1

Search + filter controls + a saved-view slot, over `UrlStateShape` from
`@/lib/url-state` so a copied link reproduces the view. Controlled: the screen
owns the state (usually via `useUrlState`) and needs it anyway for its fetch.

```tsx
const FILTER_DEFAULTS = { q: '', status: 'all', owner: 'all', attention: false };

const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);

<FilterBar
  defaults={FILTER_DEFAULTS}
  value={filters}
  onChange={setFilters}
  controls={[
    { kind: 'select', key: 'status', label: 'Status', options: STATUS_OPTIONS },
    { kind: 'toggle', key: 'attention', label: 'Needs attention' },
  ]}
  savedViews={<SavedViewPicker />}
  summary="Showing 24 of 310"
/>
```

| Prop | Type | Notes |
| --- | --- | --- |
| `defaults` | `UrlStateShape` | Required, and must be a **stable reference** (module constant or `useMemo`) — it is what lets the active-filter chips know what "filtered" means. |
| `value` | `UrlStateShape` | The current filter state. |
| `onChange` | `(patch: Partial<T>, opts?: { push?: boolean }) => void` | `useUrlState`'s setter can be passed straight in. It receives one single-key patch per interaction; the URL is written with `replace`, so filters do not stack up history entries. |
| `controls` | `FilterControl[]` | `select` (`allLabel`, sentinel value `FILTER_ALL`), `text`, or `toggle`. Every `key` must exist in `defaults` — `useUrlState` only decodes declared keys, so an undeclared key would vanish from a copied link. |
| `searchKey` | `string` | Default `"q"`. |
| `searchLabel` / `searchPlaceholder` | `string` | |
| `hideSearch` | `boolean` | For filter-only bars. |
| `searchDebounceMs` | `number` | Default `300`. `Enter` and blur flush immediately. |
| `savedViews` | `ReactNode` | The saved-view slot. |
| `summary` | `ReactNode` | Trailing read-only context. |
| `className` | `string` | |

Also exports **`FILTER_ALL`** (`"all"`), the select sentinel. Not implemented:
multi-select controls (array-valued URL keys are decoded by `lib/url-state`, but
no multi-select control is rendered here yet).

## RunStatusStrip

`@/components/patterns/RunStatusStrip` · §3.3, §3.4, §3.5

`queued | running | partial | completed | failed` with the named stage, counts
**only when the backend supplied them**, and the previous run's results still
readable below. Three rules are enforced in the component:

1. **No simulated progress.** No indeterminate bar or animated fill is ever
   drawn. The determinate bar appears only when `RunStage.counts` exists — the
   type marks counts optional for exactly this reason.
2. **A partial run never reads healthy.** It gets the warning tint and the
   sentence that says successful evidence is mixed with failed/deferred checks.
3. **The last successful data stays readable.** When a run is queued, running
   or failed, whatever is passed as `children` is attributed to the last
   successful run explicitly, with its id and completion time.

It also announces on status/stage change only — counts are outside the live
region, so a polling tick cannot become a screen-reader metronome (§3.4).

| Prop | Type | Notes |
| --- | --- | --- |
| `run` | `RunSummary` | Required. |
| `lastSuccessful` | `{ id: string; completedAt: string; label?: string; href?: string }` | Pass whenever a run is in flight. |
| `detail` | `ReactNode` | Failed/deferred checks and other must-stay-visible detail. |
| `children` | `ReactNode` | The results themselves. |
| `expectedMinutes` | `number` | Adds the §3.5 "taking longer than expected" note past this duration. |
| `timeZone` | `string` | IANA zone for every timestamp shown. |
| `className` | `string` | |

## RunConfigurator

`@/components/patterns/RunConfigurator` · §3.3, §10.4, §3.5

Prerequisites, scope, parameters, observed configuration availability,
estimated requests/cost, and one explicit start action. §10.4's scan/generation
row is the acceptance criteria: prerequisites, scope/cost, explicit start,
double-submit protection, timeout reconciliation.

- Start is disabled while any **blocking** prerequisite is unmet, and the
  blocking ones are named and linked next to the button.
- `RunEstimate` renders requests, credits and money as **separate rows**. There
  is no total, because there is no unit that could express one. A
  `costCurrency` with no `currencyCode` prints the amount with "(currency not
  supplied)" rather than assuming USD.
- Double-submit protection is a ref guard plus a disabled control that **stays**
  disabled after the request is accepted.
- A lost response (`startTimeoutMs`, default 60 s) never retries. It says the
  outcome is unknown, offers to check run status, and requires two deliberate
  actions to start again.

| Prop | Type | Notes |
| --- | --- | --- |
| `startLabel` | `string` | Required, and names the mutation: "Start SEO audit". |
| `prerequisites` | `ConfiguratorPrerequisite[]` | `RunPrerequisite` + `blocking?: boolean` (default `true`; `false` renders as advisory). |
| `parameters` | `RunParameter[]` | Read-only display. |
| `scope` | `ReactNode` | What the run will cover. |
| `configuration` | `ObservedConfiguration[]` | `{ label, availability, detail?, lastSuccessfulRunAt?, actionLabel?, actionHref? }`; `availability` is `'available' \| 'unverified' \| 'unmapped' \| 'unavailable'`, each with its §3.5 sentence. |
| `estimate` | `RunEstimate` | |
| `onStart` | `() => void \| Promise<void>` | Required. |
| `onStarted` | `() => void` | |
| `startTimeoutMs` | `number` | Default `60000`. |
| `onReconcile` / `reconcileHref` | `() => void` / `string` | The "check run status" recovery after a lost response. |
| `error` | `ApiError \| null` | Rendered inline. |
| `runInFlight` | `boolean` | From server state, not local memory (§10.3). |
| `timeZone` | `string` | |
| `className` | `string` | |

Also exports **`RunEstimateSummary`** (`{ estimate?: RunEstimate; className?: string }`),
used by `ConfirmDialog` so credits and currency can never be conflated in two
places.

## ConfirmDialog

`@/components/patterns/ConfirmDialog` · §3.3, §10.4

Exact target, effect, scope, and cost if known, over `ui/alert-dialog` — so
focus is trapped while open and returned to the invoker on close (§3.4), with
the `alertdialog` role a plain dialog lacks.

- `confirmLabel` is **required** and must name the action ("Delete project", not
  "OK").
- `destructive` adds destructive styling and wording, and **requires a typed
  confirmation** of `target` (or an explicit `confirmPhrase`). The confirm
  button stays disabled until the typed string matches exactly.
- No fake undo: the destructive copy states plainly that nothing can be undone.
- The dialog stays open while the request is in flight and if it fails, so a
  rejection is read in the context that produced it.

| Prop | Type | Notes |
| --- | --- | --- |
| `open` / `onOpenChange` | `boolean` / `(open: boolean) => void` | Controlled. |
| `title` | `string` | Required, e.g. "Delete project". |
| `confirmLabel` | `string` | Required. |
| `onConfirm` | `() => void \| Promise<void>` | Required. |
| `onConfirmed` | `() => void` | |
| `cancelLabel` | `string` | Default `"Cancel"`. |
| `targetLabel` / `target` | `string` | The exact record being acted on. |
| `effect` / `scope` | `ReactNode` | What happens, and how far it reaches. |
| `cost` | `RunEstimate` | Rendered by `RunEstimateSummary`. |
| `destructive` | `boolean` | Default `false`. |
| `confirmPhrase` | `string` | Overrides the required typed phrase. |
| `onReload` | `() => void` | Forwarded to `ErrorState` on a 409. |
| `children` | `ReactNode` | Extra facts under the summary. |
| `className` | `string` | |

## WorkRow

`@/components/patterns/WorkRow` · §3.3, §3.4

Deliverable, owner, due, status, blocker, linked evidence, next action. §3.4's
"cards for work lists" below 768 px is handled by the container, because a
`<tr>` cannot become a `<div>`:

- **`WorkList`** is the entry point — a semantic table at ≥768 px (scrollable in
  a labeled region) and cards below it, switched with CSS so there is no
  hydration mismatch and no flash of the wrong layout.
- `WorkRow` is the table row; `WorkTableHead` is its matching header; `WorkCard`
  is the mobile presentation.

`WorkList` renders nothing when `items` is empty: only the screen knows whether
that means "nothing exists", "not run yet", or "filtered out", and §3.5 gives
each of those different copy. Pass the matching `EmptyState`.

| Prop (`WorkList`) | Type | Notes |
| --- | --- | --- |
| `items` | `WorkItem[]` | Required. |
| `timeZone` | `string` | For due dates. |
| `onOpen` | `(item: WorkItem) => void` | Makes the deliverable a control. |
| `rowActions` | `(item: WorkItem) => ReactNode` | Per-row menu (destructive items belong here, not in a primary button). |
| `emptyState` | `ReactNode` | |
| `label` | `string` | Accessible name for the scroll region; default "Work items". |
| `caption` | `ReactNode` | |

`WorkRow` takes `{ item, timeZone?, onOpen?, actions?, className? }`; `WorkCard`
the same. Evidence links are only rendered for `http(s)` and same-origin
relative URLs — anything else is shown as text (§10.5). An overdue due date is
labelled "Overdue" in text, never by color alone, and is resolved after mount so
the server and client cannot disagree about "today".

## ApprovalCard

`@/components/patterns/ApprovalCard` · §3.3

The exact version, requestor, reviewer, due date, decision requested, and the
consequence of delay. The version is the largest element on the card and the
decision is stated to bind to it — an approval is "I approve *this version*",
not "I approve this article". Changing the artifact requires a new decision.

An unassigned reviewer and an unstated delay consequence both render as explicit
"not stated" text rather than an inviting blank.

| Prop | Type | Notes |
| --- | --- | --- |
| `item` | `ApprovalItem` | Required. |
| `timeZone` | `string` | For the due date. |
| `onDecide` | `(decision) => void \| Promise<void>` | `decision` is `'approved' \| 'changes-requested' \| 'rejected'`. |
| `allowedDecisions` | `Array<Exclude<ApprovalDecision, 'pending'>>` | Defaults to all three; narrow it for a client who cannot reject outright. |
| `href` / `onOpenVersion` | `string` / `() => void` | Opens the artifact at this version. |
| `onAssignReviewer` | `() => void` | |
| `children` | `ReactNode` | Extra context, e.g. a change summary. |
| `className` | `string` | |

Decision controls render only while `decision === 'pending'` and `onDecide` is
given, and are disabled while a decision is in flight.

---

## MetricTile

`@/components/patterns/MetricTile` · §3.3, §3.5

Value + unit, window/run, source date, coverage and evidence link, with a delta
**only when the caller has asserted a comparable baseline**. That rule is a
type, not a convention: `baseline` is `ComparableBaseline`, whose
`comparable: true` literal discriminant has to be written out at the call site,
and it is re-checked at runtime so a JavaScript caller cannot smuggle in a bare
number either.

- Measured value with no baseline → §3.5 "First measurement — a comparison will
  appear after a comparable run". (`EmptyState variant="no-comparison-baseline"`
  is the standalone page-level form of the same state.)
- `value={null | undefined | NaN}` → `notMeasuredLabel()` in the `unmeasured`
  token, badged `unmeasured` **regardless of the `provenance` prop**. Never `0`,
  never blank, never `danger`: a missing observation is not a failure.
- Delta arithmetic defaults to percentage points for `%`/`pp` units and absolute
  otherwise; `relative-percent` is never inferred, and falls back to the
  absolute change with an explicit caveat when the baseline was `0` (a relative
  change from zero is undefined — it will not print `+100%`).
- A movement the caller has not declared good stays neutral. Only
  `direction="higher-is-better"` / `"lower-is-better"` tint it, and a decline
  uses `warning`, not `danger` — `danger` stays reserved for things that broke.
- `coverage` renders through `CoveragePanel`, so a tile cannot imply a
  completeness the run did not have.
- `runHref` on its own renders a link labelled "Open run": "each number links to
  its scoped evidence" (§4) must not depend on the caller also passing a label.

| Prop | Type | Notes |
| --- | --- | --- |
| `label` | `string` | Required. |
| `value` | `number \| null \| undefined` | Required (explicitly passable as `null`). |
| `unit` | `string` | e.g. `"clicks"`, `"%"`, `"seconds"`. |
| `windowLabel` / `runLabel` / `runHref` | `string` | The reporting window and the run it came from. |
| `sourceDate` | `SourceDateInfo` | `{ date, sourceName? }`; rendered with its timezone. |
| `timeZone` | `string` | IANA zone for dates. |
| `coverage` | `CoverageSummary` | Rendered compact by `CoveragePanel`. |
| `baseline` | `ComparableBaseline` | Required shape for any delta to appear. |
| `deltaMode` | `'absolute' \| 'percentage-points' \| 'relative-percent'` | Defaults from `unit`. |
| `direction` | `'higher-is-better' \| 'lower-is-better' \| 'neutral'` | Default `'neutral'`. |
| `provenance` | `ProvenanceKind` | Ignored when the value is unmeasured. |
| `formatValue` | `(value: number) => string` | Replaces the number **and** the unit. |
| `evidenceHref` | `string` | Non-http(s)/relative targets are not rendered as links. |
| `evidence` | `ReactNode` | A caller control (e.g. an `EvidenceDrawer` trigger); wins over `evidenceHref`. |
| `note` | `ReactNode` | Prerequisite/action copy, required reading when unmeasured. |
| `isLoading` | `boolean` | Skeleton in place of the value. |
| `className` | `string` | |

## CoveragePanel

`@/components/patterns/CoveragePanel` · §3.3, §3.5

Expected versus successful checks, and **every failed and deferred source named
with its reason**. Numbers alone are never the summary:

- `expectedCount === 0` renders `notMeasuredLabel()` in the `unmeasured` token —
  not "0%".
- Failed and deferred are separate lists with separate tones: a failed source is
  a failure (`danger`), a deferred one is accepted but not measured (`warning`).
  §3.5 "Partial audit" forbids labelling the run healthy, so they are never
  merged into one count.
- If the summary claims every agreed check succeeded **and** names a source that
  did not complete, the panel flags the contradiction instead of printing a
  clean 100%. A bare "100%" that hides a failed source cannot be rendered from
  any input.
- `variant="compact"` is the same information in tight text (used inside
  `MetricTile`): smaller, never less complete — the failure names and reasons
  remain on screen.

| Prop | Type | Notes |
| --- | --- | --- |
| `summary` | `CoverageSummary` | Required. `{ expectedCount, successfulCount, failed?, deferred? }`. |
| `variant` | `'full' \| 'compact'` | Default `'full'`. |
| `title` | `string` | Default `"Evidence coverage"`; also the section's accessible name. |
| `action` | `ReactNode` | Optional next-run action (§3.3). |
| `contextNote` | `ReactNode` | Why sources failed or were deferred. |
| `className` | `string` | |

Server-renderable: the only interactivity is the `action` slot the caller
supplies.

## ChangeComparison

`@/components/patterns/ChangeComparison` · §3.3, §6.4 (G13)

Before/after id and date, the change, its unit, methodology compatibility and the
deployments inside the window. The check is `data.methodologyCompatible === true`,
not truthiness, so a caller who forgot to declare comparability gets the
conservative answer.

- **Methodology break**: when the flag is false the card says so prominently ("Not
  comparable — withheld" plus a warning block naming the comparison key), renders
  the two values side by side with their dates, and **renders no change figure and
  no direction arrow at all**. The implied clean delta cannot be drawn.
- Percentage points and relative percentages are separate branches. A `%` metric
  defaults to `formatPercentagePoints` ("+5 pp") and the card says in words that
  it is not a relative change; `relative-percent` must be asked for explicitly and
  falls back to the absolute change (with a caveat) when the before value is `0`.
- Relevant deployments are labelled as context only — a change landing in the
  same window is not evidence of cause (§6.4).

| Prop | Type | Notes |
| --- | --- | --- |
| `data` | `ChangeComparisonData` | Required: `{ before, after, unit, methodologyCompatible, relevantDeployments? }`. |
| `changeMode` | `'absolute' \| 'percentage-points' \| 'relative-percent'` | Defaults from `unit`. |
| `direction` | `'higher-is-better' \| 'lower-is-better' \| 'neutral'` | Default `'neutral'`. |
| `formatValue` | `(value: number, unit: string) => string` | |
| `methodologyNote` | `ReactNode` | What changed in the comparison key. |
| `timeZone` | `string` | |
| `className` | `string` | |

Server-renderable (no client hooks).

## EvidenceDrawer

`@/components/patterns/EvidenceDrawer` · §3.3, §3.4, §10.5

Source URL/run, captured time, observed fact, interpretation, raw answer/check,
confidence and related gap/work, built on `ui/sheet`.

- **Overlay below 1200 px, docked panel at or above it** (`variant="auto"`). The
  overlay is a real dialog: focus trapped and returned to the invoker, Escape
  closes it. The desktop panel is non-modal on purpose so the data being checked
  stays readable; it still moves focus in and hands it back (and closes on
  Escape). Force either with `variant="overlay" | "panel"`.
- **Raw evidence is escaped text.** It renders as `{raw.text}` inside the
  `.evidence` utility (monospace, `whitespace-pre-wrap`) — there is no prop that
  accepts HTML, so fetched markup cannot become trusted application markup
  (§10.5).
- Observation and interpretation are separate props with separate provenance
  badges (`interpretationKind`, default `model-interpretation`), so a model's
  reading cannot be presented as the fact.
- Confidence is qualitative (`high | medium | low | unknown`) and never borrows
  `success`/`danger`; an unestablished confidence reads as `unmeasured` (§6.4
  forbids inventing significance).
- Outbound links are scheme-checked: a non-http(s)/relative URL renders as text
  labelled "(not a link: unsupported URL scheme)".

| Prop | Type | Notes |
| --- | --- | --- |
| `open` / `onOpenChange` | `boolean` / `(open: boolean) => void` | Required, controlled. |
| `title` | `string` | Required; the drawer's accessible name. |
| `source` | `EvidenceSource` | `{ name, capturedAt, runId?, url?, query? }`. |
| `observed` | `ReactNode` | Required. The fact. |
| `interpretation` | `ReactNode` | The reading of the fact. |
| `interpretationKind` | `ProvenanceKind` | Default `'model-interpretation'`. |
| `raw` | `EvidenceRaw` | `{ label?, text }` — plain text only. |
| `confidence` | `EvidenceConfidence` | `{ level, basis }`; `basis` is required so a level is never bare. |
| `related` | `EvidenceRelatedLink[]` | `{ label, href?, kind? }`, `kind` ∈ `gap \| work \| run \| report \| deployment`. |
| `provenance` | `ProvenanceKind` | Provenance of the evidence itself. |
| `trigger` | `ReactNode` | Optional trigger element. |
| `variant` | `'auto' \| 'overlay' \| 'panel'` | Default `'auto'` (viewport-driven). |
| `timeZone` | `string` | |
| `className` | `string` | |

Also exports `EvidenceSource`, `EvidenceRaw`, `EvidenceConfidence`,
`EvidenceRelatedLink`.

## ScopeBanner

`@/components/patterns/ScopeBanner` · §3.3, §3.4

Client, domain, market, project, run/version and live-versus-snapshot mode.
Absent fields are omitted rather than rendered blank.

- **Snapshot mode is unmistakable**: a warning-toned strip with a leading accent
  border, a "Frozen snapshot" label, a screen-reader sentence saying this is not
  live data, and copy stating that the figures are the released version, that
  later data is not included, and that later runs do not change them. Live mode
  stays deliberately quiet so the loud treatment keeps meaning something.
- Deliberately **not** `no-print`: §3.4 requires printed reports to carry
  explicit snapshot context, so the banner survives to paper.
- Server-renderable; `actions` is a slot (not callbacks) for that reason.

| Prop | Type | Notes |
| --- | --- | --- |
| `scope` | `ScopeContext` | Required: `{ clientName?, domain?, market?, projectName?, runLabel?, mode, snapshotLabel? }`. |
| `actions` | `ReactNode` | Right-hand controls, e.g. a link back to live scope. |
| `sticky` | `boolean` | Default `false`; pins the §4 run/evidence header. |
| `className` | `string` | |

## DataTable

`@/components/patterns/DataTable` · §3.3, §3.4, §10.5

The one table for the whole app (§4 portfolio/library family): `ColumnDef`
config, search, filter, sort, column visibility, keyboard access, row detail,
empty **and** error states, and server pagination when the caller supplies it.

- **Empty and error are separate props and the error always wins.** A failed
  request can never render as "no records yet" — the error branch is its own
  `<tbody>` branch, so it cannot fall through to the empty state.
- **Last known state survives a failed refresh.** With rows already loaded, a
  failed refresh keeps them on screen under an explicit banner rather than
  blanking the table (§3.5).
- **Local filters are labelled as local.** When `pagination` is supplied, a
  search or filter applies only to the rows on the loaded page, and the table
  says so — no fabricated global totals (§10.5).
- **Scroll region**: the table is wrapped in a labeled, focusable
  `.table-scroll-region` (`role="region"`, `tabIndex={0}`) so a wide table can
  be scrolled from the keyboard (§3.4). `ui/table`'s inner overflow container is
  neutralised so the region itself is the scroller. Use `minTableWidth` (e.g.
  `"60rem"`) to make it actually scroll instead of squashing columns.
- **Sorting** is three-state (asc → desc → cleared), exposed with `aria-sort` on
  the header cell. Empty values sort last in both directions: a missing
  measurement is not the smallest measurement.
- **Selection** and **column visibility** are controlled when you pass
  `selectedIds` / `hiddenColumns`, uncontrolled otherwise. `Select all` acts on
  the current page with an `indeterminate` state, and the last visible column
  cannot be hidden.
- **Row detail** (`rowDetail`) renders an accessible extra row: the toggle
  carries `aria-expanded` + `aria-controls`. `rowHref` puts a real link in
  `linkColumnKey` (first visible column by default) so keyboard users can open
  the routed detail; the row click is a pointer convenience layered on top.
- A null/undefined accessor value renders `notMeasuredLabel()` in the
  `unmeasured` tone; override per column with `emptyLabel` for non-measurement
  fields. Empty is never rendered as zero or a blank cell.
- Pagination footer shows a range only when the page size is known (client
  paging); with server pagination it reports the page and the server's total.

| Prop | Type | Notes |
| --- | --- | --- |
| `columns` | `ColumnDef<T>[]` | Required. |
| `rows` | `T[]` | Required — the rows the caller has loaded. |
| `getRowId` | `(row: T) => string` | Required. |
| `caption` | `string` | Screen-reader-only `<caption>` and the default region label. |
| `ariaLabel` | `string` | Overrides the scroll region's name. |
| `searchable` | `boolean \| ((row: T, query: string) => boolean)` | Matches every column's `accessor`/`searchText` by default. |
| `searchPlaceholder` | `string` | Default `"Search"`. |
| `filters` | `DataTableFilter<T>[]` | `{ id, label, options, match?, getValue? }`; each renders as a `Select` with an "All …" reset. |
| `selectable` | `boolean` | Adds the selection column. |
| `selectedIds` / `defaultSelectedIds` / `onSelectionChange` | `string[]` / `string[]` / `(ids: string[]) => void` | Controlled / uncontrolled selection. |
| `bulkActions` | `(selectedIds: readonly string[]) => ReactNode` | Rendered while rows are selected. |
| `selectRowLabel` | `(row: T) => string` | Accessible name of a row's checkbox; defaults to the row id. |
| `sort` / `defaultSort` / `onSortChange` | `SortState \| null` / `SortState` / `(sort) => void` | Controlled / uncontrolled. |
| `hiddenColumns` / `onHiddenColumnsChange` | `string[]` / `(keys: string[]) => void` | Controlled / uncontrolled visibility. |
| `rowDetail` | `(row: T) => ReactNode` | Inline detail row. |
| `rowHref` / `linkColumnKey` / `onRowClick` | `(row: T) => string` / `string` / `(row: T) => void` | Routed detail. |
| `pagination` | `DataTablePagination` | `{ page, pageCount, onPageChange, totalRows?, isFetching? }` — server paging. |
| `pageSize` | `number` | Client-side paging (mutually exclusive with `pagination`). |
| `error` | `Error \| string \| null` | Wins over `emptyState`. |
| `onRetry` | `() => void` | Retry control in both error presentations. |
| `emptyState` / `emptyMessage` | `ReactNode` / `string` | `EmptyState variant="no-results"` belongs here. |
| `isLoading` | `boolean` | Skeleton rows when nothing is loaded yet. |
| `toolbar` | `ReactNode` | Extra controls (e.g. a primary "New project"). |
| `minTableWidth` | `string` | Forces horizontal scrolling in the labeled region. |
| `className` | `string` | |

`ColumnDef<T>`: `key` (required, also the sort/visibility id), `header`,
`accessor`, `sortable`, `align`, `render`, `width`, plus `sortValue`,
`searchText`, `emptyLabel`, `defaultHidden`, `alwaysVisible`,
`headerClassName`, `cellClassName`.

Not implemented: multi-column sort, drag-to-reorder columns, CSV export, and row
virtualization (large sets should be paginated by the server instead).
