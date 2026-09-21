# Engagement / Timeline Model (Phase C3) — Analysis & Recommendation

> Status: **implemented 2026-09-21 — Option B.** Option A (below) was approved first and tried,
> then rejected on inspection: `Cycle` is a recurring ~30-day work-period concept, not a linear
> engagement stage (`plan/page.tsx` already carried a deliberate comment explaining why it renders
> `Cycle` to the client as "work period" for exactly this reason), so relabeling it client-facing
> would have meant distorting its real semantics rather than adding a clean grouping. Built instead:
> a new, minimal `Phase` model (name, order, a display-only status) that `Cycle`/`Commitment`
> optionally reference via a nullable `phaseId` — no new lifecycle, no new approval mechanics, it
> inherits everything `Commitment`/`ApprovalRequest` already enforce. Full write-up:
> `backend/src/modules/delivery-plan/README.md` ("Phases (C3, Option B)" section) and
> `docs/MODULES-STATUS.md`'s Wave 7 C3 entry (build details, endpoints, e2e verification). This
> doc's own §2 Option B writeup below is what was actually built; §3.3's phase-name-vocabulary
> question was resolved as "suggested, not locked in" (`SUGGESTED_PHASE_NAMES`).
>
> Required by
> `docs/PLAN.md` §11.3 and `docs/analysis/client-portal.md` §10, both of which explicitly say
> C3 needs its own analysis pass — DB shape, module ownership — before implementation. This is
> that pass.
>
> **Headline finding: the premise `client-portal.md` §10 was written under is wrong.** That
> section assumed the Phase/Milestone/Approval model is net-new work, because
> `Project.onboardingStatus`/`onboardingStep` were the only progress fields anyone had checked
> at the time. They aren't the only ones. Two already-built, already-live modules cover almost
> all of what §10 asked for. This doc's job is to say so before anyone builds a second, parallel
> system — which is exactly the mistake the original `client-portal.md` v0.1 draft made once
> already (a big proposed `Engagement`/`Phase`/`Milestone`/`Approval` system, built in a
> different, leaner shape than planned, documented as such in this same analysis chain).

## 1. What already exists (verified by reading the code, not assumed)

### 1.1 `approvals` module — this **is** the Approval primitive §9/§10 asked for

`backend/src/modules/approvals/`. Already does everything §9 scoped for "content before
publish":
- `ApprovalRequest` binds to one exact artifact revision; a decision records that the decider
  actually saw that revision; a newer revision invalidates an outstanding request rather than
  inheriting its consent.
- `ApprovalsService.assertReadyToPublish()` is the single gate both `publishing` and
  `reporting` call before anything ships — a blocked or unresolved approval cannot be bypassed
  by hitting a different endpoint.
- **Already client-facing**: `GET /api/portal/approvals`, `GET /api/portal/approvals/:id`,
  `POST /api/portal/approvals/:id/decision`, scoped by JWT `clientId`, 404 (not 403) on a
  request that isn't theirs.
- Already wired as the real publish gate for both `publishing` (G11) and `reporting`'s
  `ReportLifecycleService.publish()` (G05).

**There is no remaining backend work for "content before publish" approval.** It's built,
live, and already the thing other modules gate on.

### 1.2 `delivery-plan` module — this **is** most of the Phase/Milestone concept §10 asked for

`backend/src/modules/delivery-plan/` (G06 + P01 + P11). Storage: `Engagement → Cycle →
WorkItem`, plus `Milestone`, `CapacityAllocation`, `Commitment`, `AcceptanceCheck`,
`Verification`. Already does almost exactly what §10 described as the target shape:

- **"A real project timeline, not a status string"** — §10's own words — is already the
  module's explicit purpose statement: *"what we said we'd do, who is doing it, how completion
  is verified, and what the client is allowed to see of it."*
- **`Commitment`** already has the exact discipline §10 wanted for milestones/approvals: status
  `draft → proposed → agreed → active → needs-attention → completed → closed → cancelled →
  superseded`, where `agreed` and `completed` are **unreachable via a generic status PATCH** —
  `agreed` requires `POST .../commitments/:id/agree` (a real client confirmation, not an
  operator writing the plan on the client's behalf — §6.3's rule, already enforced), and
  `completed` requires verified progress or an outcome metric, not a checkbox.
- **Client-safe portal projections already exist** (P01): every portal response goes through
  its own allowlist function, never a filtered spread of the internal record.
- **A "needs-your-action" queue already exists** (P11, §5.6): `GET
  …/portal/projects/:id/actions` already surfaces `ApprovalRequest`s assigned to the client
  plus open `OnboardingRequest`s in one place — this is functionally the thing §21 of
  `client-portal.md` (admin visibility of onboarding progress) and the client-side mirror of it
  both want, already built.
- **A client-facing UI already consumes it**: `web/src/app/(client)/client/projects/[projectId]/plan/page.tsx`
  exists today. Not verified in this pass whether its current design reads as a "timeline" in
  the way §10 envisioned, or needs UI work — that's a real open item, not a false claim of
  completeness (see §3 below).
- The operator side has real, apparently-mature pages already: `(ops)/projects/[projectId]/{cycles,roadmap,actions,work}`.

### 1.3 What's genuinely NOT covered by the above — the actual remaining gap

- **"Phase" as a client-facing label doesn't exist yet.** `delivery-plan` has `Engagement` and
  `Cycle`, not a concept literally named "Phase." Whether `Cycle` already IS what a client
  should see as a phase (e.g., "your current cycle" reads fine as "your current phase"), or
  whether a genuinely new, thin grouping label is needed on top of `Cycle`/`Commitment`, is the
  one real design question left — see §2.
- **Rothenhall's own `Diagnose → Build → Operate → Compound` marketing language** (from
  `/about`) isn't used anywhere in `delivery-plan`. Whether to adopt it as the client-facing
  phase vocabulary, or leave `delivery-plan`'s own terms as-is, is a naming decision, not a
  schema one.
- **Query-set/competitor-change requests being routed through this system** — §9 of
  `client-portal.md` scoped "query-set/competitor changes" as a *removed* approval type (they're
  direct-edit now, per the §12 correction), so this is moot; no gap here after all.
- **Whether `plan/page.tsx`'s current design actually reads as "a real project timeline"** to a
  client, or needs restyling/restructuring — a UI-quality question, not a backend gap.

## 2. The one real decision: how to expose "Phase" to the client

Three options, all building on `delivery-plan` — **none of them propose a new
Phase/Milestone/Approval system from scratch**, because that premise is now known to be wrong.

### Option A — `Cycle` already is "Phase"; just relabel it client-facing (recommended)
Treat `delivery-plan`'s existing `Cycle` concept as the client-facing "Phase." No new model, no
migration. Work is limited to: (a) the client portal's presentation layer (`plan/page.tsx` and
its API mapper) rendering `Cycle` under a "Phase" label with plain-English framing, and
optionally (b) adding an optional display-name field to `Cycle` if operators want to label a
given cycle "Diagnose" vs. a generic cycle number. **Pros:** smallest possible change, zero
schema risk, reuses a module that's already e2e-verified (`portal-plan.smoke.sh`,
`thirty-day-plan.smoke.sh`). **Cons:** `Cycle` may carry connotations (a recurring
sprint/billing-period cadence) that don't map 1:1 onto a linear four-phase engagement narrative
— needs a quick look at how `Cycle` is actually used operationally before assuming the mapping
is clean.

### Option B — add a thin `Phase` label as a grouping layer above `Cycle`
A new, small model: `Phase` (name, order, projectId) that `Cycle`/`Commitment` rows optionally
reference, purely for client-facing grouping/display — no new lifecycle, no new approval
mechanics, it inherits everything from what `Commitment`/`ApprovalRequest` already enforce.
**Pros:** clean separation between "how the delivery-plan module organizes its own operational
work" (Cycle) and "how a client is told their engagement is structured" (Phase) — avoids
Option A's risk of leaking internal cadence language into client-facing copy. **Cons:** one new
model + migration, plus updating whichever queries need to join through it; more surface area
than Option A for what might turn out to be a cosmetic problem.

### Option C — don't build a phase concept at all; ship the `needs-your-action` queue as the
timeline
Per §10's actual bar ("a real project timeline, not a status string"), argue that P11's
needs-your-action queue plus `Commitment`'s own status lifecycle already clears that bar without
any "Phase" grouping concept — a client sees what's outstanding, what's agreed, what's done,
chronologically, without needing a phase label at all. **Pros:** zero new work. **Cons:** doesn't
match the specific language decided in `client-portal.md` §10 ("Phase — a named stage of the
ongoing engagement"), and the marketing site's own case-study framing implies clients expect to
know "which stage" they're in, not just a flat action list — this option risks under-delivering
on what was actually asked for.

**Recommendation: Option A first, fall back to Option B if the `Cycle`→"Phase" mapping turns out
genuinely awkward once someone looks closely at `Cycle`'s real operational semantics.** Don't
build Option B pre-emptively — the whole point of this analysis pass is to stop building things
speculatively.

## 3. What's left before this can be called "done"

Not code — verification and a small decision:
1. Read `delivery-plan.service.ts`'s `Cycle` handling closely enough to confirm Option A's
   mapping is sound (or isn't) — a short, targeted look, not a rebuild.
2. Read `plan/page.tsx` as it exists today and assess whether it already reads as a timeline to
   a client, or needs presentation-layer work (copy, layout) — separate from any backend
   decision above.
3. Decide whether to adopt `Diagnose → Build → Operate → Compound` as the actual phase-name
   vocabulary, or leave it operator-defined per client (a simple product-copy decision, not an
   engineering one).

## 4. Module ownership

No new module. Everything here extends `delivery-plan` (for Option A/B) and reads `approvals`
as-is (already complete). This directly satisfies `client-portal.md` §10's own instruction not
to propose "whether this lives in the existing `clients`/`client-portal` modules or a new
`engagement` module" without grounding — the grounded answer is neither: it's `delivery-plan`,
a module that wasn't even in view when §10 was written.

## 5. What this changes in `docs/PLAN.md` §11.3 and `docs/MODULES-STATUS.md`

If this doc is approved as-is, Phase C3 shrinks from "design and build a new
Phase/Milestone/Approval system" to "a short verification pass on `Cycle` (§3.1), a
presentation-layer look at `plan/page.tsx` (§3.2), and one product-copy decision (§3.3)" —
which is small enough that it likely doesn't need its own dedicated subagent the way C1/C2/C5
did. Once approved, `PLAN.md` §11.3 and `MODULES-STATUS.md`'s Wave 7 should be updated to
reflect this, and the "Baseline report" work (§25 of `client-portal.md`, previously listed as
depending on C3) should be re-checked against `reporting`'s existing delta machinery the same
way this doc re-checked C3 — it may turn out smaller than assumed too, for the same reason.

---

**Approved 2026-09-20: Option A.** Proceeding with the §3 verification/decision items as Phase
C3's actual (small) scope.

**Update, 2026-09-21: Option A rejected after the §3.1 verification pass** (`Cycle`'s recurring
work-period semantics do not map onto a linear engagement stage — see the status line at the top
of this doc), **Option B approved and implemented instead.** See
`backend/src/modules/delivery-plan/README.md` and `docs/MODULES-STATUS.md`'s Wave 7 C3 entry for
the build, endpoints and e2e verification.
