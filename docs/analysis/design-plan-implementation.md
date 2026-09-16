# Design Plan Implementation — Build Analysis

Source: `design_plan.md` (v1.0, 16 Sep 2026). Approved scope: **new frontend app + backend G01–G20**.
Approved 16 Sep 2026 by the project owner, who elected to proceed without a per-module
approval gate for this pass. Analysis is recorded here rather than ahead of each module.

## 1. What is being built

| Part | Location | Notes |
|---|---|---|
| New operator/client/public frontend | `web/` (NEW) | Next.js 16 App Router, TS, Tailwind 3. Route groups `(ops)`, `(client)`, `(public)`. |
| Backend work packages G01–G20 | `backend/src/modules/*` | Contracts from design_plan Appendix A. |
| Existing `frontend/` | untouched | Explicit owner instruction. |
| Existing `client-portal/` | untouched | |

## 2. Tool decisions

No new vendor or paid service is introduced. Every dependency below is already present in
the repo (`frontend/package.json` or `backend/package.json`) and is reused, not newly selected.

| Need | Chosen | Alternatives considered | Why |
|---|---|---|---|
| Frontend framework | Next.js 16 App Router | Remix, Vite+React Router | Already the house stack (`design_plan` §10.1 mandates it). |
| Styling | Tailwind CSS 3 + CSS custom properties | CSS Modules, styled-components | Matches `frontend/`; tokens in §3.1 map cleanly to CSS vars. |
| Component library | **shadcn/ui** (copy-in, on Radix) | MUI, Mantine, Chakra, hand-rolled | Copy-in source, so it adds no new runtime dependency beyond Radix + CVA + tailwind-merge, all already in `frontend/package.json`. Owning the source lets the §3.1 tokens drive it directly instead of fighting a vendor theme. MUI/Mantine/Chakra each bring their own styling runtime and design language, which would conflict with the Tailwind token system §3.1 specifies. |
| Primitives | Radix UI (via shadcn) | Headless UI, Ark | Already a dependency; supplies the focus-trap/keyboard behavior §3.4 requires. |
| Server state | Hand-rolled typed adapters + React cache | TanStack Query, SWR | §10.2 forbids adopting a new cache dependency without separate approval. |
| ORM | Prisma 5.22 (SQLite) | — | Existing. |
| Jobs | Existing BullMQ `JobsModule` | — | G07 extends it rather than replacing it. |
| Charts | Deferred | — | §10.2 requires a separate approved analysis. Tables ship first; §3.4 requires a table alternative regardless. |
| Billing (G16) | Stripe webhook contract only | — | Signed-webhook endpoint + ledger. No SDK installed this pass; unsigned stand-in disabled. |

## 3. Shared-file ownership (parallel build safety)

These files are edited by the coordinator only, never by a parallel agent:

- `backend/prisma/schema.prisma`
- `backend/src/app.module.ts`
- `web/package.json`, `web/tailwind.config.ts`, `web/src/app/globals.css`
- `CHANGELOG.md`

Every other agent works strictly inside its own module/route directory.

## 4. Backend packages and owners

| Pkg | Scope | Module dir |
|---|---|---|
| G01 | Identity lifecycle, sessions, password reset | `auth/`, `users/` |
| G02 | Client seats, invitations, delegated connections | `client-access/` (new) |
| G03 | Enforced permissions, nested resource scoping | `common/guards`, audit of existing controllers |
| G04 | Confirmed intake, business profile, onboarding requests | `business-profile/` (new) |
| G05 | Report editorial lifecycle, release, share links | `reporting/` |
| G06 | Engagements, cycles, work items, capacity, verification | `delivery-plan/` (new) |
| G07 | Durable jobs, cadence, alert lifecycle | `jobs/`, `monitoring/` |
| G08 | Messages, notifications, attachments | `notifications/` (new) |
| G09 | Editable briefs, versioned content, generation jobs | `content/` (new) |
| G10 | Approvals, claim gates | `approvals/` (new) |
| G11 | CMS/channel publishing | `publishing/` (new) |
| G12 | Budgets, reservations, spend audit | `budgets/` (new) |
| G13 | Comparable outcomes, snapshots, results | `results/` (new) |
| G14 | Portfolio aggregation, pagination, saved views | `operations/` (new) |
| G15 | Activity and audit trail | `activity/` (new) |
| G16 | Public intake, sales handoff, verified billing | `billing/` (new) |
| G17 | Export, retention, offboarding | `lifecycle/` (new) |
| G18 | Capability/readiness contract | `capabilities/` (new) |
| G19 | Contract repair (Appendix B differences) | existing modules |
| G20 | Organization, brand, templates | `organization/` (new) |

## 5. Frontend component architecture

Three layers, strictly. An agent that hand-rolls something an inner layer already provides is
doing it wrong.

```
web/src/components/
  ui/          # shadcn/ui primitives — generated, not hand-written.
               # button, input, select, dialog, table, tabs, badge, card,
               # dropdown-menu, popover, tooltip, sheet, skeleton, toast,
               # form, checkbox, radio-group, separator, scroll-area,
               # accordion, alert, avatar, calendar, command, pagination.
  patterns/    # design_plan §3.3 shared components, composed FROM ui/.
               # MetricTile, EvidenceDrawer, RunConfigurator, RunStatusStrip,
               # ScopeBanner, WorkRow, ApprovalCard, ProvenanceBadge,
               # DataTable, ConfirmDialog, CoveragePanel, ChangeComparison,
               # EmptyState, PageHeader, FilterBar.
  layouts/     # §3.2 page anatomy: AppShell, OpsShell, ClientShell,
               # PublicShell, DetailPanel, StickySectionIndex.
```

Rules:

1. **Never re-implement a `ui/` primitive.** Need a button, use `ui/button`. Variants go in the
   primitive's CVA config, not a new file.
2. **Screens compose `patterns/`; they do not style raw elements.** A screen that writes
   `<div className="rounded-xl border bg-white p-4">` should be using `ui/card`.
3. **`patterns/` own the §3.3 required behavior.** `MetricTile` always renders value + unit +
   window + source date + coverage, and refuses to render a delta when the runs are not
   comparable. That rule lives in the component, once — not in twelve screens.
4. **Tokens only.** Colors/spacing/radius come from the CSS custom properties generated from
   §3.1. No raw hex in a component.
5. **One `DataTable`.** Every table screen (§4's portfolio/library family) uses it with a
   column config. Search, sort, filter, column visibility, keyboard access, empty/error states
   and pagination are solved once.
6. Server state goes through `web/src/services/*` typed adapters. Components never call `fetch`.

## 6. Non-negotiable rules for every agent

1. Server derives or validates client/project scope. Frontend hiding is never the access control.
2. No screen renders invented data. Missing capability gives an explicit unavailable state (§3.5).
3. "Measured" / "model interpretation" / "operator supplied" / "unmeasured" stay distinguishable (§3.3 provenance badge).
4. Empty is not zero. No baseline is not a decline.
5. `npx tsc --noEmit` must pass in the directory the agent touched.
6. JSDoc on public methods; Swagger decorators on every endpoint; no `any`.
7. Reuse before you write. Check `ui/`, then `patterns/`, then write.

## 7. Known deferrals

- Charts (needs tool approval) — tables ship first.
- Stripe SDK — contract + signature verification scaffold only.
- Dark mode — §3.1 defers it explicitly.
- Real PDF artifacts — browser print is the stated initial workaround.
