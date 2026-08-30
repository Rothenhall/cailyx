# Cailyx MCP Server — Plan

> Status: Draft plan, not yet approved for build. Written 2026-08-30, expanded 2026-08-30.
> Companion to `AGENTS.md` (analysis-before-code rule) and `docs/PRD.md` §08 (scoring dimensions).

## 1. Context

Cailyx today is a web product: a customer's site is audited by the Cailyx backend, and results live in the Cailyx dashboard as reports/scorecards. The new ask is a second distribution channel: an **MCP (Model Context Protocol) server** that a Cailyx customer installs locally and connects to their own AI coding assistant (Claude Code, Cursor, etc.). That assistant already has read/write access to the customer's actual source repository. The MCP server's job is to combine what Cailyx already knows how to measure (crawler access, schema, on-page structure, entity clarity, findings) with a capability Cailyx doesn't have today — locating the exact source file responsible for each problem — and hand back detailed, evidence-backed, file-level remediation instructions ("what / how / where") that the customer's own coding agent can implement directly. Cailyx's MCP never edits the customer's code itself; it advises, and the customer's own agent does the writing.

**What exists today, confirmed by code read:** Cailyx has no service-to-service auth — only human-login JWT (15-min access token, rotating refresh token, global `JwtAuthGuard`). There is no existing MCP code or dependency anywhere in the repo. Domain-module services (`technical-audit`, `page-analysis`, `gap-analysis`, `findings`) operate purely against live URLs/DB rows — none read local source files, and no Prisma model (`AuditFinding`, `Gap`, `Finding`) has a file-path/location field. Both are new capabilities this plan introduces.

## 2. Decisions

1. **Auth** — new per-project API key ("connect token"), generated from the Cailyx dashboard, pasted into the customer's local MCP config. Standard local-dev-tool pattern (Sentry CLI, Vercel CLI). Keys are prefixed (`cailyx_live_...`), shown once at creation, and scoped `read` or `read_write` — a leaked read-only key can't spend money.
2. **Tool shape** — 5 consolidated tools (`audit`, `status`, `fix_plan`, `ask`, `find_opportunities`), each parameterized rather than one tool per audit factor. Full schemas in §9.
3. **v1 scope** — ship the connect mechanism + MCP scaffold + `audit` with `category: bot_access` end-to-end first. Recommended first factor: **Machine Access** (robots.txt / AI-bot crawl blocks / schema.org presence, from `technical-audit`) — PRD Phase 1 calls this the cheapest, most reproducible finding, the module is fully built, and its fixes are literally file/config changes. *(Pending your final confirmation.)*

## 3. Architecture

```
Customer's machine
  ├─ their coding agent (Claude Code / Cursor / etc.)
  │     └─ spawns → cailyx-mcp (stdio MCP server, new package)
  │                    ├─ reads customer's local repo (fs access, same process)
  │                    └─ calls → Cailyx backend (HTTPS, /mcp/v1/*, API-key-authed)
  │                                  └─ reuses existing TechnicalAuditService etc.
  └─ customer's actual source repo (unchanged by any of this — no writes, ever)
```

New top-level package `mcp-server/` (sibling to `backend/`, `frontend/`), TypeScript, `@modelcontextprotocol/sdk`, stdio transport — a local child process, not a hosted service. Distributed later as an npm package; packaging is a later concern.

Three non-negotiable principles carried through every section below: (a) **reuse, never reimplement** — live-site checks stay server-side, calling the existing services; (b) **the customer's source code never leaves their machine** — the MCP server reads files locally and only ever sends path strings and short evidence snippets over the wire, never full file contents; (c) **evidence-graded, never a flat guess** — anything inferred (a file match, a framework, a competitor) carries a confidence label, same discipline the `claims` module already enforces.

## 4. Backend change requirements

### 4.1 New modules and files

| File | Purpose |
|---|---|
| `backend/src/modules/mcp-access/mcp-access.module.ts` | New NestJS module — key issuance/revocation + the `/mcp/v1/*` gateway controllers |
| `backend/src/modules/mcp-access/mcp-access.service.ts` | Key CRUD, hashing, scope checks, call logging |
| `backend/src/modules/mcp-access/mcp-access.controller.ts` | `POST/GET/DELETE /mcp-access/keys` (JWT-guarded — dashboard-only, not the MCP server itself) |
| `backend/src/modules/mcp-access/mcp-gateway.controller.ts` | `/mcp/v1/*` routes the MCP server actually calls (API-key-guarded) |
| `backend/src/common/guards/api-key.guard.ts` | Parallel to `JwtAuthGuard`: reads `X-Cailyx-Api-Key`, resolves `projectId` + `scope`, updates `lastUsedAt`, writes a `McpCallLog` row, rejects `read`-scoped keys on run-triggering routes |
| `backend/src/common/decorators/api-key.decorators.ts` | `@RequireScope('read' \| 'read_write')` route decorator, mirrors the existing `@Roles()` pattern in `auth.decorators.ts` |

### 4.2 Module-system integration

`mcp-access` does not duplicate any audit logic — it injects the existing services directly:

- Import `TechnicalAuditModule`, `EntityAuditModule`, `PageAnalysisModule`, `MeasurementModule`, `GapAnalysisModule`, `FindingsModule`, `ClaimsModule`, `ScoringModule`, `AuthorityModule`, `MentionTrackingModule`, `InternalLinkModule`, `SleeperRefreshModule` as needed per tool (only `TechnicalAuditModule` for the v1 `audit`/`bot_access` slice).
- **Build-time check**: confirm each of those modules actually `exports: [XyzService]` — Nest DI requires an explicit export for cross-module injection. Several existing modules may only export their controller-facing service implicitly; add `exports` where missing as part of this work, not a new pattern.
- `mcp-gateway.controller.ts` stays a thin translation layer: validate → call the existing service method → shape the response per §9's output schema → return. No business logic lives here.
- Registered in `app.module.ts` alongside the other feature modules, same as every existing module.
- New env vars (`MCP_KEY_RATE_LIMIT_PER_HOUR`, `MCP_LIVE_QUERY_MAX_COST_PER_KEY`) go through the existing `ConfigModule`/`configuration.ts` pattern, validated the same way `TA_*` thresholds already are.

### 4.3 New/changed endpoints

| Method & path | Scope required | Wraps |
|---|---|---|
| `POST /mcp-access/keys` | JWT (dashboard user) | Issues a key, returns the full value once |
| `GET /mcp-access/keys` | JWT (dashboard user) | Lists keys for a project (prefix + metadata only, never the full key) |
| `DELETE /mcp-access/keys/:id` | JWT (dashboard user) | Revokes a key |
| `GET /mcp/v1/whoami` | `read` | Startup self-check — confirms the key is valid and returns the bound project name |
| `POST /mcp/v1/technical-audit/run` | `read_write` | `TechnicalAuditService.runAudit` |
| `GET /mcp/v1/technical-audit/latest` | `read` | Existing read path |
| *(later, per-tool, added one at a time alongside each new `category`/`mode`/`type` value)* | | |

## 5. Database requirements

### 5.1 New model — `ApiKey`

```prisma
model ApiKey {
  id         String    @id @default(cuid())
  projectId  String
  project    Project   @relation(fields: [projectId], references: [id])
  name       String
  keyPrefix  String    // e.g. "cailyx_live_ab12", stored in the clear for identification/leak-scanning
  hashedKey  String    // SHA-256, same pattern as auth.service.ts refresh-token hashing
  scope      String    // "read" | "read_write"
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?
  revokedAt  DateTime?
}
```

### 5.2 New model — `McpCallLog`

Needed for the observability requirement (§4.1 guard) and for future billing/support ("why did my key stop working", "what did this key cost us this month"):

```prisma
model McpCallLog {
  id         String    @id @default(cuid())
  apiKeyId   String
  apiKey     ApiKey    @relation(fields: [apiKeyId], references: [id])
  projectId  String
  route      String    // e.g. "technical-audit/run"
  tool       String?   // e.g. "audit" — set once the MCP-facing tool layer is live
  category   String?   // e.g. "bot_access"
  costUsd    Float     @default(0)
  latencyMs  Int
  status     Int       // HTTP status returned
  createdAt  DateTime  @default(now())
}
```

### 5.3 What does *not* change

No new `filePath`/`location` field is added to `AuditFinding`, `Gap`, or `Finding`. The finding-to-file mapping is computed fresh, client-side, on every MCP response — it is never persisted to Cailyx's database, because doing so would mean storing structural information about a customer's private repository on Cailyx's servers, which contradicts the "code never leaves the machine" principle in §3. If a future version wants server-side history of file mappings, that needs its own explicit opt-in, not a silent schema addition here.

## 6. API key management

| Lifecycle stage | Behavior |
|---|---|
| **Issue** | Dashboard "Connect MCP" panel → `POST /mcp-access/keys` → full key shown once, plus a ready-to-paste MCP config JSON snippet (project ID + key pre-filled) |
| **Use** | Every `/mcp/v1/*` call carries `X-Cailyx-Api-Key`; guard updates `lastUsedAt` and writes an `McpCallLog` row |
| **Scope** | `read`: `status`, `fix_plan`, `ask` (`explain`/`compare` modes), `audit` (`refresh: false` only). `read_write`: adds `audit` with `refresh: true` and `ask` (`live_query` mode) |
| **Rate limit** | Per-key cap (`MCP_KEY_RATE_LIMIT_PER_HOUR`, default TBD), enforced in the guard, independent of the existing per-project cost governors already in `technical-audit`/`measurement` |
| **Rotate** | No forced rotation in v1; dashboard shows key age and last-used date so a stale/unused key is visible; revoke + reissue is the rotation mechanism |
| **Revoke** | `DELETE /mcp-access/keys/:id` sets `revokedAt`; guard rejects immediately, no propagation delay |
| **Expire** | Not in v1 — flagged as an open decision for later (fixed TTL vs. manual-only) |

## 7. MCP server build requirements

- **Package**: `mcp-server/` — `package.json`, `tsconfig.json`, `src/index.ts` (registers tools, starts stdio transport), dependencies: `@modelcontextprotocol/sdk`, `zod` (schema validation + type inference for tool inputs).
- **Config**: `CAILYX_API_KEY`, `CAILYX_PROJECT_ID`, `CAILYX_API_URL` from env, set in the customer's coding agent's MCP config block.
- **Startup self-check**: on launch, call `GET /mcp/v1/whoami`. Invalid/revoked key → the server logs one clear error and exits, instead of every subsequent tool call failing with an opaque 401. This is the single biggest lever on "why doesn't this work" support load.
- **`src/cailyx-client.ts`**: thin fetch wrapper attaching `X-Cailyx-Api-Key`, modeled on `frontend/src/lib/api.ts`'s existing `apiFetch`/`ApiError` normalization.
- **`src/repo-scanner.ts`**: local-only, framework detection (Next.js first), file-matching with confidence grading (§3 principle c). Never reads outside the launched working directory; never uploads file contents.
- **Error handling requirement**: every tool call returns a well-formed response even on failure — network error, 401, 429, cost-cap-hit, and "no file located" are all distinct, named error shapes (§11), never a raw stack trace or an unhandled rejection surfaced to the calling agent.
- **Logging**: structured local stderr logging only (MCP stdout is reserved for protocol messages) — tool name, duration, whether the cloud call was cached or fresh.

## 8. Auth flow of the MCP server

1. Customer generates a key in the Cailyx dashboard ("Connect MCP" panel), scope chosen at creation (`read` or `read_write`).
2. Key + project ID + API URL are pasted into the coding agent's MCP config as env vars.
3. On launch, `cailyx-mcp` calls `GET /mcp/v1/whoami` — fails fast with a clear message if invalid.
4. Every subsequent tool call attaches `X-Cailyx-Api-Key` on any request that needs cloud data; `api-key.guard.ts` resolves `projectId` + `scope`, checks the route's `@RequireScope()`, checks the per-key rate limit, writes an `McpCallLog` row, then proceeds.
5. Local-only tool calls (repo-scanner-only work, e.g. `audit` with `scope: {type: "file"}` and `refresh: false` against a cached result) may not need a cloud round-trip at all — the client only calls out when it needs live/cached server data.

**Scope enforcement matrix:**

| Tool | Mode/param | Min. scope |
|---|---|---|
| `audit` | `refresh: false` (cached) | `read` |
| `audit` | `refresh: true` (fresh run) | `read_write` |
| `status` | any | `read` |
| `fix_plan` | any | `read` |
| `ask` | `explain`, `compare` | `read` |
| `ask` | `live_query` | `read_write` |
| `find_opportunities` | any | `read` |

## 9. Tool schemas

MCP tools declare a JSON Schema `inputSchema`; each returns a single text content block containing a JSON string matching the documented output shape below (formal MCP `outputSchema`/structured content can be added once the pinned SDK version's support is confirmed — not blocking v1).

### `audit`

> "Check whether AI assistants (ChatGPT, Claude, Perplexity, Google) can access, correctly identify, and cite this project's site. Returns evidence-backed findings, each linked to the source file responsible where one can be confidently located. Scope to one category or run 'all'. Pass `scope` to check a specific diff, file, or draft instead of the live site."

```json
{
  "type": "object",
  "properties": {
    "category": {
      "type": "string",
      "enum": ["bot_access", "structured_data", "content_readability", "ai_mentions", "external_proof", "claims", "all"],
      "default": "all",
      "description": "Which check to run. bot_access = can AI crawlers load the site. structured_data = does schema.org/JSON-LD correctly identify the company. content_readability = is content structured for AI to quote. ai_mentions = does the site get named by AI assistants. external_proof = do outside sites mention it. claims = lint draft copy for unsupported stats (requires scope)."
    },
    "scope": {
      "type": "object",
      "description": "Optional. Check only this instead of the live site.",
      "properties": {
        "type": { "type": "string", "enum": ["diff", "file", "draft"] },
        "content": { "type": "string", "maxLength": 200000 }
      },
      "required": ["type", "content"]
    },
    "refresh": {
      "type": "boolean",
      "default": false,
      "description": "Force a fresh live-site run instead of the latest cached result. Costs real API spend — use sparingly."
    }
  },
  "required": []
}
```

Output:
```ts
{
  runId: string, category: string, generatedAt: string, cached: boolean,
  findings: [{
    id, severity: "critical"|"high"|"medium"|"low", title,
    evidence: string,
    file: { path: string, exists: boolean, reason: string, confidence: "high"|"low"|"unresolved" } | null,
    what: string, why: string, how: string, priority: number
  }],
  thinRun?: boolean
}
```

### `status`

> "Get the current AI-visibility score and what changed recently — a cheap read, no new audit runs."

```json
{
  "type": "object",
  "properties": {
    "since": { "type": "string", "enum": ["last_run", "last_week"], "description": "Include a plain-language summary of what changed since this point." }
  },
  "required": []
}
```

Output: `{ score: number, band: string, topFindings: [...], delta?: { since, scoreChange, mentionRateChange, notes } }`

### `fix_plan`

> "Turn open findings into something actionable — an ordered checklist, ready-to-paste code patches, or a content brief."

```json
{
  "type": "object",
  "properties": {
    "output": { "type": "string", "enum": ["checklist", "code_patch", "content_brief"], "default": "checklist" },
    "category": { "type": "string", "enum": ["bot_access", "structured_data", "content_readability", "ai_mentions", "external_proof", "all"], "default": "all" }
  },
  "required": []
}
```

Output: `{ output: string, items: [{ findingId, title, priority, instructions, patch?: string, brief?: {...} }] }`. `patch` is always advisory text (a diff block in the response) — the MCP server never applies it to a file itself.

### `ask`

> "Ask a question about this project's AI visibility. explain answers from existing evidence (free). live_query fires a real question at an AI assistant right now (costs spend, rate-limited, needs a read_write key). compare shows how you differ from named competitors."

```json
{
  "type": "object",
  "properties": {
    "question": { "type": "string" },
    "mode": { "type": "string", "enum": ["explain", "live_query", "compare"], "default": "explain" }
  },
  "required": ["question"]
}
```

Output: `{ mode: string, answer: string, evidence?: [...], costUsd?: number }`

### `find_opportunities`

> "Surface concrete, ranked opportunities on the existing site — pages worth linking to more, or declining pages worth refreshing."

```json
{
  "type": "object",
  "properties": {
    "type": { "type": "string", "enum": ["internal_links", "refresh_candidates"] }
  },
  "required": ["type"]
}
```

Output: `{ type: string, opportunities: [{ url, reason, recommendation, priority }] }`

## 10. Tool description optimization

- One paragraph per tool, plain language, no SEO/AEO jargon (§ earlier discussion) — a naive engineer should understand every tool from its description alone, no reference to Cailyx's internal PRD dimension names.
- Enum values get their own inline gloss inside the parameter description (see `category` above) rather than requiring the model to guess what `bot_access` means from the name alone.
- Target under ~120 tokens per tool description, under ~40 tokens per parameter description — five tools at this budget stays a small fraction of any client's context window, versus the ~17-tool version considered earlier.
- No tool description references internal module names (`technical-audit`, `entity-audit`, etc.) — those stay in this document only.

## 11. Read / validation rules

- Unknown `category`/`mode`/`type`/`output` value → reject with the allowed list in the error, never silently fall back to a default.
- `scope.content` capped at 200KB — prevents a whole file or repo being pasted in as "draft" and blowing spend/context on a single call.
- Every response is valid, parseable JSON matching its documented shape in §9, even on partial failure (a degraded dimension is marked, never omitted silently — same rule `scoring` already applies internally via "honest partials").
- `file` is `null`, not a guessed path, whenever `repo-scanner` confidence is `unresolved`.
- No secrets, tokens, or `.env` contents are ever read by `repo-scanner` or echoed into a response, even incidentally (explicit exclusion list: `.env*`, anything matching common credential-file patterns).

## 12. Guardrails carried through every future tool

- **Cost-governed live calls** — any tool firing a fresh billable call (`ask.live_query` is the clear case) reuses `measurement`'s existing per-run cost-governor pattern, scoped per API key with its own rate limit.
- **API versioning from day one** — every route is `/mcp/v1/...`.
- **Evidence-graded, never a flat guess** — confidence labels flow through to every inferred field.

## 13. Build order

1. `ApiKey` + `McpCallLog` Prisma models, `api-key.guard.ts`, `mcp-access` module (issuance/revocation + `/mcp/v1/whoami`).
2. "Connect MCP" dashboard panel (generate/copy/revoke + config snippet).
3. `mcp-server/` scaffold: config loading, startup self-check, `cailyx-client.ts`.
4. `repo-scanner.ts` (Next.js-only, confidence-graded).
5. `audit` tool, `category: bot_access` only, wired to `/mcp/v1/technical-audit/*`.
6. Dogfood verification (§14), then the remaining `category` values and the other four tools, one at a time.

## 14. Verification

- `backend/smoke/mcp-access.smoke.sh`: issue a key, call an `/mcp/v1/*` route, confirm 200; revoked/garbage key → 401; `read`-scoped key on a `read_write` route → 403; **project A's key cannot read or affect project B's data**; existing web JWT routes unaffected; rate-limit trips after N calls.
- MCP server: `@modelcontextprotocol/inspector` against `frontend/` as the target repo, call `audit` with `category: bot_access`, confirm findings reference real files under `frontend/src/app/` with correct `confidence` values, and confirm an unrecognized-framework repo returns `file: null` rather than a guess.
- Dogfood loop: connect the MCP server to a coding agent pointed at a real Cailyx project + `frontend/`, run the audit, confirm the output is a usable, evidence-backed, file-located instruction set.
- `npx tsc --noEmit` clean in both `backend/` and `mcp-server/`.

## 15. Outcomes flow — what actually happens, end to end

1. **Connect** — customer opens their Cailyx project, clicks "Connect MCP," picks a scope, gets a key + a ready-to-paste config snippet. Pastes it into their coding agent's MCP settings. Restarts the agent.
2. **Verify** — the MCP server's startup self-check confirms the key against `/mcp/v1/whoami`; the agent now lists `audit`, `status`, `fix_plan`, `ask`, `find_opportunities` as available tools.
3. **First audit** — customer (in their coding agent) asks something like "check if AI bots can access our site." The agent calls `audit({category: "bot_access"})`. Cailyx backend runs (or reuses) the technical-audit; `repo-scanner` maps each finding to a real file in the open repo with a confidence grade.
4. **Instructions, not edits** — the tool returns a small set of findings, each with evidence, the responsible file, and a concrete how-to-fix. The MCP server does not touch any file.
5. **Fix, in the agent** — the customer's coding agent reads the `how` field and the `file.path`, and makes the actual code change itself, the same way it would for any other task the developer asked it to do.
6. **Re-check** — customer asks "did that fix it," the agent calls `audit({category: "bot_access", refresh: true})` (a `read_write`-scoped, cost-governed fresh run) or `status({since: "last_run"})` for a cheap read; the finding either clears or the response explains why not.
7. **Widen scope** — over following sessions, the customer works through `status` → `fix_plan` → the other `category` values as they land, using the same five-tool surface the whole time; no new tools to learn, no new config to add.
8. **Ambient use later** — once `find_opportunities` and `ask` are live, the same connected MCP server answers "why did our score drop this week" or suggests which existing pages to link to next, without the customer ever leaving their coding agent or opening the Cailyx dashboard.
