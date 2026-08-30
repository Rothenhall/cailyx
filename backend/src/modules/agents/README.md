# Agents Module

> **Status:** ✅ Built and e2e-verified (2026-08-30, part of `smoke/dashboard.smoke.sh`)
> **Type:** Dashboard aggregation — read-only

## Purpose

Builds the Okara Terminal **Agents Feed**: one status card per capability, each
headline derived from real artefacts the project already has. One aggregate read
across the platform's models; no coupling beyond `PrismaService`.

## Cards

| key | reads | headline example |
|---|---|---|
| `seo` | latest technical audit findings + latest link graph | "3 recommendations ready" |
| `geo` | latest measurement run + observations, gap rows (visibility/narrative), entity schema checks | "2 citation gaps detected" |
| `articles` | `finding` + `pageAnalysis` counts | "1 topic ready" |
| `authority` | latest authority scan candidates (status `new`) | "2 opportunities ready" |
| `journeys` | `journey` rows + `journeyCampaign` count | "4 buyer journeys mapped" |
| `personas` | `persona` rows (active vs total) | "4 personas active" |
| `council` | latest council session rankings | "3 interventions ranked" |
| `mentions` | `mentionTarget` rows by status | "2 outreach targets in flight" |
| `serp` | `serpTracker` + queries + latest snapshot | "12 queries tracked" |
| `monitoring` | recent `alert` rows | "No regressions detected" |

`AgentCard = { key, name, category, status (ready|attention|idle|running|blocked), headline, count, metric, activity[], lastActivityAt, href, cta }`

## API

`GET /api/projects/:projectId/agents` → `{ projectId, agents: AgentCard[], summary: { total, needAttention, ready, idle } }`
(behind the global `JwtAuthGuard`; 404 on unknown project).

## Testing

`bash smoke/dashboard.smoke.sh` — seeds a demo project with personas / journeys /
link graph / authority / council, then asserts all 10 cards return, each is
well-formed, and the headlines reflect the seeded artefacts (e.g. "4 personas
active", "3 interventions ranked").
