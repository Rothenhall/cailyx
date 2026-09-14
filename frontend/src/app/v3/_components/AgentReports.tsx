'use client';

/**
 * AgentReports — /v3. The section that fixes the console's biggest gap.
 *
 * Twelve agent cards existed and ten of them could only *run* things: a form, a
 * button, and a one-line toast when it finished. The output — authority
 * candidates, SERP snapshots, mention targets, council rankings, journeys,
 * personas — went into the database and was never readable anywhere. Eight
 * modules produced real, expensive, structured work that a delivery lead could
 * not see without opening the database.
 *
 * **One component, config per module.** The instinct is a bespoke workspace
 * each; that is how the console ended up with four workspaces behind four
 * unrelated entry points, and doing it eight more times makes navigation worse,
 * not better. Instead each module supplies ~15 lines that map its own shape onto
 * a common row — because the shapes genuinely differ, and pretending they are
 * identical would mean rendering raw JSON and calling it a report.
 *
 * `notMeasured` is mandatory per config, not optional. The most expensive
 * failure in this product is a client reading an absence as a finding, so every
 * empty state has to say whether nothing was found or nothing was looked for.
 *
 * @module app/v3/_components/AgentReports
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { AgentsResponse } from '@/types/terminal';
import { Button } from './Button';
import { ChevronLeft, SyncIcon } from './icons';

/** One normalised line in a report. Every module maps its own rows to this. */
interface ReportRow {
  id: string;
  title: string;
  /** The supporting detail — a URL, a role, a question. */
  subtitle?: string | null;
  /** A short right-aligned figure: a count, a score, a date. */
  meta?: string | null;
  /** Drives the dot colour. `neutral` when the row has no pass/fail meaning. */
  tone?: 'ok' | 'warn' | 'bad' | 'neutral';
  /** Opens in a new tab when present. */
  href?: string | null;
}

interface ModuleSpec {
  key: string;
  label: string;
  /** What this module answers, in one line. Shown above the rows. */
  blurb: string;
  /** Path under `/projects/:id/`. */
  path: string;
  /** Pull the array out of whatever envelope the endpoint uses. */
  extract: (data: unknown) => unknown[];
  /** Map one item to a row. */
  row: (item: Record<string, unknown>, i: number) => ReportRow;
  /** Shown when the list is empty — must distinguish "none" from "not run". */
  empty: string;
  /**
   * What this view cannot tell you. Required, not optional: an absence the
   * reader mistakes for a finding is the costliest error this UI can make.
   */
  notMeasured: string[];
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Parse a JSON-string column without throwing on the malformed ones. */
function jsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const p: unknown = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

const asArray = (d: unknown): unknown[] => (Array.isArray(d) ? d : []);
const fromKey =
  (key: string) =>
  (d: unknown): unknown[] => {
    if (Array.isArray(d)) return d;
    const o = d as Record<string, unknown> | null;
    return o && Array.isArray(o[key]) ? (o[key] as unknown[]) : [];
  };

const MODULES: ModuleSpec[] = [
  {
    key: 'authority',
    label: 'Authority',
    blurb: 'Third-party sites worth being mentioned on, and which are already cited.',
    path: 'authority-scans',
    extract: asArray,
    row: (s) => ({
      id: str(s.id, String(s.createdAt)),
      title: str(s.category, 'scan'),
      subtitle: `${str(s.method)} · ${jsonArray(s.listicleQueries).length} queries`,
      meta: `${num(s.candidateCount) ?? 0} found · ${num(s.promotedCount) ?? 0} promoted`,
      tone: str(s.status) === 'complete' ? 'ok' : str(s.status) === 'partial' ? 'warn' : 'neutral',
    }),
    empty: 'No authority scan has been run for this project.',
    notMeasured: [
      'Whether a candidate site would actually accept a mention — discovery only',
      'Domain authority or traffic of each candidate (needs a backlink data source)',
    ],
  },
  {
    key: 'serp',
    label: 'SERP',
    blurb: 'Tracked search queries and where this client ranks on them.',
    path: 'serp-trackers',
    extract: asArray,
    row: (t) => ({
      id: str(t.id),
      title: str(t.name, 'tracker'),
      subtitle: `${str(t.locationName)} · ${str(t.device)} · ${str(t.provider)}`,
      meta: str(t.status),
      tone: str(t.status) === 'active' ? 'ok' : 'neutral',
    }),
    empty: 'No SERP tracker configured. Rankings cannot be measured without one.',
    notMeasured: [
      'Anything outside the tracked queries — a tracker measures what you asked it to',
      'Live capture needs SWARM_ALLOW_LIVE plus DataForSEO credentials',
    ],
  },
  {
    key: 'mentions',
    label: 'Mentions',
    blurb: 'Pages being watched for a mention of this client, and whether it landed.',
    path: 'mentions/targets',
    extract: fromKey('targets'),
    row: (t) => ({
      id: str(t.id),
      title: str(t.label) || str(t.url),
      subtitle: str(t.url),
      href: str(t.url) || null,
      meta: str(t.type),
      tone: str(t.status) === 'live' ? 'ok' : str(t.status) === 'pending' ? 'warn' : 'neutral',
    }),
    empty: 'No mention targets yet — nothing is being watched.',
    notMeasured: ['Mentions on pages nobody added as a target'],
  },
  {
    key: 'monitoring',
    label: 'Monitoring',
    blurb: 'The current visibility snapshot, and what moved since the last one.',
    path: 'monitoring/snapshot',
    // The only module here that returns a single object rather than a list.
    // Rather than bend it into a fake list of one, its figures become the rows —
    // which is what a snapshot actually is.
    extract: (d) => {
      const o = d as Record<string, unknown> | null;
      if (!o || typeof o !== 'object') return [];
      return [
        { k: 'Visibility score', v: o.scoreTotal, band: o.scoreBand },
        { k: 'Mention rate', v: o.mentionRate, pct: true },
        { k: 'Citation rate', v: o.citationRate, pct: true },
        { k: 'Observations', v: o.observations },
      ];
    },
    row: (m, i) => {
      const v = m.v;
      const pct = m.pct === true;
      const shown =
        typeof v === 'number' ? (pct ? `${Math.round(v * 100)}%` : String(Math.round(v))) : '—';
      return {
        id: `m${i}`,
        title: str(m.k),
        subtitle: typeof m.band === 'string' ? m.band : null,
        meta: shown,
        // No tone: a score is not a pass or a fail without a target, and
        // colouring it as one would invent a threshold nobody set.
        tone: 'neutral',
      };
    },
    empty: 'No measurement runs yet, so there is nothing to snapshot.',
    notMeasured: [
      'Movement over time — this is the current state; the delta endpoint compares two',
      'Why a number moved: a snapshot records what, never why',
    ],
  },
  {
    key: 'council',
    label: 'Council',
    blurb: 'Multi-agent debates over what to do next, with the reasoning kept.',
    path: 'council',
    extract: asArray,
    row: (s) => ({
      id: str(s.id),
      title: str(s.question, 'session'),
      subtitle: `${num(s.rounds) ?? 0} round(s) · ${jsonArray(s.agentRoles).length} agents`,
      meta: str(s.status),
      tone: str(s.status) === 'complete' ? 'ok' : str(s.status) === 'failed' ? 'bad' : 'neutral',
    }),
    empty: 'No council session has been run.',
    notMeasured: ['Whether the recommendations were acted on — this records advice, not outcomes'],
  },
  {
    key: 'journeys',
    label: 'Journeys',
    blurb: 'Simulated buyer paths, and where in them this client appears.',
    path: 'journeys',
    extract: fromKey('journeys'),
    row: (j) => ({
      id: str(j.id),
      title: str(j.label, 'journey'),
      subtitle: `${str(j.objective)} · ${str(j.surface)} · ${str(j.geo)}`,
      meta: `depth ${num(j.maxDepth) ?? 0}`,
      tone: 'neutral',
    }),
    empty: 'No buyer journeys mapped yet.',
    notMeasured: ['Real buyer behaviour — these are simulated paths, not analytics'],
  },
  {
    key: 'personas',
    label: 'Personas',
    blurb: 'Who the client sells to, as the prompts and journeys model them.',
    path: 'personas',
    extract: asArray,
    row: (p) => ({
      id: str(p.id),
      title: str(p.label, 'persona'),
      subtitle: `${str(p.role)} · ${str(p.seniority)} · ${str(p.companyStage)}`,
      meta: str(p.awareness),
      tone: 'neutral',
    }),
    empty: 'No personas defined.',
    notMeasured: ['Whether these match real buyers — they are derived from the site, not from CRM data'],
  },
];

export function AgentReports({
  projectId,
  agents,
  onClose,
  onNotify,
}: {
  projectId: string | null;
  agents: AgentsResponse | null;
  onClose: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  const [active, setActive] = useState(MODULES[0].key);
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const spec = MODULES.find((m) => m.key === active) ?? MODULES[0];

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(null);
    try {
      const data = await apiFetch<unknown>(`/projects/${projectId}/${spec.path}`);
      const items = spec.extract(data);
      setRows(items.map((it, i) => spec.row((it ?? {}) as Record<string, unknown>, i)));
    } catch (e) {
      setRows(null);
      // Distinguished from "empty" on purpose — a failed fetch is not a finding
      // of zero, and rendering it as one would be a lie by omission.
      setFailed(e instanceof Error ? e.message : 'could not load');
    } finally {
      setLoading(false);
    }
  }, [projectId, spec]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The headline the agent roster already computed for this module, if any. */
  const headline = agents?.agents.find((a) => a.key === spec.key)?.headline ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Back"
          className="rounded-full bg-bg-inset text-dim"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">Agent results</span>
        <span className="truncate text-caption text-faint">{spec.blurb}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void load();
            onNotify(`${spec.label} reloaded`);
          }}
          className="ml-auto shrink-0 gap-1.5"
        >
          <SyncIcon className="h-3.5 w-3.5" />
          Reload
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-4 py-1.5">
        {MODULES.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => setActive(m.key)}
            className={`shrink-0 rounded-r2 px-2.5 py-1 text-caption transition-colors ${
              active === m.key ? 'bg-bg-inset font-semibold text-text' : 'text-faint hover:text-dim'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!projectId ? (
          <p className="text-body text-faint">Select a project first.</p>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="v3skel h-9 rounded-r2" />
            ))}
          </div>
        ) : (
          <div className="space-y-5">
            {headline && <p className="max-w-prose text-body leading-relaxed text-dim">{headline}</p>}

            {failed ? (
              <p className="text-body leading-relaxed text-a-warn">
                Could not load {spec.label.toLowerCase()}: {failed}. That is a fetch failure, not a
                result of zero.
              </p>
            ) : rows && rows.length > 0 ? (
              <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-start gap-3 px-3 py-2.5">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${toneDot(r.tone)}`} />
                    <div className="min-w-0 flex-1">
                      {r.href ? (
                        <a
                          href={r.href}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="block truncate text-body font-semibold text-text underline-offset-2 hover:text-accent hover:underline"
                        >
                          {r.title}
                        </a>
                      ) : (
                        <span className="block truncate text-body font-semibold text-text">{r.title}</span>
                      )}
                      {r.subtitle && (
                        <p className="mt-0.5 truncate text-caption text-faint">{r.subtitle}</p>
                      )}
                    </div>
                    {r.meta && (
                      <span className="shrink-0 text-caption tabular-nums text-faint">{r.meta}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="max-w-prose text-body leading-relaxed text-faint">{spec.empty}</p>
            )}

            {/* Always rendered, including when rows exist — what a view cannot
                see matters most when it looks complete. */}
            <section>
              <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
                Not measured here
              </h3>
              <ul className="space-y-1">
                {spec.notMeasured.map((n) => (
                  <li key={n} className="flex gap-2 text-caption leading-relaxed text-faint">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-border" />
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function toneDot(t: ReportRow['tone']): string {
  if (t === 'ok') return 'bg-a-ok';
  if (t === 'warn') return 'bg-a-warn';
  if (t === 'bad') return 'bg-danger';
  return 'bg-border-strong';
}
