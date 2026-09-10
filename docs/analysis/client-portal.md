# Client Portal + Operator Admin — Analysis & Plan

> Status: draft v0.1, 2026-09-05. Planning only, no code.
> Convention: this is the `docs/analysis/<module>.md` gate required by `AGENTS.md`. It covers
> three modules (`accounts`, `engagement`, `client-reporting`) because they share one data
> spine and one UI. Each gets its own build pass and its own post-completion checklist.
> Related: `../PRD.md`, `../MODULES-STATUS.md`, `../../../PROJECT_CONTEXT.md`,
> `../../../Assets/BRANDING.md`, `Assets/Rothenhall-Operating-Manual.pdf` Parts 4 and 8.

---

## 0. The ask, restated

A client is handed login credentials by Rothenhall. Behind that login they see what is
happening on their engagement, how it is going, and what is coming. On our side, an admin
console issues those credentials and drives each client's timeline, updates, and reports.

The hard part is not auth. It is deciding **what a client should see**, and that question is
already answered, in writing, by the firm's own Operating Manual. Part 8.1 defines what a
client is told to expect at kickoff. Part 8.2 defines the communication cadence. Part 4.4 and
SOP-11 define the eleven things every report must contain. **The portal is that manual, made
into software.** Nothing in the IA below is invented. Every screen traces to a rule the firm
already committed to.

---

## 1. Where things actually stand today

### 1.1 The marketing site (rothenhall.com)

- **TanStack Start** (not Next.js), server-rendered, deployed on **Vercel**, `www` canonical,
  apex 308-redirects to `www`.
- Routes live today: `/`, `/community`, `/cailyx`, `/pricing`, `/research`, `/aeo-vs-seo`,
  `/ai-visibility-score`, `/how-to-show-up-in-chatgpt`, `/faq`, `/case-studies`, `/blogs`,
  `/founders`, `/about`. Nav is Community, Cailyx, Journal, Research, Case Studies, About.
- **No `/login`, `/portal`, `/admin`, `/dashboard`.** All 404. There is no authenticated
  surface on the marketing site at all.
- There **is** a real API on the same host: `/api/v1/blogs` returns
  `401 {"error":"Unauthorized","message":"Missing or invalid Bearer token"}`. That is the blog
  publishing API from `Assets/BLOG_API_CONTRACT.md`. Nothing else under `/api/v1` responds.
- `robots.txt` explicitly welcomes every AI crawler and lists two sitemaps. The site is built
  to be crawled aggressively. **This is the single biggest constraint on where the portal
  lives.**
- `/ai-visibility-score` already publishes the scoring framework to the world: 0-100, five
  weighted dimensions (25 machine access / 25 entity clarity / 20 shortlist presence / 20
  on-page extractability / 10 authority), four bands (Invisible 0-40, Faint 41-60, Present
  61-80, Recommended 81-100), n>=5 runs, at least 2 geographies, rates never rankings, and a
  "not a black box, every sub-score traces back to the runs" promise.
- `/case-studies` names three scored companies: BetterWaves 14 Invisible, Napkin 43 Faint,
  DayOne Technologies 62 Present.

### 1.2 The contradiction on the public site

`/cailyx` says: *"Cailyx powers Rothenhall engagements today. It is not yet offered as a
standalone B2B tool."*

`/pricing` sells four self-serve tiers (Starter $69, Growth $199, Scale $499, Enterprise
custom), with seats, refresh cadence, API access, the Cailyx MCP, and the line *"Change tiers
any time, up or down, **from inside the app**."*

So the public site already promises an app with logins, seats, and plan management. **This
plan should be built as the first version of that app, not as a throwaway client page.** The
tenancy model below is chosen specifically so that turning on self-serve billing later is a
flag flip, not a rewrite.

### 1.3 Cailyx (the engine)

Two repositories exist and they are not the same thing:

| | `Cailyx/` | `Cailyx-Beacon/` |
|---|---|---|
| Purpose | Multi-project product engine, runs client work | Rothenhall's **own** visibility flywheel ops |
| Backend | NestJS + Prisma, roughly 50 models, all PRD waves 0-5 built and e2e-verified | NestJS 11 + Prisma 5, Supabase Postgres, Phases 0-2 only |
| DB | SQLite `prisma/dev.db` in dev (was Postgres 17) | Supabase Postgres, ap-south-1 |
| Frontend | Next.js 16 shell: `/login`, project list, project workspace, plus a `v2` terminal-style UI | Next.js 16 operator console: runs, personas, query-sets, gap-map, share-of-voice, reports |
| Scope | Client projects | Subject is Rothenhall itself. Explicit non-goal: fleets of agents |

**Recommendation: build the portal on `Cailyx/`.** It already has the whole engine the client
portal needs to display: `scoring` (versioned rubric, honest partials), `measurement` (the
n>=5 moat, share of voice, raw answers stored), `monitoring` (deltas and threshold alerts),
`crawler-monitor`, `gap-analysis`, `findings` (two-register executive and technical copy),
`claims` (the discipline gate), `reporting`, `delivery` (Plunk email, Lead CRM, Stripe
ledger), `scorecard` (Rung 0 with public share tokens). `Cailyx-Beacon` stays what it is:
Rothenhall's internal flywheel, not a client-facing product.

### 1.4 What Cailyx does **not** have (the actual gap)

The engine is rich. The client-facing layer does not exist at all:

1. **No tenancy.** `User` has operator roles only (`admin | delivery-lead | content |
   technical | outreach | sales`). There is no client user, no client organization, no
   membership, no per-account scoping. `Project.userId` is "owning operator".
2. **No credential issuance.** Registration is admin-only after the first account, which is
   correct, but there is no invite, no one-time link, no password-set flow, no revocation.
3. **No engagement timeline.** No Engagement, Phase, Milestone, Update, Deliverable,
   ClientTask, or Approval model anywhere in the schema. This is the single biggest build.
4. **No publish gate.** `Report.visibility` is `private | public` only. There is no notion of
   "published to this client", and no staging between what an operator computes and what a
   client sees.
5. **No client read model.** Every existing endpoint returns operator-shaped data, including
   raw answers, cost figures, and in-flight runs. None of that can be exposed as-is.

---

## 2. Architecture decision

### 2.1 Where the portal lives

**Recommendation: a separate app at `app.rothenhall.com`, served by the Cailyx Next.js
frontend, talking to the Cailyx NestJS API at `api.rothenhall.com`.** Both `noindex`.

| Option | Verdict |
|---|---|
| A. Inside the marketing site (`rothenhall.com/portal`) | **No.** Different framework (TanStack Start), different deploy, and it would mean duplicating the auth client and the entire typed API layer that already exists in `Cailyx/frontend/src/lib/api.ts`. It also puts an authed app inside a domain whose whole robots policy is "crawl everything". |
| B. Subdomain `app.rothenhall.com` | **Yes.** Clean separation, independent deploys, one `X-Robots-Tag: noindex, nofollow` header on the whole origin, cookies scoped to the subdomain, and it matches the "from inside the app" language already on `/pricing`. |
| C. A `cailyx.com` domain | Later. Splitting brand now costs entity clarity, which is literally 25 points of the score we sell. Keep the client experience under the Rothenhall entity until Cailyx is sold standalone. |

The marketing site changes are deliberately tiny: a **"Client login"** link in the footer only
(not the main nav), pointing at `app.rothenhall.com`, plus a `/login` route on the marketing
site that 302s to the app, because clients will type it.

### 2.2 One app, two faces

Same Next.js app, same API, two route groups behind one auth system:

```
app.rothenhall.com/
  (client)   /overview  /visibility  /timeline  /work  /actions  /reports  /account
  (ops)      /ops/clients  /ops/clients/[id]/{access,timeline,updates,reports,tasks}
             /ops/cadence  /ops/audit  /ops/escalations
```

A single `type` claim on the JWT decides which shell renders. Operators can open
`/ops/clients/[id]?preview=client` to see exactly what the client sees, read-only and logged.

**Rule: there is no shared component that renders both operator and client data.** Client
screens read from a separate, published read model (section 3.3). This is the one
architectural decision that prevents an accidental leak of an in-flight run, a cost figure, or
an unapproved claim.

---

## 3. Data model additions

### 3.1 Tenancy and identity (`accounts` module)

```
Account            the client company. name, slug, domain, logoUrl, tier, status,
                   deliveryLeadId (operator), createdAt
                   1 Account -> many Project (so Scale-tier "10 brands" works later)

User (extend)      + type: "operator" | "client"        (default "operator")
                   + accountId: String?                 (null for operators)
                   + lastLoginAt, disabledAt
                   existing role stays operator-only; client seats use Membership.role

Membership         accountId, userId, role: "owner" | "member" | "viewer", invitedById
                   A seat. Lets a founder add their marketer without an operator doing it,
                   if we enable that. See open question 4.

Invite             accountId, email, tokenHash, role, expiresAt (72h), acceptedAt,
                   revokedAt, createdById
                   Raw token is shown to the operator once and never stored.
```

Reusing the existing `User` and `RefreshToken` tables (rather than a parallel `ClientUser`
table) is deliberate: the JWT issuance, refresh rotation, hashing, and revocation are already
built and tested. Adding `type` and `accountId` is a two-column migration plus a guard.

### 3.2 The engagement spine (`engagement` module)

This is what makes the portal answer "what's happening, how's it going".

```
Engagement         accountId, projectId, rung: "scorecard"|"diagnostic"|"sprint"|"retainer",
                   startedAt, termMonths, status, deliveryLeadId,
                   kickoffExpectations (JSON snapshot of the Manual 8.1 text, frozen at
                     kickoff so month-two arguments are settled by the record, not memory),
                   cadence (JSON: weekly update day, monthly report day, quarterly re-baseline)

Phase              engagementId, name, order, startsOn, endsOn,
                   status: "planned"|"active"|"complete"

Milestone          phaseId, title, description, owner: "rothenhall"|"client",
                   dueOn, status: "planned"|"in-progress"|"shipped"|"blocked",
                   shippedAt, blockedReason, evidenceUrl, visibleToClient (bool)

Update             engagementId, periodStart, periodEnd,
                   shipped (text), shipping (text), blocked (text),
                   status: "draft"|"published", publishedAt, authorId
                   Hard length cap enforced at the DTO. Manual 8.2: five lines maximum.

ClientTask         engagementId, title, why, dueOn,
                   status: "open"|"done"|"waived", completedAt, completedByUserId
                   "What you owe us." SOP-11 item 10 and Manual 8.3 item 5.

Approval           engagementId, kind: "query-set"|"content"|"schema"|"robots"|"other",
                   title, payloadRef, beforeText, afterText,
                   status: "pending"|"approved"|"changes-requested",
                   decidedByUserId, decidedAt, note
                   The robots kind exists because the Manual forbids the technical role from
                   changing robots.txt without documenting before and after. The portal makes
                   that documentation automatic and client-countersigned.

Deliverable        engagementId, kind: "report"|"query-set"|"brief"|"patch"|"export",
                   title, url or fileRef, version, publishedAt, visibleToClient

Escalation         engagementId, trigger (guarantee-asked | number-disputed |
                   cancellation-threatened | contradiction | laundering-requested),
                   openedAt, dueAt (openedAt + 24h, Manual 8.4), resolvedAt, note
                   Operator-only. Never visible to the client.
```

### 3.3 Publication (`client-reporting` module)

```
Report (extend)    + accountId, engagementId
                   + visibility: "private" | "client" | "public"   (adds "client")
                   + periodStart, periodEnd, kind: "monthly"|"baseline"|"quarterly"
                   + publishedAt, publishedById, claimsCheckId
                   + sections (JSON, the fixed SOP-11 eleven)

ClientSnapshot     accountId, engagementId, capturedAt, publishedAt,
                   payload (JSON: score, band, five sub-scores with partial flags, citation
                     and mention rates by cluster and surface, share of voice,
                     characterization counts, crawler activity, run metadata n/geo/surface)
                   The client portal reads ONLY from published snapshots. It never queries
                   MeasurementRun, Observation, or ScoreRun directly.

AuditEvent         actorId, accountId, action, targetType, targetId, meta, createdAt
                   Every publish, credential issue, revoke, impersonation, approval, and
                   robots change. Append-only.
```

**The publish gate, stated plainly:** an operator computes freely; a client sees nothing until
a `publishedAt` is stamped. Publishing a report runs the existing `claims` module over every
sentence first, and a banned phrase or an ungraded number blocks the publish. The firm sells
claims discipline. The portal must be the place it is most visibly enforced.

---

## 4. Client portal, screen by screen

Design principle: **one number, one band, one sentence, then the evidence.** A founder should
get the state of the engagement in four seconds, and be able to drill from any figure to the
raw run that produced it.

### 4.1 Overview, "Where you stand"

- **Hero.** The AI Visibility Score, large, with the band word set larger than the number.
  `/ai-visibility-score` says it out loud: the band is what a founder remembers. Delta against
  baseline and against last period. Measured-on date, rubric version, and the run basis
  (`n=5, 2 geos, 4 surfaces`) as a caption. A sparkline of the score line.
- **Five dimension cards.** Machine access 25, Entity clarity 25, Shortlist presence 20,
  On-page extractability 20, Authority signal 10. Each shows its sub-score, its delta, and an
  explicit **"not measured yet"** state where the `scoring` module reported a partial. Never a
  zero standing in for a gap. The engine already tracks honest partials, so the UI must not
  launder them.
- **This week.** The latest published `Update`: Shipped / Shipping / Blocked, three lines.
- **What we need from you.** Open `ClientTask` and pending `Approval` items with due dates,
  overdue in cognac. This block is the reason clients stop assuming progress stalled on our
  side.
- **Next milestone** and **next report date**.
- **"How to read this."** A permanently available panel carrying the Manual 8.1 expectations
  verbatim: what moves in weeks 4 to 8, what moves in months 3 to 6, what moves in months 12
  to 24, and what we cannot control. Frozen from `Engagement.kickoffExpectations`, so the
  month-two conversation is answered by the client's own kickoff record.

### 4.2 Visibility, "The numbers"

Mirrors SOP-11 items 1 to 7 exactly, in order.

- Citation rate and mention rate, by cluster and by surface, this period vs baseline vs last
  period.
- Share of voice against named competitors, over time.
- Characterization quality: accurate-positive, accurate-neutral, inaccurate, negative. **Any
  inaccuracy pins to the top of the page in cognac with a timestamp**, because Manual 8.2 says
  inaccuracies are communicated immediately, not at report time.
- Branded search trend, self-reported attribution counts, AI crawler activity by URL.
- **Evidence drawer.** Click any rate to see the runs behind it: prompt, surface, geo, run
  index, the stored raw answer, the cited URL. This is how the portal keeps the public
  "not a black box" promise instead of just repeating it.
- **Standing footer on every chart:** rates not rankings, n and geographies, and the referral
  undercount disclaimer. Each metric tagged **leading** or **lagging**. Manual 4.4 is blunt
  about why: clients who churn at month three churn because someone let them watch the wrong
  number.

### 4.3 Timeline, "What's happening"

- A vertical timeline of phases, milestones, and published weekly updates, interleaved and
  dated. Past and future both visible.
- Status chips (planned, in progress, shipped, blocked) and owner chips (Rothenhall, You).
  Blocked items say who is blocking and why.
- **Expectation markers** rendered on the timeline at week 4-8, month 3, month 6, month 12,
  each labelled with what should be moving by then. The timeline and the promise sit on the
  same axis, which is the whole point.
- Filters: everything / shipped / blocked / yours.

### 4.4 Work, "What we are doing and why"

- The ranked roadmap from `gap-analysis`, client-shaped: the finding, why it matters, what we
  are doing about it, status, owner.
- `findings` copy in the **executive register** by default, with a toggle to technical. Both
  registers are already generated by the module, which is exactly the two audiences a founder
  and their engineer represent.
- Deliverables: reports, query-set exports, page briefs, schema patches, with versions.

### 4.5 Actions, "Your inputs"

- Approvals queue. Schema and robots approvals render a **before / after diff** the client
  countersigns, which satisfies the Manual's documentation rule and protects both sides.
- Open tasks you owe us, with a one-click done and an optional note.
- The attribution ask: whether "how did you hear about us?" is live on their forms, the counts
  if it is, and a plain explanation of why its absence caps what we can attribute.

### 4.6 Reports

- Archive of published reports. Each is the fixed eleven-section SOP-11 structure, immutable
  after publish, stamped with period and publish date. Web view plus PDF.
- An expiring share link for a client who wants to hand a report to their board. Reuse the
  unguessable-token pattern already built for `ScorecardRun`.

### 4.7 Account

Seats, profile, password, notification preferences, engagement terms summary, delivery lead
contact, and a plain data-export request path.

---

## 5. Operator admin console

### 5.1 Clients list, the delivery lead's daily driver

One row per account: name, domain, rung, current score and band, delta, **days since last
published update** (amber at 8, red at 10 for a weekly cadence), open client tasks, pending
approvals, next report due, escalation flag. Sorting defaults to most overdue first.

### 5.2 Account detail

- **Access.** Create a client login: name, email, seat role, press create. The system issues a
  **one-time invite link valid 72 hours**; the client sets their own password. Never generate,
  store, display, or email a plaintext password. If a link must be handed over by phone, issue
  a fresh single-use link rather than a password. Revoke a seat, disable an account, force a
  session logout, resend an invite. Every action writes an `AuditEvent`.
- **Timeline builder.** Instantiate a phase and milestone template by rung (Sprint template,
  Retainer template), reorder, set owner and due date, flip status, write a blocked reason. A
  `visibleToClient` switch per milestone for internal-only work.
- **Weekly update composer.** Three fields, shipped / shipping / blocked, with the five-line
  cap enforced in the form. Draft, preview as client, publish. A "due" badge appears at day 7.
- **Report builder.** The eleven SOP-11 sections pre-filled from the modules that already
  compute them (`scoring`, `measurement`, `monitoring`, `crawler-monitor`, `gap-analysis`,
  `findings`, `delivery`). The operator writes only the narrative headline and the risks
  section, because the Manual says the delivery lead never delegates the report narrative.
  **Publish runs the `claims` gate first**: a banned phrase, a rank claim, an ungraded number,
  or a single run presented as a rate blocks the publish and names the offending sentence. If
  a number went down, the builder requires it in the headline field before it will publish.
- **Tasks and approvals.** Create the asks, watch the state.
- **Escalations.** Open one against a Manual 8.4 trigger, 24-hour timer, resolution note.
- **Preview as client.** Read-only, banner-marked, logged.

### 5.3 Cross-account

- **Cadence board.** Every account against weekly, monthly, and quarterly obligations, showing
  what is overdue right now. The Manual's cadence, made unavoidable.
- **Claims log.** Every blocked phrase, who attempted it, on what. Useful for training and for
  proving the discipline exists if a client ever asks.
- **Audit log.** Publishes, credentials, impersonations, robots changes, all append-only.

---

## 6. Security and access control

1. **Server-side scoping on every route.** A `@ClientScoped()` Nest guard resolves `accountId`
   from the JWT and constrains every query. No endpoint trusts a client-supplied account or
   project id. This is the one class of bug that would end the practice, so it is enforced at
   the guard, tested per endpoint, and not left to controllers.
2. **Clients are read-only** except for: accepting an invite, setting a password, deciding an
   approval, completing a task, editing their own profile, and requesting a share link.
3. **No live engine access.** Clients read published snapshots only. Cost figures, run
   budgets, raw operator notes, other accounts, and in-flight runs are structurally
   unreachable, not merely hidden.
4. **`noindex, nofollow` plus `X-Robots-Tag` on the entire app origin**, and no app URLs in
   any sitemap. A firm selling crawlability cannot leak a client dashboard into an AI answer.
5. **Auth hardening.** Short access tokens, refresh rotation (already built), revoke on
   logout, rate-limited login, lockout after repeated failures, invite tokens hashed at rest
   and single-use.
6. **Impersonation is logged, read-only, and visibly banner-marked.**
7. **Data handling.** DPA and SSO are already promised on the Enterprise tier of `/pricing`,
   so the `Account` model carries the fields for them from day one even while the features are
   deferred.

---

## 7. Design direction

From `Assets/BRANDING.md`: canvas `#f7f3ea`, ink `#1a1712`, brass `#9a7a4a`, cognac
`#a85c30`, night `#14120d`. Jost for display, Inter for body. **No em dashes in any copy,
anywhere, including empty states and validation messages.**

- **Client side: light, editorial, calm.** Canvas ground, generous whitespace, hairline rules,
  one enormous Jost numeral for the score. It should read like a private practice's quarterly
  letter, not a SaaS control panel. The buyer is a founder or a CMO, and the brand promise is a
  senior operator, not a tool.
- **Operator side: denser.** Tables, forms, keyboard-first, night palette acceptable. Speed
  over elegance.
- **Empty and partial states are first-class.** "Baseline runs 12 September" beats a zero.
  "Not measured yet, this dimension is excluded from the total and the total is not
  renormalized" is the honest partial the `scoring` module already produces, stated the way the
  module means it.
- **Charts:** score over time as a line, share of voice as stacked area, sub-scores as small
  multiples. Every chart labels n, geography, surface, and date.
- Motion is restrained. Numbers count up once on load, nothing else animates.

---

## 8. Build order

One module at a time, each ending with the seven-item post-completion checklist in `AGENTS.md`.
Nothing here starts before this document is approved and the open questions in section 10 are
answered.

| Phase | Module | Ships | Definition of done |
|---|---|---|---|
| 0 | (this doc) | Decisions in section 10 resolved, tool choices confirmed | User approval |
| 1 | `accounts` | Account, Membership, User.type/accountId, Invite, one-time password set, `@ClientScoped()` guard, client login, ops Access tab, stub Overview with the score | A real client logs in, sees their real score and band, and can see nothing else |
| 2 | `engagement` | Engagement, Phase, Milestone, Update, ClientTask, Approval. Ops timeline builder and weekly composer. Client Timeline, Overview "this week" and "what we need from you" | An operator builds a timeline and publishes a weekly update, the client sees both |
| 3 | `client-reporting` | Report extension, ClientSnapshot, the SOP-11 template, the publish gate wired to `claims`, PDF. Client Visibility and Reports screens | A monthly report is published through the claims gate and read by the client |
| 4 | Work and deliverables | `gap-analysis` and `findings` client views, approvals flow with before/after diffs, deliverable files | A client approves a schema change through the portal |
| 5 | Operations polish | Plunk notification emails, share links, seats, preview-as-client, cadence board, audit log, escalations | The cadence board is the operator's home screen |

Infrastructure prerequisite before phase 1 touches a real client: **move `Cailyx/` off SQLite
onto Postgres** (Supabase is already provisioned and proven in `Cailyx-Beacon`), and confirm
the deployment target, which `MODULES-STATUS.md` section 5 still lists as an open decision.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| A client sees an unapproved or in-flight number | The publish gate and the separate snapshot read model. Clients never touch live engine tables. |
| The portal gets indexed | `noindex` plus `X-Robots-Tag` on the whole origin, no app URLs in any sitemap, verified with a crawl after launch. |
| The month-two "nothing has moved" conversation | Kickoff expectations frozen at engagement start and rendered on the timeline and the overview. The portal is designed to have that conversation continuously so it never has to happen once, badly. |
| Multi-tenant leak | Guard-level scoping, per-endpoint tests, no shared operator and client components. |
| Scope creep into a full SaaS | Phases 1 to 3 are the contract. Billing, SSO, and self-serve signup are explicitly out until the pricing question in 10.3 is answered. |
| Public promise drift | `/pricing` already sells seats, refresh cadence, and plan changes "inside the app". Whatever ships must not contradict it. Either the portal grows into it, or the pricing copy is revised. |

---

## 10. Open decisions, needed before phase 1

1. **Domain.** `app.rothenhall.com` recommended. Alternatives: `portal.rothenhall.com`, or a
   separate `cailyx.com`.
2. **Base repo.** `Cailyx/` recommended, with a Postgres migration first. `Cailyx-Beacon` stays
   internal.
3. **Is this the app `/pricing` promises?** If yes, `Account.tier` and the Stripe ledger already
   in `delivery` get wired in phase 5 and self-serve signup becomes a later flag. If no,
   `/pricing` copy needs revising.
4. **Seats.** Can a client invite their own teammates, or is provisioning operator-only in v1?
5. **Free scorecard leads.** Does a Rung-0 scorecard recipient get a login with a single screen,
   or does the portal start at the paid diagnostic? A login here doubles as the upgrade path,
   and `scorecard` already mints public share tokens either way.
6. **Founders Circle.** The free cohort presumably gets the full portal. Confirm, because they
   are also the case studies, which makes their portal the showcase.
7. **White-label.** PRD open decision 10. Per-account logo and colours in the schema now, or
   deferred?
8. **Invite email sender.** Plunk is already integrated with honest failure guards. Confirm the
   sending domain and DKIM are ready, or invites go out by hand in phase 1.
9. **Marketing site link.** Footer-only "Client login", or nav as well? Footer recommended.
