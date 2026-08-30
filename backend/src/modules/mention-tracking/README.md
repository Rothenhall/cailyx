# Mention Tracking (SOP-7, FR-4.4)

External mention ledger: campaign → target(lifecycle) → MentionCheck(timeline)
with a decay view. Discovery is manual by design; verification is semi-auto
single-fetch (low-ToS, same posture as entity-audit).

## Files

```
mention-tracking/
├── mention-tracking.types.ts      # MentionTargetType/Status, MentionCheckResult, MentionDecay
├── mention-tracking.service.ts    # campaigns, targets, checkTarget, decayView
├── mention-tracking.controller.ts # 8 routes under /projects/:id/mentions
├── dto/mention-tracking.dto.ts
├── mention-tracking.module.ts
└── README.md
```

## Model

| Route | Purpose |
|---|---|
| `POST /mentions/campaigns` | Group targets; anchor to a "best X" hunt query |
| `GET /mentions/campaigns` | List with target counts |
| `POST /mentions/targets` | Record a candidate (listicle/community/review/other) |
| `GET /mentions/targets?status=` | List (participates outreach filter) with latest check |
| `PATCH /mentions/targets/:id` | Outreach lifecycle: `new → contacted → replied → placed | rejected` |
| `DELETE /mentions/targets/:id` | Delete (checks cascade) |
| `POST /mentions/targets/:id/check` | **Semi-auto check**: ONE fetch (20/min, fetcher-cached) → looks for the brand token, stores mentioned + ±60-char evidence + fetchedTitle + httpStatus |
| `GET /mentions/targets/:id/checks` | Ledger history |
| `GET /mentions/decay?brandToken=` | Per-target decay: lastMentionedAt, daysSinceLastMention, `stale` at ≥90 days. Only checks whose evidence contains the brand token count as mentions |

Decay semantics: never-mentioned targets are `everMentioned:false` with no decay —
that's a missing-listicle gap (outreach candidate), not a stale mention.

## e2e evidence (2026-08-30, :3111)

1. Campaign `{name, listicleQuery}` 201; target 201.
2. Semi-auto check vs a real public page with a token the page does not contain → `mentioned:false, httpStatus:200, evidence:null` (honest negative).
3. `brandToken:"s"` (too short) → **400**; `status:"bogus"` → **400**.
4. Status flip to `contacted` 200 (persisted); `?status=contacted` filter returns it with `latestCheck` attached.
5. Decay view returns the correct `everMentioned:false / stale:false / days:null` shape for the fresh target.

Test rows wiped; servers killed.

## PRD alignment

| PRD ref | Implementation |
|---|---|
| FR-4.4 listicle presence | target type `listicle` + manual discovery + semi-auto verify |
| SOP-7 mention decay | MentionCheck ledger + `GET /mentions/decay` (≥90-day stale flag) |
| SOP-7 outreach targets | status lifecycle + campaign grouping |
| Review tracking | target type `review` (reuses the same check/decay machinery) |