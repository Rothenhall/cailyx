'use client';

/**
 * Competitors workspace — /v2. Stage 7 of the delivery flow, full canvas.
 *
 * Answers one question: **where do your rivals exist that you do not?** Not
 * "who is winning" — the data does not support a composite score and this
 * module deliberately does not invent one, so every view here is a diff or a
 * count, never a rank.
 *
 * Five tabs, the same pattern the AEO and Presence workspaces use.
 *
 * Three honesty rules the layout enforces:
 *
 * 1. **`unknown` is not `absent`.** A rival whose AEO status is `unknown` means
 *    no completed audit exists to attach — nobody has looked. Rendering that as
 *    "not present" would report an unasked question as a negative finding.
 * 2. **The gap that matters is `competitorsOnly`.** It leads every diff, because
 *    "three rivals are on Clutch and you are not" is the row a client acts on;
 *    `clientOnly` is reassurance and sits last.
 * 3. **Nothing here triggers a fresh SERP or AEO run.** These are attachments to
 *    what those modules already measured, and the note from the API says so
 *    verbatim rather than being paraphrased into something softer.
 *
 * @module app/v2/_components/CompetitorsWorkspace
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { discoverCompetitors, getCompetitorGap, listCompetitorProfiles } from '@/lib/terminal-api';
import type { CompetitorGap, CompetitorRow, GapDiff, GapDiffLine } from '@/types/terminal';
import { Button } from './Button';
import { ChevronLeft, SyncIcon } from './icons';

type Tab = 'gap' | 'presence' | 'tech' | 'schema' | 'rivals';

const TABS: { id: Tab; label: string }[] = [
  { id: 'gap', label: 'Overview' },
  { id: 'presence', label: 'Presence' },
  { id: 'tech', label: 'Tech' },
  { id: 'schema', label: 'Schema' },
  { id: 'rivals', label: 'Rivals' },
];

/** `unknown` is its own state — nobody looked, which is not the same as absent. */
const STATUS_META: Record<string, { dot: string; text: string; label: string }> = {
  present: { dot: 'bg-a-ok', text: 'text-a-ok', label: 'present' },
  absent: { dot: 'bg-border-strong', text: 'text-faint', label: 'absent' },
  unknown: { dot: 'bg-border', text: 'text-faint', label: 'not checked' },
};

export function CompetitorsWorkspace({
  projectId,
  domain,
  onClose,
  onNotify,
}: {
  projectId: string | null;
  domain: string | null;
  onClose: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  const [gap, setGap] = useState<CompetitorGap | null>(null);
  const [rivals, setRivals] = useState<CompetitorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('gap');

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    // Independent: a gap that fails must not hide the rival list the operator
    // came to check, and vice versa.
    const [g, r] = await Promise.all([
      getCompetitorGap(projectId).catch(() => null),
      listCompetitorProfiles(projectId).catch(() => []),
    ]);
    setGap(g);
    setRivals(r);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const discover = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const res = await discoverCompetitors(projectId);
      await load();
      onNotify(
        res.totalCompetitors === 0
          ? 'No competitors on record — add them in the project context first'
          : `${res.totalCompetitors} competitor${res.totalCompetitors === 1 ? '' : 's'} profiled` +
            (res.promoted ? ` (${res.promoted} newly promoted)` : ''),
        res.totalCompetitors === 0 ? 'warn' : 'ok',
      );
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'Profiling failed', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const profiled = rivals.filter((r) => r.latestProfile !== null).length;

  return (
    <div className="v2-audit-ws pointer-events-auto absolute inset-0 z-40 flex flex-col bg-bg">
      {/* header */}
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
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">Competitors</span>
        <span className="truncate text-caption text-faint">{gap?.domain ?? domain ?? '—'}</span>
        {rivals.length > 0 && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 text-dim">
            {profiled}/{rivals.length} profiled
          </span>
        )}
        <span className="ml-auto" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={discover}
          disabled={busy}
          className="shrink-0 gap-1.5"
          title="Crawls each rival's site — tech stack, schema and their own external profiles."
        >
          <SyncIcon className="h-3.5 w-3.5" />
          {busy ? 'profiling…' : 'Re-profile'}
        </Button>
      </div>

      {/* tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-r2 px-2.5 py-1 text-caption transition-colors ${
              tab === t.id ? 'bg-bg-inset font-semibold text-text' : 'text-faint hover:text-dim'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="v2skel h-10 rounded-r3" />
            ))}
          </div>
        ) : rivals.length === 0 ? (
          <Empty onDiscover={discover} busy={busy} />
        ) : tab === 'gap' ? (
          <Overview gap={gap} rivals={rivals} />
        ) : tab === 'presence' ? (
          <DiffView
            diff={gap?.presence ?? null}
            title="External presence"
            blurb="Platforms your rivals are on. This is the row a client acts on — a tech-stack diff is trivia by comparison."
          />
        ) : tab === 'tech' ? (
          <DiffView
            diff={gap?.tech ?? null}
            title="Technology"
            blurb="Signatures detected on each homepage — CMS, analytics, hosting, marketing tools."
          />
        ) : tab === 'schema' ? (
          <DiffView
            diff={gap?.schema ?? null}
            title="Structured data"
            blurb="schema.org types found in each site's JSON-LD."
          />
        ) : (
          <Rivals rivals={rivals} />
        )}
      </div>

      {gap && (
        <p className="shrink-0 border-t border-border px-4 py-2 text-caption leading-relaxed text-faint">
          {gap.note}
        </p>
      )}
    </div>
  );
}

/* ── tabs ─────────────────────────────────────────────────────────────── */

function Empty({ onDiscover, busy }: { onDiscover: () => void; busy: boolean }) {
  return (
    <div className="max-w-prose space-y-3">
      <p className="text-body leading-relaxed text-dim">
        No competitors profiled yet. Profiling reads each rival&apos;s homepage for its technology and
        structured data, crawls their site for the external profiles they link, and attaches whatever
        SERP and answer-engine data has already been measured for them.
      </p>
      <p className="text-caption leading-relaxed text-faint">
        It never triggers a fresh SERP or AEO run, and never spends paid enrichment credit per rival.
      </p>
      <Button type="button" variant="soft" size="sm" onClick={onDiscover} disabled={busy}>
        {busy ? 'profiling…' : 'Profile competitors'}
      </Button>
    </div>
  );
}

function Overview({ gap, rivals }: { gap: CompetitorGap | null; rivals: CompetitorRow[] }) {
  if (!gap) {
    return <p className="text-body text-faint">The gap comparison could not be loaded.</p>;
  }

  /* Worst-first: the categories where rivals have most that the client lacks. */
  const groups: Array<{ label: string; diff: GapDiff }> = [
    { label: 'External presence', diff: gap.presence },
    { label: 'Technology', diff: gap.tech },
    { label: 'Structured data', diff: gap.schema },
  ];

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
          Where rivals are ahead
        </h3>
        <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
          {groups.map((g) => (
            <li key={g.label} className="flex items-start gap-3 px-3 py-2.5">
              <span
                className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  g.diff.competitorsOnly.length > 0 ? 'bg-a-warn' : 'bg-a-ok'
                }`}
              />
              <div className="min-w-0 flex-1">
                <span className="text-body font-semibold text-text">{g.label}</span>
                <p className="mt-0.5 text-caption leading-relaxed text-faint">
                  {g.diff.competitorsOnly.length === 0
                    ? 'Nothing your rivals have that you do not.'
                    : g.diff.competitorsOnly
                        .slice(0, 6)
                        .map((l) => l.key)
                        .join(', ') + (g.diff.competitorsOnly.length > 6 ? ' …' : '')}
                </p>
              </div>
              <span className="w-8 shrink-0 text-right text-body font-semibold tabular-nums text-dim">
                {g.diff.competitorsOnly.length}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
          Rivals
        </h3>
        <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
          {rivals.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <span className="text-body text-text">{r.name}</span>
              <span className="min-w-0 flex-1 truncate text-caption text-faint">{r.domain ?? '—'}</span>
              <span className="shrink-0 text-caption text-faint">
                {r.latestProfile
                  ? r.latestProfile.status === 'skipped'
                    ? 'no domain'
                    : r.latestProfile.status
                  : 'not profiled'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * One diff, `competitorsOnly` first.
 *
 * The order is the argument: what rivals have and the client does not is the
 * actionable half, shared is context, and what the client has alone is
 * reassurance. Putting reassurance first would bury the finding.
 */
function DiffView({ diff, title, blurb }: { diff: GapDiff | null; title: string; blurb: string }) {
  if (!diff) return <p className="text-body text-faint">No comparison available.</p>;

  const sections: Array<{ label: string; lines: GapDiffLine[]; tone: string; hint: string }> = [
    {
      label: 'They have, you do not',
      lines: diff.competitorsOnly,
      tone: 'bg-a-warn',
      hint: 'The actionable half.',
    },
    { label: 'Both', lines: diff.shared, tone: 'bg-a-ok', hint: 'Parity — no action implied.' },
    {
      label: 'You have, they do not',
      lines: diff.clientOnly,
      tone: 'bg-accent',
      hint: 'Your edge, for what it is worth.',
    },
  ];

  return (
    <div className="space-y-5">
      <p className="max-w-prose text-body leading-relaxed text-dim">{blurb}</p>
      {diff.client.length === 0 && (
        <p className="max-w-prose text-caption leading-relaxed text-a-warn">
          Nothing recorded on your side for {title.toLowerCase()} — so every rival signature shows as a
          gap. Run the relevant scan on your own domain before reading this as a finding.
        </p>
      )}
      {sections.map((s) => (
        <section key={s.label}>
          <h3 className="mb-1.5 flex items-baseline gap-2 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
            <span className={`h-1.5 w-1.5 rounded-full ${s.tone}`} />
            {s.label}
            <span className="ml-auto normal-case tracking-normal text-faint">{s.hint}</span>
          </h3>
          {s.lines.length === 0 ? (
            <p className="px-1 text-caption text-faint">None.</p>
          ) : (
            <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
              {s.lines.map((l) => (
                <li key={l.key} className="flex items-center gap-3 px-3 py-2">
                  <span className="text-body text-dim">{l.key}</span>
                  <span className="ml-auto min-w-0 truncate text-right text-caption text-faint">
                    {l.competitors.length > 0 ? l.competitors.join(', ') : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function Rivals({ rivals }: { rivals: CompetitorRow[] }) {
  return (
    <div className="space-y-3">
      {rivals.map((r) => {
        const p = r.latestProfile;
        return (
          <section key={r.id} className="overflow-hidden rounded-r3 border border-border/60">
            <div className="flex items-center gap-2 border-b border-border/60 bg-bg-inset/40 px-3 py-2">
              <span className="text-body font-semibold text-text">{r.name}</span>
              <span className="truncate text-caption text-faint">{r.domain ?? 'no domain on record'}</span>
              <span className="ml-auto shrink-0 text-caption text-faint">{r.source}</span>
            </div>

            {!p ? (
              <p className="px-3 py-2.5 text-caption text-faint">Not profiled yet.</p>
            ) : (
              <div className="divide-y divide-border/50">
                <StatusRow
                  label="Answer engines"
                  status={p.aeoStatus}
                  detail={
                    p.aeoStanding
                      ? `${Math.round(p.aeoStanding.mentionRate * 100)}% mention rate · ${Math.round(
                          p.aeoStanding.share * 100,
                        )}% share of voice`
                      : null
                  }
                />
                <StatusRow
                  label="Search results"
                  status={p.serpStatus}
                  detail={
                    p.serpPresence
                      ? `${p.serpPresence.occurrences} result${p.serpPresence.occurrences === 1 ? '' : 's'}` +
                        (p.serpPresence.bestRank ? ` · best rank ${p.serpPresence.bestRank}` : '')
                      : null
                  }
                />
                <div className="px-3 py-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-body text-dim">External profiles</span>
                    <span className="ml-auto text-caption text-faint">
                      {p.presenceStatus === 'completed'
                        ? `${p.presenceAccounts.length} found`
                        : p.presenceStatus === 'skipped'
                          ? 'no domain to crawl'
                          : p.presenceStatus}
                    </span>
                  </div>
                  {p.presenceAccounts.length > 0 && (
                    <ul className="mt-1.5 flex flex-wrap gap-1">
                      {p.presenceAccounts.map((a) => (
                        <li key={a.url}>
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="rounded-full border border-border px-2 py-0.5 text-caption text-dim transition-colors hover:border-accent-dim hover:text-accent"
                          >
                            {a.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {p.presenceError && (
                    <p className="mt-0.5 text-caption text-a-warn">{p.presenceError}</p>
                  )}
                </div>
                {p.schemaTypes.length > 0 && (
                  <div className="px-3 py-2">
                    <span className="text-body text-dim">Schema</span>
                    <p className="mt-0.5 text-caption text-faint">{p.schemaTypes.join(', ')}</p>
                  </div>
                )}
                {p.error && <p className="px-3 py-2 text-caption text-a-warn">{p.error}</p>}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function StatusRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: string;
  detail: string | null;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
      <span className="text-body text-dim">{label}</span>
      <span className={`ml-auto shrink-0 text-caption ${meta.text}`}>{detail ?? meta.label}</span>
    </div>
  );
}
