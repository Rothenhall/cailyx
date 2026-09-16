# Frontend screen brief — Cailyx `web/`

Read this before writing any screen. It supplements
`docs/analysis/AGENT-BRIEF.md` with the `web/`-specific conventions.

The spec is `design_plan.md` §4 (screen inventory, line 341+) and the layout-family
table at the top of §4. Every screen below names the family it belongs to; that
table row is the screen's contract.

---

## 1. What already exists — read it, do not rebuild it

### Primitives — `src/components/ui/` (30 files)
shadcn/ui. **Never hand-edit these, never re-implement one.** Variants go in the
primitive's own CVA config if genuinely needed — and report that, don't just do it.

`accordion alert alert-dialog avatar badge breadcrumb button calendar card
checkbox command dialog dropdown-menu form input label popover progress
radio-group scroll-area select separator sheet skeleton sonner switch tabs
table textarea tooltip`

### Patterns — `src/components/patterns/` (19 files)

| File | Exports | Use it for |
|---|---|---|
| `MetricTile` | `MetricTile` | Any single measured value |
| `DataTable` | `DataTable`, `ColumnDef`, `DataTableFilter` | **Every list/table screen** |
| `CoveragePanel` | `CoveragePanel` | Expected vs successful checks |
| `ChangeComparison` | `ChangeComparison` | Before/after with methodology check |
| `EvidenceDrawer` | `EvidenceDrawer` | Source/run/observation detail |
| `ScopeBanner` | `ScopeBanner` | Client/domain/market/run context |
| `RunStatusStrip` | `RunStatusStrip` | queued/running/partial/completed/failed/cancelled |
| `RunConfigurator` | `RunConfigurator`, `RunEstimateSummary` | Prerequisites → estimate → explicit start |
| `ConfirmDialog` | `ConfirmDialog` | Destructive/exact-target confirmation |
| `WorkRow` | `WorkRow`, `WorkCard`, `WorkTableHead`, `WorkList` | Work items (**use `WorkList`**) |
| `ApprovalCard` | `ApprovalCard` | A decision bound to a version |
| `PageHeader` | `PageHeader` | breadcrumb → title → one primary action |
| `FilterBar` | `FilterBar`, `FILTER_*` | URL-state filters |
| `EmptyState` | `EmptyState` | §3.5 empty variants (see below) |
| `ErrorState` | `ErrorState`, `toApiError` | Switches on `ApiError.kind` |
| `ProvenanceBadge` | `ProvenanceBadge` | measured / model / operator / unmeasured |
| `StatusPill` | `StatusPill`, `runStatusTone`, `workStatusTone`, `approvalDecisionTone`, `RUN_STATUS_LABEL`, `WORK_STATUS_LABEL`, `APPROVAL_DECISION_LABEL` | Every status |
| `Timestamp` | `Timestamp` | **Every** date/time (always shows zone) |
| `MessageThread` | `MessageThread` | Conversation threads |

**`src/components/patterns/README.md` documents every prop.** Read it — it is
32 KB of exact signatures. Do not guess a prop name; when this build started,
three screens were written against invented props and all three failed to compile.

### Layouts — `src/components/layouts/`
`AppShell`, `OpsShell`, `ClientShell`, `PublicShell`. **The layouts you need
already exist** — do not create a new `layout.tsx`. Existing route-group layouts:
`(ops)/ops/`, `(ops)/projects/`, `(client)/client/`, `(client)/client/projects/`.

### Lib — `src/lib/`
- `api.ts` — `api.get/post/put/patch/delete`, `unwrap`, `ApiError`, `ApiErrorKind`
- `session.ts`, `format.ts` (percentage points vs relative percent; credits vs
  currency; `notMeasuredLabel()`), `url-state.ts`, `status-tones.ts`
  (`clientStatusTone`, `projectStatusTone`, `reportStatusTone`, …),
  `work-mapping.ts`, `navigation.ts`, `utils.ts` (`cn`)

### Services — `src/services/`
`approvals clients integrations jobs messages operations portal projects reports
research types`

---

## 2. What you must create

For each screen: **a `page.tsx` under your assigned route directory**, plus
**one service adapter file** for the endpoints it needs.

A screen is three things and nothing more:
1. A typed service adapter (`src/services/<your-name>.ts`) that calls `api.*`
   and normalizes the envelope.
2. A `page.tsx` that composes `patterns/` and `ui/` — **it does not style raw
   elements and does not call `fetch`.**
3. A loading skeleton, an `ErrorState`, and the right `EmptyState` variant.

---

## 3. Hard rules

1. **Reuse before you write.** Check `patterns/`, then `ui/`, then write. A
   screen containing `<div className="rounded-xl border bg-white p-4">` is
   wrong — that is `ui/card`.
2. **Tokens only.** `canvas`, `surface`/`surface-raised`/`surface-sunken`,
   `foreground`, `muted-foreground`, `border`/`border-strong`,
   `primary`/`success`/`warning`/`danger`/`info`/`unmeasured` (each with
   `-subtle` and `-foreground`). Type: `text-meta|table|body|subsection|title|kpi`.
   **Never a raw hex.**
3. **No invented data.** No mock arrays, no placeholder numbers, no lorem ipsum.
   If an endpoint does not exist, render an explicit `not-measured` /
   `source-unmapped` state naming the prerequisite.
4. **Empty is not zero.** A missing measurement is `notMeasuredLabel()`, never
   `0`. **No baseline is not a decline.** `MetricTile` enforces this — pass
   `value={null}` and it does the right thing.
5. **Every number links to its evidence.** §4's overview family requires it.
6. **Filters live in the URL** (`useUrlState`) so a copied link reproduces the view.
7. **§3.4 accessibility, always:** keyboard reachable, visible focus, semantic
   headings/tables, dialogs trap and restore focus, error summaries link to the
   offending field, required fields stated in text not colour, timezone on every
   timestamp.
8. **`npx tsc --noEmit` and `npm run build` must pass** before you finish.

## 4. Files you must NOT touch

Any file another agent may be editing. Specifically:

- `src/components/ui/**`, `src/components/patterns/**`, `src/components/layouts/**`
- `src/lib/**` (all of it), `src/types/index.ts`
- `src/services/types.ts` and any existing service file
- `web/package.json`, `tailwind.config.ts`, `src/app/globals.css`, `next.config.ts`
- `src/app/(auth)/**`, `src/app/(public)/**`
- Any `page.tsx` or route directory not assigned to you

Need a change in one of those? **Report it in your final message** with the exact
file and what you need. Do not edit it.

## 5. `EmptyState` variants — use the right one

`no-projects` (requires `audience`), `no-reports` (requires `runExists`),
`not-measured` (requires `subject`, optional `prerequisite`), `no-comparison-baseline`,
`insufficient-role`, `source-unmapped`, `no-results`, `no-messages` (requires
`viewer`), `no-work` (requires `scope`).

`no-results` means *a filter excluded everything*. If your list is unfiltered and
empty, that variant's copy is a lie — pick another or report that you need a new one.

## 6. Reporting back

State plainly: screens built (with routes), endpoints consumed, what you could not
build and why, any pattern/service change you need, and anything you rendered as an
explicit unavailable state. Do not claim a build passed that you did not run.
