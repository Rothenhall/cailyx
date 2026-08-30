# Reporting Module — API Reference

## POST /api/projects/:projectId/reports
Generate a report. Rate-limited 3/60s. Requires a prior technical audit.

**Body:** `{ "targetUrl": "https://example.com", "title": "Q1 Diagnostic" }`

**201 Response:** slug, title, scoreTotal, scoreBand, subScores[], findings[], roadmap[], executiveSummary

**Errors:** 400 invalid URL · 404 no audit found · 429 rate limit

## GET /api/projects/:projectId/reports
List report summaries (slug, title, score, band, visibility, createdAt).

## GET /api/projects/:projectId/reports/:slug/view
Full report JSON. 404 if private.

## GET /api/projects/:projectId/reports/:slug/render
Branded HTML page. noindex for private reports (FR-10.5). `?view=detailed` adds findings table + reproduction commands + roadmap.

## PUT /api/projects/:projectId/reports/:slug/visibility
**Body:** `{ "visibility": "public" }` or `{ "visibility": "private" }`