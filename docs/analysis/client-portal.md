# Client Portal + Admin Console — Current State & Decided Scope

> Status: v1.3, 2026-09-20 (four discovery passes with the user on the same day: v1.0 the
> initial admin/client scope discussion; v1.1 walked the full admin-creates-client → Day-1
> pipeline → client-onboarding-wizard → ongoing portal flow end to end against
> `mindmap.excalidraw`'s Day-1 pipeline flowchart; v1.2 and v1.3 are two successive "think past
> what was asked" passes — edge cases, failure modes, security, and lifecycle questions nobody
> had raised yet, §15–34 below). Several decisions below **override** earlier versions of this
> same doc, from earlier the same day — marked explicitly where that happens rather than
> silently rewritten. Supersedes `client-portal.md` draft v0.1 (2026-09-05).
> Convention note: this doc still satisfies the `AGENTS.md` "analysis before code" gate, but
> it is **not** gating a choice between external tools/services — nothing new is being
> installed or paid for here. It exists to (a) record, in one place, what the
> `clients` / `client-access` / `client-portal` / `organization` / `billing` / `users` /
> `operations` modules already do, since none of that was ever written up, and (b) set the
> scope for the pieces of this that are genuinely **not built yet**: the richer engagement
> timeline (§10), the gated onboarding wizard + Google-connect gate + auto-email (§2/§11), the
> prompt request queue (§13), and content requests (§14). Each needs its own follow-up build
> pass and its own AGENTS.md post-completion checklist — this doc is that work's spec, not its
> implementation.
>
> The original v0.1 draft proposed a much larger system (multi-seat `Account`, an
> `Engagement`/`Phase`/`Milestone`/`Approval`/`Escalation` timeline, a publish-gated
> `ClientSnapshot` read model, a 5-phase build order gated on ~9 open decisions, and a
> Postgres migration). Per `backend/src/modules/clients/README.md`'s own "What this is NOT"
> section, none of that was built — the team shipped a leaner model directly from a verbal
> ask instead, explicitly bypassing that draft. This doc replaces the draft with what's real.

---

## 0. Product scope (decided 2026-09-20)

- **Cailyx stays an internal Rothenhall tool with a client portal.** There is no public
  self-serve signup. A client only ever gets in through an admin-created invite. The pricing
  page's "Get Started" buttons routing to `/contact` — not a checkout — is consistent with
  this; it is sales-assisted marketing copy, not evidence of a missing feature.
- **White-labeling is dropped, not deferred.** PRD.md previously named a future "white-label
  partner" persona and asked (§17) whether multi-tenant branding should be reserved in the
  data model now. Decision: no — design single-tenant, Rothenhall-branded only. Don't spend
  effort reserving architecture for a partner-branding future that isn't going to happen.
- **The free public "AI Visibility Score" diagnostic (marketing site) is explicitly out of
  scope here.** It does not feed or link into the authenticated app. If a free-diagnostic lead
  converts, an admin manually creates a real `Client` — there is no automatic carry-over of
  the free run's baseline. (This does not resolve PRD §17's own open question about that
  free/`scorecard` funnel's public-vs-operator-only status — that's a separate, still-open
  decision this conversation didn't touch.)

## 1. Client / brand data model — ✅ already built, matches decision

**Decision:** one `Client` account can own multiple `Project`s (brands), up to whatever limit
the plan implies — e.g. a fund tracking several portfolio companies is one `Client` with
several `Project`s, not several `Client` records. This is exactly the existing shape:
`clients/clients.service.ts` creates a `Project` under a `clientId`, and `GET /clients/:clientId`
returns the client plus its projects. No schema change needed.

## 2. Client onboarding flow — ⚠️ revised 2026-09-20 (v1.1): the admin-side half is built, the
   client-side half is now a bigger, gated wizard that does not exist yet

**Admin side — ✅ already built, confirmed correct as-is:**

1. Admin fills in company name, a one-line description (optional), the company **website
   URL** (the one genuinely required field beyond identity), and a primary contact
   (name + email).
2. `POST /clients` creates the `Client`; `POST /clients/:clientId/projects` creates the first
   `Project` and kicks off the Day-1 pipeline in the background — the full flowchart in
   `mindmap.excalidraw`: discovery & data gathering → external presence & reputation →
   technology & marketing stack → SEO & technical audit → search/AEO discoverability →
   market & geographic analysis → competitor discovery & analysis → findings & opportunity
   analysis → strategy & recommendations → keyword research → marketing & growth execution →
   final output (a compiled report). This matches, stage-for-stage, the already-built engine
   modules (`technical-audit`, `digital-presence`, `competitors`, `gap-analysis`,
   `business-profile`, `backlinks`, `keyword-research`, `seo-audit`, etc.) — nothing new needed
   here.

**What's new work — ❌ not built, this is real net-new scope:**

3. **Auto-email on pipeline completion.** Today, "the Day-1 pipeline finishes" and "the client
   gets portal access" are two separate, manually-triggered things — nothing currently watches
   for pipeline completion and fires an email. Decision: when the Day-1 pipeline completes, the
   system automatically sends the client an email — not a PDF, not the report as an attachment —
   just "your Cailyx portal is ready, click here to log in," using the **invite-link flow**
   (`POST /clients/:clientId/invites`, `client-access` module — 7-day single-use link, client
   sets their own password, no plaintext credential ever sent). This is a deliberate choice
   over the `clients` module's alternate `POST /clients/:clientId/login` temp-password
   mechanism, which stays unused going forward per this decision (not deleted, just not the
   path this auto-email uses).
4. **A gated, sequential onboarding wizard** replaces today's single all-in-one
   welcome-checklist page (`web/.../welcome/page.tsx`, CP04) for a client's first visit. Order:
   **(a) confirm/edit gathered details → (b) connect Google Search Console → (c) connect Google
   Analytics 4 → done.** Step (a) shows what the Day-1 pipeline already gathered — company
   description, competitors, category/business type, target markets — as pre-filled, directly
   editable fields (§12), not a blank intake form and not the raw query-set prompts (those stay
   in §13, visible but separately request-only). **The whole wizard is a hard gate**: the client
   cannot see their Day-1 report or use the rest of the portal until all three steps are done —
   this reverses v1.0 of this doc, which had recorded Google-connect as optional/nudged only.
   Today's welcome-checklist page (§11 of v1.0) becomes this wizard's replacement, not an
   addition alongside it — CP04 as it exists today (single page, all sections, non-blocking) is
   superseded by this decision.

## 3. Initial query set — decided, not yet built as a distinct step

**Decision:** the operator drafts the first query set (buyer questions) during onboarding,
before the client's first login. Unlike competitors/description/category/markets (§12, now
directly client-editable), **the prompt list itself stays read-only for the client** — visible,
but changed only through the lightweight request mechanism in §13, not edited in place and not
part of the onboarding wizard's confirm-details step. Today, nothing pauses the Day-1 pipeline
for any client review; that's unchanged and still correct — there's no "approve the starter
query set" gate. What's gated is the wizard in §2, which covers the editable facts, not the
prompts.

## 4. Client portal scope — decided

All four selected as in-scope for the client:

- **AI Visibility Score + reports** — ✅ already built (`GET /portal/reports`,
  `GET /portal/reports/:slug`). Report format decision (below) extends this.
- **Engagement timeline & approvals** — ❌ not built; this is §6, the real net-new work.
- **Messaging with their operator** — ✅ already built (`GET`/`POST /portal/messages`).
- **Billing & plan visibility** — ✅ already built and further along than expected (see §7):
  `GET /portal/billing/subscriptions`, `/entitlements`, `/invoices`,
  `/customer-portal` (which honestly reports `{available: false, reason}` rather than a URL
  that doesn't work, since there's no live Stripe customer portal wired up).
- **Team seats** — ✅ already built. A `client-admin` seat can invite/manage other seats on
  their own account via `GET/POST /portal/members` and `/portal/invites`
  (`client-access` module). Matches the decision that the client's own admin, not Rothenhall,
  invites their colleagues.

### Report formats (decided)

All three in scope:
- **In-app web view** — ✅ already built.
- **Downloadable/exportable PDF** — ❌ not built. `docs/PRD.md` §16 build sequence has always
  deferred "true PDF rendering"; `MODULES-STATUS.md` still lists this as open under
  `reporting`. Unchanged by this conversation — still queued work, now confirmed wanted for
  the client portal specifically, not just the sales-facing report.
- **Shareable public link** — partially built: the report model has a `visibility` flag and
  `client-portal.service.ts` already distinguishes "publicly link-shareable" from "hidden from
  the client it's about." Whether the public share surface itself (an unauthenticated
  `/reports/:slug`-style route) is live in `web/`'s `(public)` route group needs a direct check
  before assuming it's done — not verified in this pass.

## 5. Admin scope — decided

All four selected as in-scope for the admin:

- **Client lifecycle** (create, invite, set plan/tier, suspend, view all data) — ✅ already
  built, except "suspend" — no explicit suspend/offboard action was found in `clients`;
  `PATCH /clients/:clientId` can update `status` generically but whether a `suspended` status
  value actually gates portal access needs a direct check, not assumed here.
- **Engagement/timeline authoring** — ❌ not built; part of §6.
- **Cailyx methodology config** (query-set templates, scoring weights, surfaces, claims
  rules) — ✅ already built, but scattered across the engine modules (`query-set`, `scoring`,
  `claims`) rather than a single admin settings surface. This was already in scope per
  PRD.md's original "admin owns methodology" persona — no change, just confirming it stays.
- **Internal delivery ops** (run diagnostics, review agentic output before it reaches a
  client, manage the team's queue) — ✅ mostly already built via `operations` (portfolio
  overview, per-client health, work/report/lead lists) plus the individual engine modules'
  own review/approval gates (e.g. `claims`'s hard approval gate).

## 6. Operator roles — decided: simple two-tier for now

**Decision:** admin vs. operator (everyone else with general access) is enough for now. The
six named roles already in the auth system (`admin`, `delivery-lead`, `content`, `technical`,
`outreach`, `sales`) stay as labels but are **explicitly not being differentiated by
permission** at this time — that's a deliberate simplification, not a gap to flag as missing.
Most of the codebase already reflects this: mutation endpoints mostly check
`@Roles('admin', 'delivery-lead')` rather than gating by the other four roles, so the current
code is already close to this decision without needing a change.

## 7. Billing — decided, with a correction to how it was framed mid-conversation

The working decision in conversation was "admin sets the plan manually, no live Stripe
processing." **What's actually built goes further than that reflects**, and this doc corrects
the record rather than silently building against a stale assumption: the `billing` module
already implements real, signature-verified Stripe webhook billing — `Offer` (price/entitlement
mapping), signed + replay-guarded webhook intake (`stripe-webhook.service.ts`, HMAC-SHA256 +
timing-safe compare + 300s tolerance + duplicate-event guard), `Entitlement` grants that only
a verified webhook event can create, `Subscription` tracking, and a billing ledger. Both an
operator surface (`/api/billing/*`) and a client-portal read surface
(`/api/portal/billing/*`) exist.

**What reconciles the two:** there's still no *public self-serve checkout page* — nothing lets
a stranger sign up and pay unassisted, matching the "no public signup" decision in §0. The
practical shape today is: an admin/sales conversation produces a Stripe Checkout link outside
strict self-serve, the client pays, Stripe's webhook fires, and the already-built verification
pipeline grants the entitlement automatically. That is **not** "admin manually flips a plan
field" — it's real payment processing, just without a public storefront in front of it. Net
effect for how the app behaves is close to what was decided (no public checkout), but the
mechanism (verified webhook-driven entitlements, not a manual admin toggle) is already more
robust than the conversation assumed. No code change follows from this section — it's a
documentation correction so the next person building against this doc doesn't try to remove or
duplicate working billing infrastructure.

## 8. Notifications — decided

In-app only for now. No outbound email or Slack alerts for score changes, approvals, or new
messages, despite the pricing page's marketing claim of "Slack and email alerts." That claim
is aspirational copy against future work, not a spec to build against right now.

## 9. Approval types — ⚠️ revised 2026-09-20 (v1.1): narrowed after §12/§13 corrected what's
   actually direct-edit vs. request-only

v1.0 of this doc scoped two approval types, one of which — "query-set / competitor-list
changes" — turned out to be wrong on the competitor half: competitors are already
directly client-editable in the real code (§12), not operator-only. The approval/request
picture is now three genuinely different mechanisms, not one:

- **Content before publish** (the real "Approval" primitive, §10) — draft copy, schema
  changes, citations the agentic workflow built; client approves before anything goes live
  under their name. Unchanged from v1.0.
- **Prompt add/delete requests** (§13) — a separate, lightweight request queue, explicitly
  **not** the same mechanism as content approval. The client requests; the admin acts on it
  directly (add/delete the prompt) rather than the client approving an operator's proposed diff.
- **Company facts (description, competitors, category, target markets)** — direct edit, no
  request/approval step at all (§12). Removed from the approval-types list entirely; it was
  never actually operator-gated in the built code.

Explicitly **not** in scope: milestone/phase completion does not require client sign-off —
approvals are scoped to content only, not a blanket gate on every step of the engagement.

## 10. The engagement/timeline model — ❌ not built, this is the actual net-new work

**Current state:** `Project.onboardingStatus` / `Project.onboardingStep` are the only progress
fields. They describe the Day-1 pipeline's own six/seven internal stages
(technical-audit → digital-presence → tech-stack → competitors → gap-analysis → strategy →
reporting) — a one-time bootstrapping run, not an ongoing client engagement.

**Decision:** build toward a richer model so a client sees a real project timeline, not a
status string. Target shape, at the level this conversation actually specified (deliberately
not a full schema — that's the next build pass's job):

- **Phase** — a named stage of the ongoing engagement (distinct from the Day-1 pipeline's
  internal stages, which are plumbing, not client-facing phases). Rothenhall's own four-phase
  language from the marketing site (`Diagnose → Build → Operate → Compound`, per `/about`) is
  the closest existing vocabulary and is worth reusing rather than inventing new phase names,
  though this wasn't explicitly confirmed in conversation and should be checked before locking
  it in.
- **Milestone** — a concrete, checkable thing within a phase. Admin marks it complete;
  per §9, milestone completion does **not** require client approval (only content and
  query-set changes do).
- **Approval** — the two types scoped in §9, attached to whatever they gate (a piece of
  content, a query-set change), not a generic approval-on-everything primitive.

What this doc deliberately does not do: propose Prisma models, propose whether this lives in
the existing `clients`/`client-portal` modules or a new `engagement` module, or resequence
`MODULES-STATUS.md`'s build order. That's real design work for whoever picks this up next, and
per AGENTS.md it should get its own focused analysis pass (tool choices, if any; DB migration
shape; which existing module owns it) before code — this section only fixes the scope
question (what a Phase/Milestone/Approval needs to represent) so that next pass isn't starting
from zero.

---

## 11. Google Search Console / Analytics connection — ⚠️ revised 2026-09-20 (v1.1): now a
    mandatory onboarding-wizard step, reversing v1.0's "optional" call

**v1.0 of this doc (earlier the same day) recorded Google-connect as optional/nudged, not
required.** After walking the full admin-creates-client → onboarding flow with the user, that's
been overridden: **connecting both GSC and GA4 is now required before the client can enter the
portal or see their Day-1 report at all** — steps (b) and (c) of the wizard in §2. This is a
real, deliberate reversal, not a refinement — noted here so nobody "fixes" it back to optional
by reading only this section.

What's still true and reusable from the already-built integration (unchanged by the reversal):

- Real, encrypted 3-legged OAuth (`backend/src/modules/google/`: `webmasters` +
  `analytics.readonly` scopes, AES-256-GCM token encryption, HMAC-signed state param) with a
  client-scoped delegation layer on top (`client-access/google-delegation.service.ts`) — client
  authorizes their own account, maps the GSC site/GA4 property to their project, can delegate
  proxied access to a colleague without exposing tokens, disconnects with an impact preview.
- The OAuth `authorize`/`callback` endpoints and the connection UI's underlying mechanics
  (`web/src/app/(client)/client/projects/[projectId]/connections/page.tsx`) are reusable as-is
  inside the new wizard steps — what needs building is the **gating** (wizard can't advance /
  portal won't render past onboarding without a live connection), not the OAuth flow itself.

What changes and is now net-new work:

- The wizard must check connection status as a hard precondition, not just display it — today's
  checklist item is informational only (`gsc-access`/`ga4-access` as ordinary
  `owner: 'client'` items with no blocking rule; `business-profile.service.ts` ~line 1754). That
  non-blocking behavior is exactly what's being reversed.
- Today's welcome-checklist page (CP04) is superseded as the primary onboarding surface by the
  wizard (§2) — its Google-connect card either gets removed (subsumed by the wizard) or kept as
  a secondary "manage your connection" surface post-onboarding for reconnecting/disconnecting,
  which is a reasonable thing to keep since disconnect/reconnect should stay possible after
  onboarding is already done. Not fully resolved here — worth a quick call when this gets built.
- Known separate gap, unaffected by this: `sleeper-refresh` still only takes manual/CSV GSC
  import and hasn't been updated to consume the `google` module's live data.

## 12. Client-editable Day-1 facts — ⚠️ correction: further along than v1.0 assumed, plus new
    scope for two fields

**Decision:** four fields, gathered by the Day-1 pipeline, are directly client-editable during
the onboarding wizard's confirm-details step (§2a) — no request/approval needed:

- **Company description** — ✅ already built (`business-info/page.tsx`, `portal-profile.ts`).
- **Competitors list** — ✅ already built. v1.0 of this doc had this wrong (recorded as
  "operator-only, client can only request" per an earlier answer in conversation that predates
  this discovery pass) — the real code already parses and saves client-edited competitor
  entries (`"Name (domain)"` text, `business-info/page.tsx` ~line 425). No build needed; the
  doc was correcting itself, not the product.
- **Category / business type** — needs a direct check of whether `business-info/page.tsx`'s
  existing field set already covers this the same way as description/competitors, or whether
  it's new UI work. Not verified in this pass.
- **Target markets / locations** — same caveat: `business-profile` module has a "target
  locations" concept per `MODULES-STATUS.md` §1.2g (P04), but whether it's already exposed as a
  client-editable field (vs. an operator/admin-only structured-locations surface) needs a direct
  check before assuming either way.

## 13. Prompt visibility + add/delete requests — ❌ not built, new scope

**Decision:** the client sees the full, real list of active prompts (buyer questions) in their
query set — read-only, same prompts the `measurement` engine actually runs, not a summary or
count. Next to the list, a **lightweight inline request mechanism**: propose a new prompt, or
flag an existing one for removal. This is explicitly **not** the same system as content
approval (§9/§10) — no `Phase`/`Milestone`/`Approval` machinery, no client-vs-operator diff
review. It's closer to a simple ticket: client submits, it lands in an admin queue, admin adds
or removes the prompt directly (or declines) using the existing `query-set` module's own
edit/versioning mechanics. Nothing here exists yet — no backend request/ticket model for
prompts, no client-facing UI to view or request against the query set.

## 14. Content tab — ⚠️ partially built: viewing existing content is real, requesting new
    content is not

**Decision:** the client-facing content tab shows already-drafted content (existing, per §4)
and separately lets the client request new content via a **structured form** — content type
(blog/landing page/FAQ/etc.), target keyword or topic, and priority, not a bare free-text box.

- **Viewing drafted content** — ✅ already built:
  `web/src/app/(client)/client/projects/[projectId]/content/page.tsx` and
  `.../content/[assetId]/page.tsx` exist, and `content-workspace`'s `CLIENT_REVIEW_STATES`
  (`not-shared → awaiting-review → changes-requested → approved → expired-superseded`) already
  give the client a review/changes-requested loop **on content operators have already shared**
  with them.
- **Requesting brand-new content** — ❌ not built. `content-workspace` only has a client
  *review* surface for content operators chose to share; there is no client-initiated "make me
  a new piece of content" intake anywhere in the backend. This needs a new request type (its own
  small model, or a lightweight addition to `content-workspace`) plus the structured-form UI on
  the client content tab.

## 15. Onboarding-gate bypass — ❌ not built, new scope (closes a real production risk)

**Decision:** the hard Google-connect gate (§11) needs an escape hatch. An admin can manually
waive it for a specific client — an explicit "waive Google-connect for this client" action,
distinct from the client actually connecting. The waived state is visibly logged as *waived*,
not silently rendered identical to *connected*, so nobody downstream (reporting, `operations`
health view per §22) mistakes a bypass for a real connection. Without this, a client who can't
get GSC/GA access on day one (agency handoff in progress, IT ticket pending) would be
permanently locked out of a portal they're paying for — this closes that gap. New backend
action + audit trail + wizard-side "waived, continue" state; no design beyond that was specified
here.

## 16. Multi-project onboarding scope — ❌ not built, new scope

**Decision:** the onboarding wizard (confirm details → GSC → GA4) runs **once per Project**, not
once per Client account. A fund client with 3 portfolio companies goes through the wizard 3
times — once per brand, since each project has its own website, its own GSC property, and its
own GA4 property to map. This means the hard gate in §11 is scoped per-project: a client with
one fully-onboarded project and one newly-added project sees the new project gated while the
old one isn't. Not yet reflected anywhere in the existing single-`Client`-level onboarding
checklist plumbing — needs to be built per-project from the start, not retrofitted later.

## 17. Seat/colleague onboarding — decided, minimal new work

**Decision:** the wizard is an account/project setup step, not a per-person one. Once a project
has been onboarded (details confirmed, Google connected — by anyone, not necessarily the
primary contact), a colleague accepting a seat invite lands straight in the portal with no
wizard. No design work needed beyond making sure the wizard-gate check in §11/§16 is keyed on
project state, not on "has this specific user completed onboarding."

## 18. Day-1 pipeline failure handling — decided, aligns with an existing PRD principle

**Decision:** a partial/degraded Day-1 run still fires the completion email (§2) and still lets
the client into the (gated) wizard — it does not block on a clean run. This matches
`docs/PRD.md`'s existing pipeline design principle (§06: "a failed stage degrades the score
gracefully rather than failing the whole run") — no new principle being introduced, just
confirming the client-facing email/wizard flow inherits it rather than adding a stricter,
inconsistent rule on top. Whatever section failed shows as honestly partial/unavailable in the
Day-1 report, same claims-discipline standard as everywhere else in the product.

## 19. Ongoing refresh cadence — ❌ not built as automation, new scope

**Decision:** re-running measurement/scoring on the plan's promised cadence (Starter weekly,
Growth/Scale daily) is **fully automatic**, not operator-triggered — matching the pricing
page's literal claim rather than treating it as aspirational copy the way §8's notifications
claim was treated. The `scheduling`/`monitoring` modules already have BullMQ-based cadence
infrastructure (per-project `ScheduleConfig`, used today for monitoring alerts); this is a new
scheduled job wired to the same infrastructure, tied to the client's plan tier rather than a
manually-configured cadence. Needs its own scoping pass on exactly which pipeline stages re-run
on cadence (probably not the full Day-1 flowchart every time — re-running competitor discovery
daily, for instance, is likely wasteful) — not specified at that level of detail here.

## 20. Prompt-request quota enforcement — ❌ not built, new scope

**Decision:** client-requested prompt additions (§13) are checked against the plan's
tracked-prompt limit (Starter 100 / Growth 300 / Scale 1,000 / Enterprise unlimited) at request
time. Over quota doesn't silently fail — it's flagged distinctly (e.g. "this would exceed your
plan's prompt limit") so it reads as an upsell moment for the admin, not a bug. Needs the
request-queue model from §13 to carry this check; not yet designed at the data-model level.

## 21. Admin visibility of onboarding progress — ❌ not built, new scope

**Decision:** per-project onboarding-wizard state (not started / confirming details / connecting
Google / done / waived per §15) is added to the per-client health view already in `operations`
(§5's "internal delivery ops" — portfolio overview, per-client health, work/report/lead lists).
Lets admins proactively nudge a stalled client rather than finding out when the client
complains. Straightforward addition to an existing surface, not a new one.

## 22. Content-request routing — decided, minimal new work

**Decision:** a client's structured content request (§14) becomes a real `content-workspace`
item immediately, tagged as client-originated, rather than sitting in a separate triage inbox
first. Reuses `content-workspace`'s existing pipeline and states rather than adding a new
intermediate queue — the "structured form" requirement from §14 is what keeps these requests
well-formed enough to drop straight in, instead of needing a triage step to make sense of a
free-text ask.

## 23. Offboarding: Google token revocation — decided, small new work

**Decision:** when a client is suspended, their Google tokens are revoked/disconnected
immediately — not just stopped-from-being-called. Minimizes lingering access to a suspended
client's real business data. A reactivated client reconnects from scratch (accepted tradeoff,
per this decision, over keeping tokens warm for instant reactivation). Ties into §5's flagged
"admin: suspend/offboard" gap — whatever build closes that gap needs to call the `google`
module's disconnect path as part of suspension, not just flip a status field.

## 24. Portal account security — decided: no change for now

**Decision:** current JWT-based login is sufficient for client accounts; no 2FA added at this
time. Revisit specifically if/when an Enterprise-tier client actually asks, since Enterprise
already promises SSO/SAML on the pricing page (a different, likely more valuable investment
than 2FA for that segment) — not a general client-base requirement right now.

## 25. Baseline report — ❌ not built, new scope

**Decision:** the report a client sees immediately after completing onboarding is a frozen
"baseline" artifact — explicitly pinned as "where you started," referenced by later reports as
the delta comparison point. Matches the pricing page's own case-study framing ("DayOne
Technologies, 55→62 points") and the PRD's monitoring/delta concept (§6.12), but that delta
machinery has so far been built for internal/sales-report contexts, not explicitly surfaced to
the client as "vs. your baseline." Needs a `isBaseline` concept (or equivalent) on the report
model plus client-portal UI to show delta-from-baseline, not just delta-from-previous-run.

## 26. Prompt sunset — decided: no automatic retirement, deliberately not building this now

**Decision:** prompts persist until someone acts on them via the request/admin-edit mechanism
already scoped in §13 — no automatic staleness detection, no scheduled review nudge. This is a
genuinely open idea for later (e.g., flag a prompt an operator hasn't touched in N months for
review) but explicitly not committed to any build here.

## 27. Client seat permission differentiation — ❌ not built, new scope

**Decision:** client-side seats are not flat. Only `client-admin` can do account-level or
sensitive actions — manage billing, invite/remove seats, approve content before it goes live
(§9/§10's Approval). A `client-collaborator` seat can view everything and use messaging + the
request mechanisms (§13 prompts, §14 content) but cannot take publish-gating or account
actions. The role labels (`PORTAL_MEMBER_ROLE_LABEL` etc.) already exist in
`client-access`/`web/services/portal-access.ts`; what's missing is actually gating endpoints by
role rather than just labeling seats — needs a permission-check pass across the client-portal
API surface, not a schema change.

## 28. Data staleness indicators — ❌ not built, new scope

**Decision:** every score/metric/data panel in the client portal carries a visible "as of
[date]" — measurement results, GSC/GA data, backlinks, scores. This is a direct extension of
the product's own claims-discipline principle (PRD §07: never present a claim without its
evidence and provenance) into the client-facing surface specifically. Mechanically
straightforward (the underlying records already carry timestamps) but touches most portal
pages, so it's broad, low-risk, new frontend work rather than a backend gap.

## 29. Competitor cap — ❌ not built, new scope

**Decision:** the number of competitors a client can directly add (§12) is capped, tied to plan
tier — same spirit as the prompt-quota enforcement (§20), since each added competitor
multiplies measurement-run cost. Specific per-tier numbers weren't set in this conversation
(PRD's own FR-1.3 default is "3 to 8 named competitors" as a starting suggestion, not a hard
tier-based cap) — whoever builds this needs to propose actual per-tier limits as part of that
work, not invent them here.

## 30. Payment failure handling — ❌ not built, new scope

**Decision:** a failed/declined payment does not suspend access immediately — there's a grace
period (Stripe's own retry schedule is the natural default to lean on, e.g. via its Smart
Retries) during which the client keeps access while payment resolves. If it's still unresolved
once the grace period lapses, the client is auto-suspended, which per §23 also revokes their
Google tokens. Needs to consume Stripe's `invoice.payment_failed` /
`customer.subscription.past_due` webhook events (the `billing` module's webhook intake already
exists and is signature-verified per §7 — this extends what it reacts to, doesn't rebuild the
verification pipeline) and a scheduled check for grace-period expiry.

## 31. Public report-link security — ❌ not built, new scope

**Decision:** the shareable public report link (§4) gets an expiry (client or admin can set a
window, or revoke early) and an optional password the client can set. This goes beyond what
other public share tokens in the system do today (e.g. `scorecard`'s public token, which is
just unguessable with no expiry/password) — a deliberate exception because this data
(competitor share-of-voice, findings) is more competitively sensitive than a free top-of-funnel
diagnostic. Needs its own token model extension (expiry timestamp, optional password hash) —
not shared with the scorecard token's simpler design.

## 32. Account-ownership transfer — decided, small new work

**Decision:** when a client's primary contact leaves, an admin manually reassigns which seat is
the primary contact on the `Client` record — kept as a human-mediated admin action rather than
client self-service, since it's a genuine account-management event worth a real person noticing
(billing contact, legal contact, etc. may all hang off "primary contact" too). Small addition to
the existing admin client-management surface, not a new subsystem.

## 33. General admin audit log — ❌ not built, new scope

**Decision:** beyond the Google-gate-waive log already scoped (§15), a general admin-action
audit log (actor, action, target, timestamp) covers sensitive actions broadly — suspend,
plan/tier change, manual entitlement grant, ownership transfer (§32), competitor-cap override,
and the waive action itself. One shared audit mechanism rather than a separate bespoke log per
feature as more of these sensitive-action decisions accumulate (§15, §23, §30, §32 all produce
audit-worthy events) — worth building as shared infrastructure rather than N one-off logs.

## 34. Multi-domain projects — decided: no change, confirms existing shape

**Decision:** strictly one domain per Project, always — a second domain for the same brand
consumes its own Project slot against the plan's quota. This matches the existing
`Project.domain` singular field exactly as built; no schema change needed. Simpler than
alternative multi-domain modeling, at the cost of a client with a `.com` and a `.co.uk`
technically "spending" two brand slots for one brand — an accepted tradeoff per this decision.

## 35. Summary table — decided vs. built vs. still open

| Area | Decision | Build state |
|---|---|---|
| Public signup | None — admin-invite only | ✅ matches what's built |
| White-label | Dropped | N/A — nothing to undo, was never built |
| Free diagnostic ↔ app link | Out of scope, stays disconnected | ✅ matches what's built |
| Client owns multiple brands | Yes, via `Project` under `Client` | ✅ already built |
| Onboarding flow (admin side) | Confirmed as-is | ✅ already built |
| Onboarding flow (client side) | Sequential gated wizard: confirm details → GSC → GA4 → done | ❌ not built — see §2, supersedes CP04 |
| Auto-email on Day-1 completion | Invite-link, no PDF, "portal is ready" | ❌ not built — see §2 |
| Initial query set | Operator drafts; stays read-only for client (not an approval gate) | ✅ drafting exists; read-only is already true, no gate needed |
| Google (GSC/GA4) connect | **Required** before portal/report access (reverses v1.0) | ❌ gating logic not built — OAuth mechanics reusable, see §11 |
| Company facts (description, competitors) | Directly client-editable | ✅ already built (§12) |
| Company facts (category, target markets) | Directly client-editable | ⚠️ unverified whether already exposed — see §12 |
| Prompt visibility + add/delete requests | Read-only view + lightweight request queue | ❌ not built — see §13 |
| Content: view existing | In scope | ✅ already built |
| Content: request new (structured form) | In scope | ❌ not built — see §14 |
| Backlinks / domain authority | In scope, surfaced in portal | ✅ already built — `backlinks` module, DataForSEO, no new vendor |
| Google-gate bypass | Admin can manually waive, logged | ❌ not built — see §15 |
| Onboarding wizard scope | Per-project, not per-client | ❌ not built — see §16 |
| Seat/colleague onboarding | Skip wizard once project is onboarded | ⚠️ needs project-scoped gate check, not user-scoped — see §17 |
| Day-1 pipeline failure handling | Fire honest partial results, no blocking retry | ✅ matches existing PRD principle — see §18 |
| Ongoing refresh cadence | Fully automatic per plan tier | ❌ not built — see §19 |
| Prompt-request quota | System-enforced against plan limit | ❌ not built — see §20 |
| Admin visibility of onboarding progress | Surfaced in `operations` per-client health | ❌ not built — see §21 |
| Content-request routing | Straight into `content-workspace` | ✅ mostly reuses existing pipeline — see §22 |
| Offboarding: Google tokens | Revoke immediately on suspend | ❌ not built — see §23, ties to §5's suspend gap |
| Portal account security | JWT only, no 2FA for now | ✅ no change needed |
| Baseline report | Frozen, delta reported against it | ❌ not built — see §25 |
| Prompt sunset / staleness | No auto-retirement, explicit-only | ✅ no change needed — deliberately deferred |
| Client seat permissions | Differentiated: client-admin vs. collaborator | ❌ not built — labels exist, gating doesn't, see §27 |
| Data staleness indicators | "As of [date]" on every metric/panel | ❌ not built — see §28 |
| Competitor cap | Capped, tied to plan tier (numbers TBD) | ❌ not built — see §29 |
| Payment failure handling | Grace period, then auto-suspend | ❌ not built — see §30 |
| Public report-link security | Expiry + optional password | ❌ not built — see §31 |
| Account-ownership transfer | Admin manually reassigns primary contact | ❌ not built — see §32 |
| General admin audit log | Yes, shared mechanism across sensitive actions | ❌ not built — see §33 |
| Multi-domain projects | Strict 1:1, one domain per project | ✅ matches existing schema — no change needed |
| Client portal: score/reports | In scope | ✅ built (web view); ❌ PDF export; ⚠️ public link unverified |
| Client portal: timeline/approvals | In scope | ❌ not built — see §6/§9/§10 |
| Client portal: messaging | In scope | ✅ built |
| Client portal: billing visibility | In scope | ✅ built, and more robust than assumed (§7) |
| Client portal: team seats | In scope | ✅ built |
| Admin: client lifecycle | In scope | ✅ built, except suspend/offboard unverified |
| Admin: timeline authoring | In scope | ❌ not built — see §6 |
| Admin: methodology config | In scope | ✅ built, scattered across engine modules |
| Admin: delivery ops | In scope | ✅ mostly built via `operations` + per-module gates |
| Operator roles | Simple admin/operator, no per-role gating | ✅ matches current code |
| Billing | Admin/sales-initiated, webhook-verified | ✅ built, more real than the conversation assumed |
| Notifications | In-app only | ✅ matches what's built (no email/Slack exists) |
| Approval types | Content pre-publish only (competitors/facts are direct-edit, prompts are a separate request queue) | ❌ not built — needs §10 first |
| Google (GSC/GA4) connect | Post-login, prominent, optional not required | ✅ built end-to-end (§11) |
