# Reporting Module — API Reference

All routes are prefixed `/api`. Operator routes need an operator bearer token **and**
access to the project (`admin`, or an `OperatorAssignment` covering it); a client-type
token is rejected on every one of them. See README.md for the state machine and the
migration policy.

## Generation and reads

### POST /api/projects/:projectId/reports
Generate a report. Rate-limited 3/60s. Requires a prior technical audit.

**Body:** `{ "targetUrl": "https://example.com", "title": "Q1 Diagnostic", "periodId?": "...", "cohortId?": "..." }`
(`targetUrl` is validated, then the **latest audit's** own URL is what the report stores.)

**201:** `ReportData` — `status: "draft"`, `releasedRevision: null`, plus `rubricVersion`
/ `scoreRunId` (D11) when the evidence manifest pinned them.
**Errors:** 400 invalid · 403 unassigned · 404 no audit · 429 rate limit.

> A generated report is an **unreleased draft**. It does not reach the client until it is
> reviewed, approved and released.

### GET /api/projects/:projectId/reports
**200:** `{ reports: [{ id, slug, title, targetUrl, visibility, status, releasedRevision, releasedAt, scoreTotal, scoreBand, createdAt }] }`

### GET /api/projects/:projectId/reports/:slug/view
The live report row (drafts included) — `ReportData`. 404 if the slug is not in this project.

### GET /api/projects/:projectId/reports/:slug/render
**`@Public`.** Branded HTML (`?view=detailed`). A `visibility: "public"` report opens for
anyone; a private one needs an operator bearer token. When the report has a released
revision, the page renders **that revision's frozen snapshot**. 404 otherwise.

### PUT /api/projects/:projectId/reports/:slug/visibility
Admin / delivery-lead. **Body:** `{ "visibility": "public" | "private" }`.
The public-link flag. Not the editorial state, and never a substitute for release.

## Editorial lifecycle

### GET /api/projects/:projectId/reports/:slug/lifecycle
**200:** `ReportLifecycleDto`
```json
{
  "reportId": "…", "slug": "…",
  "status": "draft|in-review|approved|released|withdrawn",
  "visibility": "private|public",
  "releasedRevision": 2, "releasedAt": "…", "releasedBy": "…",
  "inFlightRevision": { "revision": 3, "status": "in-review", "…": "…" },
  "revisions": [ … ],
  "publishBlocked": { "reason": "unresolved-approval", "message": "…" }
}
```
`publishBlocked` is a disclosure from the real G10 gate (null when nothing blocks).

### GET /api/projects/:projectId/reports/:slug/revisions
**200:** `{ revisions: ReportRevisionDto[] }` — newest first, metadata only.

### GET /api/projects/:projectId/reports/:slug/revisions/:revision
**200:** `ReportRevisionDetailDto` — the revision **with its frozen snapshot** (21 fields:
title, targetUrl, executiveSummary, scoreTotal, scoreBand, subScores, findings, roadmap,
growthPlan, backlinks, presence, competitors, branding, rubricVersion, scoreRunId,
manifestId, periodId, cohortId, contentCreatedAt, contentUpdatedAt, snapshotAt).

### POST /api/projects/:projectId/reports/:slug/review
Admin / delivery-lead / content / technical / outreach.
**Body:** `{ "note?": "…" }`.

Creates revision 1 (or N+1 when the newest revision is settled), or re-locks the current
draft, freezing its snapshot. Invalidates any approval request bound to an older revision.

**200:** the revision now `in-review`. **409** when the newest revision is already
`in-review` or `approved`.

### POST /api/projects/:projectId/reports/:slug/approve
Admin / delivery-lead. **Body:** `{ "decision": "approved" | "changes-requested", "note?": "…" }`

**200:** the decided revision (`approved`, or back to `draft`). **409** when nothing is in
review or it was already decided.

### POST /api/projects/:projectId/reports/:slug/publish
Admin / delivery-lead. **Body:** `{ "note?": "…" }`. **This is the release.**

Runs `ApprovalsService.assertReadyToPublish` first; then, in one transaction: the revision
becomes `released`, any earlier released revision becomes `superseded` (snapshot
untouched), and `Report` is repointed.

**200:** the released revision. **409** not approved, or the gate refused
(`reason: "unresolved-approval" | "blocked-claims"`).

### POST /api/projects/:projectId/reports/:slug/withdraw
Admin / delivery-lead. **Body:** `{ "reason": "…" }` (required, 400 without it).

**200:** the withdrawn revision. `Report.status = "withdrawn"`, `releasedRevision` cleared,
every share link for the report stops resolving. **409** when nothing is released.

## Share links (public axis)

### GET /api/projects/:projectId/reports/:slug/share-links
**200:** `{ links: [{ id, reportId, revisionId, expiresAt, revokedAt, lastViewedAt, viewCount, createdBy, createdAt }] }` — never a token.

### POST /api/projects/:projectId/reports/:slug/share-links
Admin / delivery-lead. **Body:** `{ "expiresInHours?": 24 }` (omit for no expiry; still revocable).

**201:** the link **plus `token` and `url` — returned once and never retrievable again**;
only the sha256 is stored. **409** when the report is not released.

### DELETE /api/projects/:projectId/reports/:slug/share-links/:linkId
Admin / delivery-lead. **200:** the revoked link (idempotent). The report's release state
is untouched.

### GET /api/reports/shared/:token
**`@Public`, token-only.** HTML of the report's **currently released revision**, always
`noindex`, rate-limited 30/min. 404 for unknown, revoked, expired, or nothing released —
one answer for all four.

## Delivery

### GET /api/projects/:projectId/reports/:slug/delivery-attempts
`?limit=` (default 50, max 200). **200:** `{ attempts: DeliveryAttemptDto[] }` newest first.

### POST /api/projects/:projectId/reports/:slug/delivery-attempts
Admin / delivery-lead / sales.
**Body:** `{ "recipient": "…", "subject?": "…", "channel?": "email" | "link-share" | "manual", "reportUrl?": "…" }`

Writes `queued` before attempting, then `sent`/`failed`. `email` sends through the
configured Plunk adapter and **requires `reportUrl`** — the link the recipient opens
(400 without it; an email with no link cannot work, so it is refused rather than
recorded as a failed send). A malformed recipient is refused (409) with no row written.
`sent` means the **provider accepted** the message — never that it was read.

**200:** the attempt either way (a failed send is a recorded outcome, not a failed
request). **409** when the report is not released.

## Migration (pre-G05 rows)

### GET /api/reports/classify-legacy/preview · POST /api/reports/classify-legacy
Admin only. **Body:** `{ "dryRun?": false }`.
**200:** `{ dryRun, classified, skipped, reports: [{ slug, status, visibility, releasedAt, reason }] }`.
Idempotent; see README.md for the policy.
