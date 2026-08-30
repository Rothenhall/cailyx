# Reporting Module

> **Status:** ✅ Built and tested
> **Phase:** 1 (PRD §16 Phase 1 — "branded report + PDF")
> **PRD:** FR-10.1 (web report + PDF), FR-10.3 (executive + detailed), FR-10.4 (branding), FR-10.5 (noindex)

## Purpose

Generates the branded AI Visibility Diagnostic report — the actual product deliverable. Aggregates technical-audit findings, entity-audit schema checks, and gap-analysis roadmap into a scored report with executive and detailed HTML views.

## Architecture

```
reporting/
├── reporting.module.ts        # NestJS module
├── reporting.service.ts       # Generation, scoring, HTML render
├── reporting.controller.ts    # REST API
├── reporting.types.ts         # Type definitions
├── dto/
│   └── reporting.dto.ts       # Validated DTOs
├── templates/
│   └── report-html.hbs        # Handlebars template (executive + detailed)
└── README.md
```

## PRD §8 Scoring

| Dimension | Weight | Source |
|---|---|---|
| Machine access | 25 pts | robots + CDN findings (pass rate) |
| Entity clarity | 25 pts | SchemaCheck pass rate |
| Shortlist presence | 20 pts | Audit coverage proxy (measurement deferred) |
| On-page extractability | 20 pts | js-render + cwv pass rate |
| Authority signal | 10 pts | Schema audit status |

**Bands:** strong (75+), moderate (50-74), weak (25-49), critical (<25)

## REST API

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/api/projects/:id/reports` | 3/60s | Generate report (needs prior technical audit) |
| `GET` | `/api/projects/:id/reports` | 100/60s | List reports |
| `GET` | `/api/projects/:id/reports/:slug/view` | 100/60s | Report JSON |
| `GET` | `/api/projects/:id/reports/:slug/render` | 100/60s | Branded HTML (append `?view=detailed`) |
| `PUT` | `/api/projects/:id/reports/:slug/visibility` | 100/60s | Set private/public |

## Features

- **PRD §8 scoring** with per-dimension evidence (FR-8.3: no black-box numbers)
- **Executive summary** auto-generated from failures + roadmap
- **noindex by default** on private reports (FR-10.5)
- **Branding config** via env: `REPORT_BRAND_NAME`, `REPORT_BRAND_TAGLINE` (FR-10.4)
- **Reproduction commands** included in detailed view (FR-2.6)
- **Stable slug URLs** (`/reports/[slug]`)

## Dependencies

| Package | Purpose |
|---|---|
| `handlebars` | HTML template rendering |
| `DatabaseModule` | Reads audits/findings/gaps via Prisma |