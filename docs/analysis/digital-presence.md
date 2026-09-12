# Digital Presence — discovery, gaps, and operator-supplied accounts

> **Status:** ✅ built (SERP candidate discovery added 2026-09-11)
> **Wave:** 6 (sits under stage 2 "external presence", ahead of the Apify step)
> **Asked for:** *"a new component in the UI above the audit section showing the
> progress of the discovery, like how many accounts we found. If we are not able
> to find any accounts, we need to allow the user to enter their accounts
> themselves… Not just social — whatever digital presence we have found for that
> client, we need to be showing that in the UI."*

---

## 1. What this is

One question, answered before any audit runs: **where does this client exist on
the internet, and what do we actually know about them?**

Today the console opens on the Audits card, which is a set of scores. Nothing
tells the operator what was *found* — which social accounts exist, which
directories list them, what the crawl learned, what is connected. That inventory
is the first thing a delivery lead needs and the first thing a client asks about,
and right now it is scattered across six modules and visible in none of them.

This module builds the inventory, and gives the operator a way to fill the holes
by hand when discovery comes up empty.

---

## 2. Verified current state

Everything below was read in the codebase, not assumed.

| Capability | Where | State |
|---|---|---|
| Crawl a site, follow links | `fetcher`, `intake` | ✅ built |
| Extract JSON-LD incl. `sameAs` | `fetcher.fetchSchema()`, `entity-audit` schema check | ✅ built — `sameAs` is **where social profile URLs live** |
| Verify one URL resolves + title identity | `fetcher.verifyUrl()` | ✅ built |
| Manual profile entry | `entity-audit` `PlatformRecord` | ⚠️ built, but `Platform` is only `linkedin \| g2 \| crunchbase \| other` |
| Social links seen while crawling | `intake.service.ts` `NON_COMPETITOR_HOSTS` | ⚠️ **parsed and then discarded** |
| Social account discovery | — | ❌ does not exist |
| Social activity / followers | wave-6 step 5 (Apify) | ❌ not built |
| GSC / GA connection state | `google`, `integrations` | ✅ built |
| Site context (brand, services, competitors) | `aeo-audit` `SiteContext` | ✅ built |
| Competitors | `Project.competitors` JSON, `intake` | ✅ built |

**The cheapest finding here:** `intake.service.ts` already parses every outbound
link on the homepage and classifies `linkedin.com`, `instagram.com`,
`facebook.com`, `youtube.com`, `x.com` as `NON_COMPETITOR_HOSTS` — purely to
exclude them from competitor extraction. The accounts the operator is asking for
are already passing through that function and being thrown away. Discovery is
mostly a matter of keeping them.

---

## 3. The constraint that shapes the design

**A logged-out fetch cannot verify most social profiles.** Instagram and Facebook
serve a login wall; LinkedIn returns `999` to datacentre IPs; X requires auth for
most profile reads. Our Apify plan is `FREE`, which is **datacentre proxies only**
(recorded in wave-6 D7) — the worst case for exactly these hosts.

So a two-state model — found / not found — would be a lie. A profile URL printed
in the client's own footer, which we then fail to fetch, is not a missing account.
Reporting it as missing would send an operator to "fix" something that is fine,
and would show a client an inventory of their own web presence that is wrong.

**Three states, always distinguished in the UI:**

| State | Meaning | Shown as |
|---|---|---|
| `confirmed` | Found, fetched, and it resolved | ✅ with the URL |
| `unverified` | Found on the client's own site, but the platform blocked or refused the check | ⚠️ "found, not verifiable" + why |
| `missing` | No link anywhere on the site, and nothing supplied by hand | ○ "not found" + *Add* |
| `candidate` | Found by **search**, not by the client's site — we do not know it is theirs | Own tab, "Yes, this is us" / "Not us" |

`unverified` is the honest default for Instagram, Facebook, LinkedIn and X on our
current plan. It is not a failure; it is the truthful answer to a question we
cannot ask from here.

Provenance is carried separately from state, and never averaged with it:
`json-ld-sameas`, `page-link`, `manual`, `serp`.

---

## 4. Decisions

### DP1 — A new `digital-presence` module, not an extension of `entity-audit` ✅ *recommended*

`entity-audit` answers *"does AI describe you consistently?"* — its
`PlatformRecord` exists to compare a **descriptor** across platforms, and its
platform list (`linkedin | g2 | crunchbase`) reflects that: authority sources,
not social accounts. Widening it to Instagram and TikTok would overload a type
whose consistency-checking logic has no meaning there (an Instagram bio is not a
company descriptor to diff).

A separate module keeps both honest, and `digital-presence` can link to
`entity-audit` entities later without either owning the other.

**Rejected alternative:** storing accounts as JSON on `Project`, like
`competitors`. That column is already a known wart — untyped, unqueryable, and
awaiting migration to real rows in wave-6 step 6. Repeating it would add a second
migration to do later.

### DP2 — Site-derived accounts; search-derived candidates ✅ *revised 2026-09-11*

Sources, in precedence order:

1. **JSON-LD `sameAs`** — explicit, machine-readable, author-declared. Highest trust.
2. **On-page links** — footer/header/contact links matched against a host
   signature table. High recall, needs handle-shape validation to avoid
   capturing `facebook.com/sharer.php` share buttons as accounts.
3. **Operator-supplied** — always wins over both, never overwritten by a re-run.

**SERP discovery — added 2026-09-11, as `candidate` rows only.** Originally
deferred on cost. On the funded DataForSEO account that objection is gone, but the
*accuracy* objection never was, and the live data settles it. A real
`site:instagram.com "HubSpot"` returns:

```
instagram.com/hubspot/            <- theirs
instagram.com/hubspotlife/        <- theirs (employer brand)
instagram.com/hubspotacademy/     <- theirs
instagram.com/reel/DWVj-HrjmeU/   <- a reel; the classifier rejects it
instagram.com/hubshotspodcast/    <- a different company entirely
```

And for Notion, the **highest** name-similarity hit (`instagram.com/notion`,
100%) is *not* the official account — `@notionhq` at 75% is. A threshold would
have picked wrong. So similarity is stored as an ordering hint and **nothing
branches on it**.

Therefore SERP results land as `state: 'candidate'` with `source: 'serp'`:
excluded from every count, unable to close a gap, and promoted only by an
operator's explicit yes (`POST /accounts/:id/confirm`), which turns them into
`manual` rows that survive re-runs.

**Cost control, three layers:** the sweep is **opt-in per run** (`searchWeb:
true`) so the free crawl and the zero-spend smoke harness never bill; it queries
**only platforms still missing** after the crawl (a client with 4 of 5 held costs
1 credit, not 5); and `PRESENCE_SERP_MAX_QUERIES` (default 5) caps any single
run.

### DP3 — Share-button and intent-link rejection is part of the extractor ✅

`facebook.com/sharer/sharer.php?u=…`, `twitter.com/intent/tweet`,
`linkedin.com/shareArticle`, `wa.me/?text=` and `pinterest.com/pin/create/` all
appear on ordinary marketing sites and are **not accounts**. They are the single
biggest false-positive source for this kind of extractor. The signature table
carries per-platform reject patterns and a handle shape, and a candidate must
match the shape to be kept.

### DP4 — The card summarises; a workspace holds the detail ✅

The `.v2-audits` column is ~320px and disappears entirely below 1000px. The full
inventory — accounts, directories, connections, crawl, competitors — does not fit
there and never will.

So: a compact card **above** the Audits card showing the counts and the gaps, which
expands into a full-canvas workspace on click. This is the same grid→detail move
the Technical, SEO and AEO tiles already make (`expanded` state on `/v2/page.tsx`),
so it costs no new interaction concept.

### DP5 — "Digital presence" means more than social ✅ *explicitly asked for*

The workspace aggregates what every module already discovered, each labelled with
the module that found it:

| Group | Source module | Examples |
|---|---|---|
| Social accounts | this module | LinkedIn, Instagram, Facebook, X, YouTube, TikTok |
| Listings & authority | this module + `entity-audit` | Crunchbase, G2, Trustpilot, Glassdoor, App Store |
| Owned properties | `technical-audit`, `fetcher` | Domain, pages crawled, sitemap, blog, subdomains |
| Identity | `aeo-audit` `SiteContext` | Brand, category, services, ICP, markets |
| Connected data | `google`, `integrations` | GSC, GA4 — connected or not |
| Answer-engine presence | `aeo-audit` | Audits run, engines measured |
| Competitors | `Project.competitors`, `intake` | Named rivals |

Each group reports **found / not found / not checked** — never a blank. "Not
checked" is a real and different answer from "not found", and the operator needs
to know which one they are looking at.

---

## 5. Data model

```prisma
model PresenceAccount {
  id          String   @id @default(cuid())
  projectId   String
  platform    String   // linkedin | instagram | facebook | x | youtube | tiktok | …
  url         String
  handle      String?
  source      String   // json-ld-sameas | page-link | manual
  state       String   // confirmed | unverified | missing
  // Why a check could not be made — login-wall, blocked, http-999, timeout.
  // Populated only when state = unverified; the UI prints it verbatim.
  reason      String?
  statusCode  Int?
  title       String?
  foundOn     String?  // page the link was found on
  verifiedAt  DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@unique([projectId, platform, url])
  @@index([projectId, platform])
}

model PresenceDiscovery {
  id           String   @id @default(cuid())
  projectId    String
  status       String   // pending | crawling | verifying | completed | failed
  pagesFetched Int      @default(0)
  found        Int      @default(0)
  confirmed    Int      @default(0)
  unverified   Int      @default(0)
  sources      String?  // JSON: per-source counts, for provenance in the report
  error        String?
  startedAt    DateTime @default(now())
  finishedAt   DateTime?

  @@index([projectId, startedAt])
}
```

Manual rows are never deleted by a re-run. A discovery run reconciles: it may
promote a `missing` platform to `confirmed`, but an operator-supplied URL is
authoritative and is only re-verified, never replaced.

---

## 6. API surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/:id/presence` | The full inventory — every group in DP5 |
| `POST` | `/api/projects/:id/presence/discover` | Run discovery (crawl + classify + verify) |
| `GET` | `/api/projects/:id/presence/discoveries` | Run history |
| `POST` | `/api/projects/:id/presence/accounts` | Operator adds an account by URL |
| `PATCH` | `/api/projects/:id/presence/accounts/:accountId` | Correct one |
| `DELETE` | `/api/projects/:id/presence/accounts/:accountId` | Remove one |

`POST /accounts` takes **just a URL**. The platform and handle are derived from
the host via the same signature table discovery uses — asking an operator to pick
a platform from a dropdown they already encoded in the URL they pasted is a form
doing the user's work in reverse.

---

## 7. Frontend

- **`DigitalPresence.tsx`** — the card, above Audits. Counts by state, the
  platforms with gaps, a *Discover* button when nothing has run, and a one-field
  *Add account* input. Must be readable at 320px.
- **`DigitalPresenceWorkspace.tsx`** — full canvas, five tabs mirroring DP5's
  groups, each row carrying its source module and its state.
- `expanded` on `/v2/page.tsx` widens to include `'presence'`.

---

## 8. Cost

**Zero external spend by default.** The Google sweep is the only billed path and
it is opt-in per run (`searchWeb: true`), so this stays true for every default
scan and for the whole smoke harness.

| Env var | Default | Purpose |
|---|---|---|
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | unset | The shared DataForSEO account, same one `serp-intelligence` and `keyword-research` use. Absent → the sweep skips with the reason stated. |
| `SWARM_ALLOW_LIVE` | unset | Master paid-vendor switch. Must be `1` before any billable SERP call; otherwise the sweep skips. |
| `PRESENCE_SERP_MAX_QUERIES` | `5` | Hard ceiling on queries per run. |

**Crawl path:** Discovery is `fetcher` against the client's own site
(already cached, already rate-limited) plus at most one HEAD-equivalent per
discovered URL. No Apify, no SERP, no LLM. The Apify enrichment in wave-6 step 5
attaches to these rows later — this module defines the accounts that step will
enrich, which is why it belongs before it rather than after.

---

## 9. Open question

**Does the client-facing report show `unverified` as-is?** Internally it is the
honest state. In a client deliverable, "found, not verifiable" may read as
incompetence rather than as the platform's refusal. My recommendation is to keep
the state but change the wording for client output — "live on Instagram
(verification blocked by the platform)" — and never silently promote it to
confirmed. Flagging rather than blocking; the module ships either way.
