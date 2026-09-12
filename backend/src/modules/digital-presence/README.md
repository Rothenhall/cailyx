# Digital Presence Module

> **Status:** ✅ Built
> **Phase:** Wave 6 — audit pipeline, stage 2 (external presence)
> **Analysis / build spec:** [`docs/analysis/digital-presence.md`](../../../../docs/analysis/digital-presence.md)

## Purpose

Answers the question that comes before any audit score: **where does this client
exist on the internet, and what do we actually know about them?**

## Architecture

```
digital-presence/
├── digital-presence.module.ts      # NestJS module — imports Database + Fetcher + Jobs
├── presence.controller.ts          # REST API (inventory, discover, accounts CRUD, confirm, external data)
├── presence.service.ts             # Reconciliation + the cross-module inventory
├── presence.discovery.service.ts   # Crawl → extract → verify
├── presence.serp.service.ts        # Google sweep (DataForSEO) → candidates, opt-in
├── presence.dataforseo.service.ts  # DataForSEO Business Data (wave-6 D2) — profile + reviews
├── presence.apify.service.ts       # Apify social activity (wave-6 D7) — opt-in, spends real credit
├── presence.signatures.ts          # URL → platform classification (the false-positive gate)
├── presence.types.ts               # PresencePlatform, PresenceState, inventory shapes
├── dto/presence.dto.ts             # Validated DTOs
└── README.md                       # This file
```

## The five rules this module exists to enforce

### 1. Three account states, never two

| State | Meaning |
|---|---|
| `confirmed` | Found, fetched, resolved |
| `unverified` | Found on the client's own site, but the platform refused the check |
| `missing` | No link anywhere, nothing supplied by hand |
| `candidate` | Found by **search** — we do not know it is theirs (see below) |

A logged-out fetch **cannot** verify most social profiles: Instagram and Facebook
serve login walls, LinkedIn answers datacentre IPs with `999`, X requires auth.
Our Apify plan is `FREE` — datacentre proxies only — which is the worst case for
exactly these hosts.

So `unverified` is the routine, honest outcome for the platforms that matter
most. Collapsing it into `missing` would report a working account as absent and
send an operator to fix something that is fine. Those platforms are not fetched
at all: spending a request to be told "log in" gives the same answer more slowly,
while looking like a scraping attempt.

Every `unverified` row carries the platform's own reason, printed verbatim.

### 2. Most links to a social host are not accounts

`facebook.com/sharer/sharer.php`, `twitter.com/intent/tweet`,
`linkedin.com/shareArticle`, `pinterest.com/pin/create/` and bare hostnames all
match a naive `includes('facebook.com')`, and every one would be reported to a
client as their account.

A candidate must clear three gates in `presence.signatures.ts`: **host match**,
**reject-pattern miss**, and a **handle matching the platform's own shape**.
Failures are dropped silently — a false account in a presence report is worse
than a missing one, because nobody has reason to doubt it.

Handles are case-folded where the platform is case-insensitive (`foldCase`), with
`caseSensitivePath` carving out YouTube's `channel/UCxxx` ids. Without this,
HubSpot's `tiktok.com/@HubSpot` in JSON-LD and `@hubspot` in the footer store as
two accounts.

### 3. A search hit is a candidate, not an account

The site crawl only finds what the client chose to link. Google finds the rest —
but it cannot tell the client's profile from a stranger's. Live evidence:

```
site:instagram.com "HubSpot"
  instagram.com/hubspot/            theirs
  instagram.com/hubspotlife/        theirs (employer brand)
  instagram.com/hubspotacademy/     theirs
  instagram.com/reel/DWVj-HrjmeU/   a reel — the classifier rejects it
  instagram.com/hubshotspodcast/    a different company entirely
```

Worse for thresholds: for Notion the **top** name match (`instagram.com/notion`,
100%) is *not* the official account — `@notionhq` at 75% is. So `confidence` is
an ordering hint for a human and **no code branches on it**.

SERP rows therefore land as `state: 'candidate'`, `source: 'serp'`. They are
excluded from every count, cannot close a gap, and become accounts only through
`POST /accounts/:accountId/confirm` — after which they are `manual` and survive
re-runs like any hand-typed URL.

### 4. An author-declared `sameAs` is never dropped for want of a signature

A `sameAs` entry is the site's own author asserting *"this is us"*. There is no
ownership ambiguity to protect against — only a gap in our signature table. So an
unrecognised `sameAs` URL is kept as `platform: 'other'` ("Declared profile")
rather than discarded.

Found on a real site: `rothenhall.com` declares
`scholar.google.com/citations?user=…` in its `sameAs`. With signature-matching
alone that profile vanished silently — a client's declared identity, lost to a
missing regex. Self-references (a `sameAs` pointing at the client's own host) are
still skipped.

This rule applies to `sameAs` only. A *page link* that matches no signature is
still dropped, because there the classifier is protecting against share widgets.

### 5. The audit is about the **company**, not the founder

A founder's personal LinkedIn (`/in/…`), Google Scholar profile or ORCID record
are real and worth recording — and they are **not** the company's digital
footprint. Counting them as such inflates the picture and answers a question
nobody asked.

Found on a real site: `rothenhall.com` declares an `Organization` whose `sameAs`
is the company LinkedIn, *and* a `Person` whose `sameAs` is a personal LinkedIn
plus a Google Scholar page. Reported flat, that reads as **3 company profiles**.
The truth is **1**.

Every row carries `entity`: `company` | `personal` | `unknown`. Personal rows are
excluded from `counts.total`, cannot close a gap, and render in their own section
below the company footprint.

How it is decided, best signal first:

1. **The schema block's `@type`** — a `sameAs` under `Person` is a person's, one
   under `Organization` is the company's. The site tells us; we do not guess.
2. **The URL shape** — `linkedin.com/company/x` is the business,
   `linkedin.com/in/x` is a person. `scholar.google.com` and `orcid.org` are
   always personal.
3. **Default `company`** — the likelier reading for a brand-named handle.

The SERP sweep searches `site:linkedin.com/company` for the same reason: an
unscoped LinkedIn search returns founders, which is not what a company footprint
is asking for.

## What "expected" means depends on the business

The gap list is what a delivery lead has to explain, so a universal list is wrong
in both directions — it flags a consultancy for having no TikTok while never
asking whether it has a Clutch profile. `EXPECTED_BY_PROFILE` keys the expected
platforms on an inferred business type:

| Business type | Expected |
|---|---|
| B2B services / consultancy | LinkedIn, X, Clutch, Crunchbase, Glassdoor |
| B2B software | LinkedIn, X, G2, Capterra, Crunchbase, GitHub |
| Local services | Facebook, Instagram, Yelp, Trustpilot, LinkedIn |
| Consumer brand | Instagram, Facebook, TikTok, YouTube, Trustpilot |
| *not identified* | the generic social set, and the assessment says so |

The type is inferred from the client's own category text (`SiteContext.category`,
falling back to `Project.category`) — a heuristic, so the assessment prints both
the type and the text it came from, making a wrong guess arguable rather than
invisible.

Before this, the expected set was social-only, which left **four of stage 2's five
categories permanently reading "not checked"** — the module could not report a
missing directory or review presence because it never expected one.

## The assessment — stage 2's "analyse" column

`GET /presence` returns an `assessment`: the read on the company's current state
online. It mirrors the delivery flow's stage 2, which pairs every *discover* step
with an *analyse* step:

| Discover | Analyse |
|---|---|
| Social Media Profiles | Analyze Social Activity |
| Industry / Business Directories | Analyze Directory Presence |
| Business / Brand Profiles | Analyze Profiles |
| Relevant Marketplaces | Analyze Marketplace Presence |
| Review Platforms | Analyze Reviews |

- `headlines` — plain language, worst first. Facts and absences; no score.
- `coverage` — per category: `covered` / `partial` / `absent` / `not-checked`.
- `notMeasured` — **what the module cannot see yet**, named explicitly. Social
  activity, review content and directory completeness are all listed as
  unmeasured rather than implied to be absent. An audit that reports six findings
  while hiding that it never looked at reviews is worse than one that reports five
  and says so.

## Discovery sources (precedence order)

1. **JSON-LD `sameAs`** — author-declared, machine-readable. Wins ties.
2. **On-page links** — higher recall, needs the signature gate.
3. **Google search (DataForSEO)** — candidates only, opt-in per run.
4. **Operator-supplied** — outranks all, **never overwritten by a re-run**.

### URL canonicalisation

Both the crawl and the SERP return the same account many ways. Three collapses
keep one account to one row:

- **Sub-paths** — `/company/acme`, `/company/acme/life`, `/company/acme/jobs`,
  `/company/acme/about` are one account. The matched prefix becomes the URL.
- **Locale subdomains** — `linkedin.com`, `do.linkedin.com`, `ar.linkedin.com`
  collapse onto the base host. (Substack, where the subdomain *is* the account,
  is handled before this and unaffected.)
- **Case** — per-platform `foldCase`, with `caseSensitivePath` exempting
  YouTube's `channel/UCxxx` ids, which break if lowercased.

Without these, one live Notion sweep produced **20 rows for 16 accounts**.

## REST API

| Method | Endpoint | Rate limit | Description |
|---|---|---|---|
| `GET` | `/api/projects/:id/presence` | default | Full inventory: accounts, gaps, footprint, business profile, reviews, social activity, last run |
| `POST` | `/api/projects/:id/presence/discover` | 5/60s | Crawl the site, classify, verify |
| `GET` | `/api/projects/:id/presence/discoveries` | default | Run history (newest first) |
| `POST` | `/api/projects/:id/presence/accounts` | default | Add by URL (platform derived from it) |
| `POST` | `/api/projects/:id/presence/accounts/:accountId/confirm` | default | Accept a search candidate as a real account |
| `PATCH` | `/api/projects/:id/presence/accounts/:accountId` | default | Correct a URL |
| `DELETE` | `/api/projects/:id/presence/accounts/:accountId` | default | Remove |
| `POST` | `/api/projects/:id/presence/business-profile` | 5/60s | **(wave-6 D2)** DataForSEO Business Data pull — profile + review counts. 503 without `SWARM_ALLOW_LIVE`/`DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` |
| `POST` | `/api/projects/:id/presence/social-activity` | 2/60s | **(wave-6 D7)** Apify social-activity pull. **Opt-in only** — requires `confirmSpend: true`; spends real Apify account credit |
| `POST` | `/api/projects/:id/presence/brand-voice` | 5/60s | Synthesize tone/themes/vocabulary/CTAs from stored `PresencePost` captions via `presence.llm.service.ts`. `extraction: "insufficient-data"` with &lt;3 captions or no LLM key |
| `GET` | `/api/projects/:id/presence/brand-voice` | default | Latest stored brand-voice read; 404 if `/brand-voice` has never been run |
| `POST` | `/api/projects/:id/presence/directory-ratings` | 5/60s | Read published ratings for the client's own discovered G2/Capterra/Trustpilot/Glassdoor/Yelp/Clutch/Crunchbase/Product Hunt listings — no vendor, free. Stored as `PresenceReview` rows tagged `source: "schema-scrape"` |

`POST /accounts` takes **only a URL**. The operator already encoded the platform
when they copied the link; a dropdown would add only a way to disagree with it.

## The wider footprint

`GET /presence` also assembles what the other modules discovered, each line
labelled with its source module:

| Section | Source |
|---|---|
| Identity — brand, category, market, services, ICP | `aeo-audit` (`SiteContext`) |
| Owned properties — domain, pages crawled, sitemap | `aeo-audit`, `technical-audit` |
| Connected data — GSC, GA4, SEO audit | `google`, `seo-audit` |
| Answer engines — audit status, engines measured | `aeo-audit` |
| Competitors — named rivals | `intake`, `aeo-audit` |

Footprint rows are three-valued too: **`not-checked` is not `none`.** A module
that never ran and a module that ran and found nothing are different answers.

## Dependencies

- **Modules:** `DatabaseModule`, `FetcherModule`, `JobsModule`
- **npm:** `cheerio` (already present)
- **External services:** DataForSEO (optional — the Google sweep only), DataForSEO
  Business Data (optional — business profile + reviews), Apify (optional,
  opt-in per call — social activity)

## Environment variables

| Name | Default | Description |
|---|---|---|
| `PRESENCE_SERP_MAX_QUERIES` | `20` | Hard ceiling on TOTAL search queries per sweep, across every platform × name-variant combination (not per platform) — raised from an earlier single-query-per-platform default of 5 once the sweep started trying multiple name variants per platform. |
| `SWARM_ALLOW_LIVE` | `0` | Master switch shared with `serp-intelligence` — must be `1` before a paid DataForSEO Business Data call is made. |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | — | DataForSEO credentials — one account shared by the Google sweep, `serp-intelligence` and `keyword-research`. **Set in this repo's `backend/.env`** and verified live against the free `/v3/appendix/user_data` endpoint. Absent → the sweep skips with a stated reason (the crawl is unaffected) and `POST /business-profile` returns a 503 naming exactly what is missing. Present is still not enough to spend: `SWARM_ALLOW_LIVE=1` gates every billable call. |
| `PRESENCE_BUSINESS_LOCATION` | `United States` | Default location for the business-profile lookup when the project has none on record. A single generic fallback, not full market resolution. |
| `PRESENCE_LLM_MODEL` / `PRESENCE_LLM_TIMEOUT_MS` / `PRESENCE_LLM_ANTHROPIC_MODEL` | see `.env.example` | This module's own LLM caller (`presence.llm.service.ts`) for brand-voice synthesis — same OpenRouter-preferred, Anthropic-fallback, honest-degradation discipline as `aeo-audit`'s `AEO_LLM_*`. |
| `APIFY_API_KEY` | — | Apify account key (lives in the monorepo root `.env`, real value, never logged). Absent → `POST /social-activity` returns a 503. Configuring it is **not** enough to spend anything — see below. |
| `APIFY_ACTORS` | built-in D7 map | JSON `{"platform:role": "actorId"}` override/extension of the built-in actor map. Malformed JSON is logged and ignored (falls back to the built-in map). |
| `APIFY_PLATFORMS` | `linkedin,instagram,facebook,twitter` | Platforms pulled when a request does not name its own. YouTube/TikTok are supported but off by default (D7). |
| `APIFY_POSTS_PER_PLATFORM` | `20` | Recent posts pulled per platform per run. D7's cost table is priced against 20. |

**The crawl costs nothing external.** The Google sweep is the only billed path,
at one credit per platform, and is **opt-in per run** (`searchWeb: true`) — so a
default scan and the whole smoke harness stay at zero spend. It queries only
platforms still missing after the crawl: a client holding 4 of 5 costs 1 credit,
not 5.

**Business-profile pulls cost DataForSEO credits** per call and are always
explicit (`POST /business-profile`), never triggered by `GET /presence`.

**Social-activity pulls cost real Apify account credit** ($5/month usage cap
on the `FREE` plan) and require `confirmSpend: true` on every call — configuring
`APIFY_API_KEY` alone never causes a run. `GET /presence`'s `socialActivity[]`
only reads rows a prior explicit run already stored.

## Consumers

- `frontend/src/app/v2/_components/DigitalPresence.tsx` — card above Audits
- `frontend/src/app/v2/_components/DigitalPresenceWorkspace.tsx` — full inventory

## Database

`PresenceAccount` (unique on `projectId + platform + url`), `PresenceDiscovery`,
`PresenceProfile` + `PresenceReview` (wave-6 D2 — DataForSEO, append-only
snapshots), `PresencePost` (wave-6 D7 — Apify, `kind: "profile" | "post"`,
optionally linked to a `PresenceAccount`).

## PRD alignment

| Requirement | Status | Notes |
|---|---|---|
| Discover client's social accounts | ✅ | JSON-LD `sameAs` + on-page links, signature-gated |
| Operator supplies accounts when discovery finds none | ✅ | `POST /accounts`, URL only; survives re-runs |
| Show all discovered digital presence, not just social | ✅ | `footprint[]` across 5 modules |
| Find accounts the site does not link | ✅ | Google sweep via DataForSEO — as candidates needing confirmation, never as accounts |
| Business profile + review ratings | ⚠️ Built, gated on `SWARM_ALLOW_LIVE` | `POST /business-profile` (wave-6 D2) — credentials are set; the master paid-vendor switch is deliberately not. Fails closed with a 503 naming what is missing, never a fabricated profile |
| Social activity / followers / cadence | ⚠️ Built, opt-in only | `POST /social-activity` (wave-6 D7) — never called live in this repo; requires `confirmSpend: true` on every call since it spends real Apify account credit |
| Verify social profiles resolve | ⚠️ Partial | Honest by design — walled platforms report `unverified` with the reason, never a guess |

## Testing

`backend/smoke/digital-presence.smoke.sh`. Covers: empty inventory as a valid
answer, `not-checked` present before any module runs, discovery on an
unreachable domain completing honestly (0 pages / 0 found, no crash), the
manual path end to end, LinkedIn landing as `unverified` *with* its reason, six
false-positive URLs rejected with 400, gaps shrinking as accounts are supplied,
**a re-scan not clobbering operator input**, tracking-param dedupe, and
delete/404. It also asserts the **zero-spend contract**: a default discovery
run must spend no search credits and must state why it did not search.

**Wave-6 step 5 additions**, also zero-spend: the business-profile pull is
asserted to fail closed with a 503 (DataForSEO credentials are genuinely
absent here — never a live call, never a fabricated profile), and the
social-activity pull is asserted to refuse to run — and to store nothing —
without a genuine `confirmSpend: true`. **No live Apify call is made anywhere
in this suite, or anywhere in this module's development**; `APIFY_API_KEY` is
a real key with real account spend attached, and the only safe way to keep
this harness zero-spend is to never exercise the path that would use it.

Live-verified twice against `notion.so` with the sweep on: 5 queries → 16
candidates, correctly ordered, with the invariants holding (`counts.total` 0,
all five gaps still open). A targeted run holding 4 of 5 platforms spent **1**
credit, confirming the missing-only targeting.

Live-verified against `hubspot.com`: 4 pages read, **8 accounts** across both
sources (5 JSON-LD, 3 page-link), correct handles, zero share-widget false
positives on a site full of them, and the three verifiable platforms
(App Store, Google Play, YouTube) confirmed while the five walled ones reported
`unverified` with reasons.

## SERP provider (2026-09-13)

The Google sweep runs on **DataForSEO**, through `DataForSeoSerpService` exported
by `serp-intelligence` — the same funded account behind rankings and keyword
research. It was Serper.dev: a second vendor at a higher per-query price for a
search this account already covered.

| Control | Effect |
|---|---|
| 7-day response cache | Largest saving. A `site:` result does not move hour to hour |
| Cache hits excluded from `serpQueries` | A free run must not look like a paid one, or the budget guard refuses it |
| `depth: 10` fixed | DataForSEO bills per 10 results; 20 costs double |
| Opt-in per run (`searchWeb: true`) | A default scan and the whole smoke harness stay at zero spend |
| Only still-missing platforms searched | A fully-discovered client costs nothing |
| `serpCostUsd` per run | Real charge from the response envelope, never estimated |

Gated on `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` **and** `SWARM_ALLOW_LIVE=1`.
Without both, the sweep skips with the reason stated and the free site crawl is
unaffected.
