'use client';

/**
 * Audit insight — the run-over-run half of the Technical tile.
 *
 * The tile already answers "what is broken right now". These answer the
 * question an operator actually opens the console for: *is it getting better?*
 * — the composite score, what moved since the last run, the site-wide page
 * rollup, and the model's written reading of the two.
 *
 * @module app/v3/_components/AuditInsight
 */

import { useMemo } from 'react';
import type { AuditDelta, AuditFinding, TechnicalAudit } from '@/types/terminal';
import { SectionLabel } from './panel';

/** Findings persist `detail` as a JSON string; never trust the shape. */
function detailOf(audit: TechnicalAudit | null, type: string): Record<string, unknown> | null {
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

function num(o: Record<string, unknown> | null, key: string): number | null {
  const v = o?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/* ── composite score ─────────────────────────────────────────────────────── */

/**
 * The one number the card leads with, with its movement attached. The band
 * thresholds match the composite's own rubric: 80 is the pass mark the
 * agent-readiness check uses, 50 the point below which the site is unusable
 * to an assistant rather than merely imperfect.
 */
export function AuditScore({ score, previous }: { score: number | null; previous: number | null }) {
  if (score === null) return null;
  const delta = previous === null ? null : score - previous;
  const tone = score >= 80 ? 'text-accent' : score >= 50 ? 'text-warn' : 'text-danger';

  return (
    <div className="flex items-baseline gap-2">
      <span className={`num font-display text-figure font-semibold tabular-nums ${tone}`}>{score}</span>
      <span className="text-caption text-faint">/ 100</span>
      {delta !== null && delta !== 0 && (
        <span
          className={`ml-auto text-caption font-semibold tabular-nums ${
            delta > 0 ? 'text-accent' : 'text-danger'
          }`}
        >
          {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}
        </span>
      )}
      {delta === 0 && <span className="ml-auto text-caption text-faint">no change</span>}
    </div>
  );
}

/* ── deltas ──────────────────────────────────────────────────────────────── */

/** Format a metric value for display — CLS is fractional, the rest are whole. */
function fmt(v: number | null, metric: string): string {
  if (v === null) return '—';
  if (metric === 'cls') return v.toFixed(3);
  // The CWV adapter reports -1 for a metric Lighthouse could not measure.
  if (v === -1 && (metric === 'inp' || metric === 'lcp')) return 'n/a';
  return Math.round(v).toLocaleString();
}

/**
 * What moved since the previous run.
 *
 * Only genuinely moved metrics are listed. A wall of "unchanged" rows is the
 * fastest way to make a trend view unreadable, and unchanged is already the
 * default assumption.
 */
export function DeltaList({ deltas }: { deltas: AuditDelta[] }) {
  const moved = useMemo(
    () => deltas.filter((d) => d.direction === 'improved' || d.direction === 'regressed'),
    [deltas],
  );

  if (!deltas.length) return null;

  if (!moved.length) {
    return (
      <div className="mt-3">
        <SectionLabel>Since last run</SectionLabel>
        <p className="text-body leading-relaxed text-faint">
          Nothing measurable moved. {deltas.length} metrics tracked.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <SectionLabel right={<span className="text-eyebrow tabular-nums text-faint">{moved.length} moved</span>}>
        Since last run
      </SectionLabel>
      <ul className="space-y-1">
        {moved.map((d) => {
          const good = d.direction === 'improved';
          return (
            <li key={d.metric} className="flex items-baseline gap-2 text-caption">
              <span className={`shrink-0 ${good ? 'text-accent' : 'text-danger'}`}>{good ? '▲' : '▼'}</span>
              <span className="min-w-0 flex-1 truncate text-dim">{d.label}</span>
              <span className="shrink-0 tabular-nums text-faint">{fmt(d.previous, d.metric)}</span>
              <span className="shrink-0 text-faint">→</span>
              <span className={`shrink-0 font-semibold tabular-nums ${good ? 'text-accent' : 'text-danger'}`}>
                {fmt(d.current, d.metric)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── narrative ───────────────────────────────────────────────────────────── */

/**
 * The model's reading of the run.
 *
 * Rendered as plain sectioned text rather than through a markdown library: the
 * prompt fixes the four headings, so the only markup that can appear is `## `
 * and the occasional numbered line. Pulling in a parser for that would be more
 * dependency than the content justifies.
 */
export function Narrative({ text, model }: { text: string | null; model: string | null }) {
  const blocks = useMemo(() => {
    if (!text) return [];
    return text
      .split(/\n(?=##\s)/)
      .map((chunk) => {
        const [head, ...rest] = chunk.split('\n');
        const heading = head.replace(/^#+\s*/, '').trim();
        const body = rest.join('\n').trim();
        // A chunk with no heading is preamble — keep it, unlabelled.
        return /^#+\s/.test(head) ? { heading, body } : { heading: '', body: chunk.trim() };
      })
      .filter((b) => b.heading || b.body);
  }, [text]);

  if (!text) return null;

  return (
    <div className="mt-3">
      <SectionLabel right={model ? <span className="text-eyebrow text-faint">{model.split('/').pop()}</span> : null}>
        Analysis
      </SectionLabel>
      <div className="space-y-2 rounded-r3 border border-border/60 bg-bg-inset/40 p-2.5">
        {blocks.map((b, i) => (
          <div key={i}>
            {b.heading && (
              <p className="text-eyebrow font-semibold uppercase tracking-eyebrow text-accent">{b.heading}</p>
            )}
            <p className="mt-0.5 whitespace-pre-line text-caption leading-relaxed text-dim">{b.body}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── site-wide page rollup ───────────────────────────────────────────────── */

const ISSUE_LABELS: Record<string, string> = {
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

/**
 * The per-page crawl, summarised. This is the part of the audit that is
 * site-wide rather than homepage-only, so it leads with coverage — how much of
 * the sitemap was actually looked at — before any of the counts.
 */
export function PageRollup({ audit }: { audit: TechnicalAudit | null }) {
  const inv = detailOf(audit, 'page-inventory');
  const sitemap = detailOf(audit, 'sitemap');
  if (!inv) return null;

  const crawled = num(inv, 'crawled') ?? 0;
  const discovered = num(inv, 'discovered') ?? 0;
  const avg = num(inv, 'averageScore');
  const counts = (inv.issueCounts as Record<string, number> | undefined) ?? {};
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const stale = num(sitemap, 'staleDays');
  const withLastmod = num(sitemap, 'withLastmod');
  const urlCount = num(sitemap, 'urlCount');

  return (
    <div className="mt-3">
      <SectionLabel
        right={
          avg !== null ? (
            <span className={`text-eyebrow font-semibold tabular-nums ${avg >= 80 ? 'text-accent' : 'text-warn'}`}>
              avg {avg}
            </span>
          ) : null
        }
      >
        Pages
      </SectionLabel>

      <p className="text-caption leading-relaxed text-faint">
        Crawled <span className="font-semibold tabular-nums text-dim">{crawled}</span> of{' '}
        <span className="tabular-nums">{discovered}</span> sitemap URLs
        {discovered > crawled && <span> · budget-limited, newest changes first</span>}
      </p>

      {urlCount !== null && (
        <p className="mt-0.5 text-caption leading-relaxed text-faint">
          Sitemap: <span className="tabular-nums">{urlCount}</span> URLs,{' '}
          <span className="tabular-nums">{withLastmod ?? 0}</span> dated
          {stale !== null && (
            <>
              {' '}
              · last change{' '}
              <span className={`tabular-nums ${stale > 90 ? 'text-warn' : ''}`}>{stale}d ago</span>
            </>
          )}
        </p>
      )}

      {top.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {top.map(([code, n]) => (
            <li key={code} className="flex items-baseline gap-2 text-caption">
              <span className="shrink-0 font-semibold tabular-nums text-warn">{n}</span>
              <span className="min-w-0 flex-1 truncate text-dim">{ISSUE_LABELS[code] ?? code}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── agent readiness ─────────────────────────────────────────────────────── */

/**
 * The is-agentic score. Distinct from everything else on this card because it
 * is the only externally-scored number — worth showing its provenance, since
 * an operator will want to open the public report.
 */
export function AgentReadiness({ audit }: { audit: TechnicalAudit | null }) {
  const a = detailOf(audit, 'agent-readiness');
  if (!a) return null;

  const score = num(a, 'score');
  const label = typeof a.scoreLabel === 'string' ? a.scoreLabel : null;
  const reportUrl = typeof a.reportUrl === 'string' ? a.reportUrl : null;
  const error = typeof a.error === 'string' ? a.error : null;
  const issues = Array.isArray(a.issues) ? (a.issues as Array<{ name?: string; result?: string }>) : [];

  return (
    <div className="mt-3">
      <SectionLabel>Agent readiness</SectionLabel>
      {score === null ? (
        <p className="text-caption leading-relaxed text-faint">{error ?? 'Not scored this run.'}</p>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span
              className={`num font-display text-title font-semibold tabular-nums ${
                score >= 80 ? 'text-accent' : score >= 50 ? 'text-warn' : 'text-danger'
              }`}
            >
              {score}
            </span>
            <span className="min-w-0 flex-1 truncate text-caption text-dim">{label ?? ''}</span>
          </div>
          {issues.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {issues.slice(0, 4).map((i, n) => (
                <li key={n} className="flex items-baseline gap-1.5 text-caption text-dim">
                  <span className={i.result === 'failed' ? 'text-danger' : 'text-warn'}>
                    {i.result === 'failed' ? '✕' : '△'}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                </li>
              ))}
            </ul>
          )}
          {reportUrl && (
            <a
              href={reportUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-block text-eyebrow font-medium text-accent underline-offset-2 hover:underline"
            >
              Full is-agentic report ↗
            </a>
          )}
        </>
      )}
    </div>
  );
}

/** Convenience: is this finding one the new checks own? */
export function isNewCheck(f: AuditFinding): boolean {
  return f.type === 'sitemap' || f.type === 'agent-readiness' || f.type === 'page-inventory';
}
