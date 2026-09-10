/**
 * Technical-audit view model — the pure half of the report.
 *
 * Everything the report renders comes out of one `TechnicalAudit` detail
 * payload plus its `AuditComparison`. The findings persist their `detail` as a
 * JSON string per check (SQLite has no JSON column), and the per-page rows
 * persist `jsonLdTypes` / `issues` the same way, so nothing here trusts a
 * shape — every accessor is defensive and returns a typed default.
 *
 * Keys (`metric`, `type`, issue codes) mirror
 * backend/src/modules/technical-audit/ — those are the contract. Formatting,
 * banding and grouping live here so the widgets stay declarative.
 *
 * @module app/v2/_lib/audit
 */

import type { AuditDelta, TechnicalAudit } from '@/types/terminal';

/* ── bands ───────────────────────────────────────────────────────────────── */

/** Composite score bands — 80 is the agent-readiness pass mark, 50 the point
    below which a site is unusable to an assistant rather than merely weak. */
export const SCORE_BANDS = { healthy: 80, needsWork: 50 } as const;

/** Per-page SEO rubric, mirrored from checks/seo-rubric.ts for the page table. */
export const SEO_BANDS = {
  titleMin: 30,
  titleMax: 60,
  metaMin: 70,
  metaMax: 160,
  minWords: 150,
} as const;

/* ── report structure ────────────────────────────────────────────────────── */

export type SectionId =
  | 'overview'
  | 'access'
  | 'performance'
  | 'structure'
  | 'pages'
  | 'agent'
  | 'analysis';

/** The report's sections, in reading order. Drives the rail nav and scrollspy. */
export const REPORT_SECTIONS: { id: SectionId; label: string; blurb: string }[] = [
  { id: 'overview', label: 'Overview', blurb: 'Score & checks' },
  { id: 'access', label: 'Access', blurb: 'robots.txt & CDN' },
  { id: 'performance', label: 'Performance', blurb: 'Core Web Vitals' },
  { id: 'structure', label: 'Structure', blurb: 'Schema & sitemap' },
  { id: 'pages', label: 'Pages', blurb: 'Per-URL crawl' },
  { id: 'agent', label: 'AI readiness', blurb: 'is-agentic' },
  { id: 'analysis', label: 'Analysis', blurb: 'Written reading' },
];

/* ── metric ledger ───────────────────────────────────────────────────────
   Keyed to technical-audit.deltas.ts — `metric` keys are stable. Grouped
   the way the checks group so the ledger reads as a table of contents for
   the sections beside it. */
export const LEDGER_GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Overall', keys: ['composite', 'openFailures', 'agentReadiness'] },
  { title: 'Core Web Vitals', keys: ['lcp', 'inp', 'cls'] },
  {
    title: 'Lighthouse',
    keys: ['lighthousePerformance', 'lighthouseSeo', 'lighthouseAccessibility'],
  },
  { title: 'Crawl & sitemap', keys: ['sitemapUrls', 'sitemapStaleDays', 'blockedBots'] },
  {
    title: 'Pages',
    keys: ['pageAverageScore', 'pagesWithoutJsonLd', 'pagesBadTitle', 'pagesBadMeta'],
  },
];

/** Millisecond metrics — formatted as time, and −1 means "not measured". */
export const MS_METRICS = new Set(['lcp', 'inp']);

/* ── page issue codes ────────────────────────────────────────────────────── */

export const PAGE_ISSUE_LABELS: Record<string, string> = {
  'page-error': 'did not return 200',
  noindex: 'marked noindex',
  'title-missing': 'no title',
  'title-too-short': 'title too short',
  'title-too-long': 'title too long',
  'meta-missing': 'no meta description',
  'meta-too-short': 'meta description too short',
  'meta-too-long': 'meta description too long',
  'h1-missing': 'no H1',
  'h1-multiple': 'multiple H1s',
  'canonical-missing': 'no canonical',
  'json-ld-missing': 'no JSON-LD',
  'json-ld-invalid': 'JSON-LD does not parse',
  'thin-content': 'thin content',
};

/** Codes that make a page effectively invisible — everything else is a warning. */
export const CRITICAL_PAGE_ISSUES = new Set(['page-error', 'noindex', 'json-ld-missing']);

/* ── defensive accessors ─────────────────────────────────────────────────── */

/** One finding's `detail`, parsed. Returns null on absent / unparseable. */
export function detailOf(
  audit: TechnicalAudit | null,
  type: string,
): Record<string, unknown> | null {
  const f = audit?.findings.find((x) => x.type === type);
  if (!f?.detail) return null;
  if (typeof f.detail !== 'string') return f.detail as Record<string, unknown>;
  try {
    const parsed = JSON.parse(f.detail);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A finding's status, or null if the check did not run at all. */
export function statusOf(audit: TechnicalAudit | null, type: string): string | null {
  return audit?.findings.find((x) => x.type === type)?.status ?? null;
}

export function findingOf(audit: TechnicalAudit | null, type: string) {
  return audit?.findings.find((x) => x.type === type) ?? null;
}

function walk(o: unknown, path: string[]): unknown {
  let cur = o;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function pick(o: Record<string, unknown> | null, ...path: string[]): number | null {
  const v = walk(o, path);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
export function pickStr(o: Record<string, unknown> | null, ...path: string[]): string | null {
  const v = walk(o, path);
  return typeof v === 'string' && v.length > 0 ? v : null;
}
export function pickBool(o: Record<string, unknown> | null, ...path: string[]): boolean | null {
  const v = walk(o, path);
  return typeof v === 'boolean' ? v : null;
}
export function pickArr<T = unknown>(o: Record<string, unknown> | null, ...path: string[]): T[] {
  const v = walk(o, path);
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Parse a column that stores a JSON array as text. */
export function parseJsonArray<T = unknown>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as T[]) : [];
  } catch {
    return [];
  }
}

/* ── formatting ──────────────────────────────────────────────────────────── */

export function fmtMs(v: number | null): string {
  if (v === null) return '—';
  if (v === -1) return 'n/a';
  return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}s` : `${Math.round(v)}ms`;
}

/** A ledger value in the metric's own unit. */
export function fmtMetric(v: number | null, key: string): string {
  if (v === null) return '—';
  if (key === 'cls') return v.toFixed(3);
  if (MS_METRICS.has(key)) return fmtMs(v);
  return Math.round(v).toLocaleString();
}

/** The signed movement of a delta, magnitude only, in the metric's unit. */
export function fmtChange(d: AuditDelta): string {
  if (d.change === null) return '';
  const mag = Math.abs(d.change);
  if (d.metric === 'cls') return mag.toFixed(3);
  if (MS_METRICS.has(d.metric)) return fmtMs(mag);
  return Math.round(mag).toLocaleString();
}

export function rel(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const day = Math.floor(h / 24);
  return day < 30 ? `${day}d ago` : `${Math.floor(day / 30)}mo ago`;
}

/* ── tone ────────────────────────────────────────────────────────────────
   The report speaks in a real traffic light (see `.v2-audit-ws` in v2.css):
   `a-ok` green, `a-warn` amber, `a-bad` red, plus a neutral for "not
   measured". `Tone` bundles the class names a widget needs so a status maps
   to a colour once, here, not at every call site. */

export type ToneKind = 'ok' | 'warn' | 'bad' | 'neutral';

export interface Tone {
  kind: ToneKind;
  /** text colour */
  text: string;
  /** solid fill (bars, dots) */
  fill: string;
  /** tint wash (chip / cell background) */
  soft: string;
  /** hairline for a tinted chip / card edge */
  line: string;
}

const TONES: Record<ToneKind, Tone> = {
  ok: { kind: 'ok', text: 'text-a-ok', fill: 'bg-a-ok', soft: 'bg-a-ok-soft', line: 'border-a-ok-line' },
  warn: { kind: 'warn', text: 'text-a-warn', fill: 'bg-a-warn', soft: 'bg-a-warn-soft', line: 'border-a-warn-line' },
  bad: { kind: 'bad', text: 'text-a-bad', fill: 'bg-a-bad', soft: 'bg-a-bad-soft', line: 'border-a-bad-line' },
  neutral: { kind: 'neutral', text: 'text-faint', fill: 'bg-faint/30', soft: 'bg-bg-inset', line: 'border-border' },
};

export function tone(kind: ToneKind): Tone {
  return TONES[kind];
}

/** 0-100 → tone kind, on the composite's own 80 / 50 breaks. */
export function scoreKind(v: number | null | undefined): ToneKind {
  if (v === null || v === undefined) return 'neutral';
  if (v >= SCORE_BANDS.healthy) return 'ok';
  if (v >= SCORE_BANDS.needsWork) return 'warn';
  return 'bad';
}

/** CWV good / needs-improvement / poor → tone kind. */
export function cwvKind(status: string | null | undefined): ToneKind {
  return status === 'good' ? 'ok' : status === 'needs-improvement' ? 'warn' : status ? 'bad' : 'neutral';
}

/** Finding status → tone kind. */
export function statusKind(status: string | null): ToneKind {
  switch (status) {
    case 'pass':
      return 'ok';
    case 'warn':
      return 'warn';
    case 'fail':
      return 'bad';
    default:
      return 'neutral';
  }
}

export interface Band {
  word: string;
  tone: Tone;
}

export function band(score: number | null): Band {
  if (score === null) return { word: 'Not scored', tone: TONES.neutral };
  if (score >= SCORE_BANDS.healthy) return { word: 'Healthy', tone: TONES.ok };
  if (score >= SCORE_BANDS.needsWork) return { word: 'Needs work', tone: TONES.warn };
  return { word: 'Unusable to assistants', tone: TONES.bad };
}

/* legacy string helpers kept for the in-card AuditInsight (brand palette) */
export function scoreTone(v: number | null): string {
  return TONES[scoreKind(v)].text;
}
export function cwvTone(status: string | null | undefined): string {
  return TONES[cwvKind(status)].text;
}
export function cwvBarTone(status: string | null | undefined): string {
  return TONES[cwvKind(status)].fill;
}

/** Finding status → glyph + tone + word for a check row. */
export function checkVerdict(status: string | null): { glyph: string; tone: Tone; word: string } {
  switch (status) {
    case 'pass':
      return { glyph: '✓', tone: TONES.ok, word: 'pass' };
    case 'warn':
      return { glyph: '!', tone: TONES.warn, word: 'warn' };
    case 'fail':
      return { glyph: '✕', tone: TONES.bad, word: 'fail' };
    case 'error':
      return { glyph: '·', tone: TONES.neutral, word: 'no result' };
    default:
      return { glyph: '·', tone: TONES.neutral, word: 'not run' };
  }
}
