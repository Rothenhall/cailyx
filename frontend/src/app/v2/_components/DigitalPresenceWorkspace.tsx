'use client';

/**
 * Digital Presence workspace — /v2. The full inventory, full canvas.
 *
 * Everything the console knows about where a client exists online, in one place:
 * the accounts (discovered and operator-supplied), the expected platforms with
 * no account, and the wider footprint assembled from the modules that own each
 * fact — identity from `aeo-audit`, owned properties from `technical-audit`,
 * connected data from `google`.
 *
 * Two rules the layout enforces:
 *
 * 1. **Three account states, never two.** `unverified` means found on the
 *    client's own site but the platform refused the check, and every row carries
 *    the platform's own reason verbatim rather than a summary of it.
 * 2. **`not-checked` is not `none`.** A module that has never run and a module
 *    that ran and found nothing are different answers. Footprint rows say which.
 * 3. **Search suggestions are not accounts.** SERP candidates live in their own
 *    tab, are excluded from every count, and need an explicit yes before they
 *    become accounts — because search genuinely cannot tell the client's profile
 *    from a similarly named stranger's.
 *
 * @module app/v2/_components/DigitalPresenceWorkspace
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  addPresenceAccount,
  confirmPresenceCandidate,
  discoverPresence,
  getPresence,
  getPresenceRun,
  removePresenceAccount,
} from '@/lib/terminal-api';
import { pollUntilDone } from '@/lib/poll-job';
import type { FootprintItem, PresenceAccount, PresenceInventory } from '@/types/terminal';
import { Button } from './Button';
import { ChevronLeft, CloseIcon, PlusIcon, SyncIcon } from './icons';

type Tab = 'analysis' | 'accounts' | 'suggested' | 'gaps' | 'footprint' | 'runs';

const TABS: { id: Tab; label: string }[] = [
  { id: 'analysis', label: 'Analysis' },
  { id: 'accounts', label: 'Profiles' },
  { id: 'suggested', label: 'Suggested' },
  { id: 'gaps', label: 'Gaps' },
  { id: 'footprint', label: 'Footprint' },
  { id: 'runs', label: 'Discovery' },
];

/** Stage 2's own category names, so the UI and the flowchart read the same. */
const GROUP_LABEL: Record<string, string> = {
  social: 'Social media profiles',
  directory: 'Industry & business directories',
  review: 'Review platforms',
  marketplace: 'Marketplaces & app stores',
  publishing: 'Publishing channels',
  personal: 'Personal profiles — not the company',
  other: 'Other declared profiles',
};

const COVERAGE_META: Record<string, { dot: string; text: string; label: string }> = {
  covered: { dot: 'bg-a-ok', text: 'text-a-ok', label: 'covered' },
  partial: { dot: 'bg-a-warn', text: 'text-a-warn', label: 'partial' },
  absent: { dot: 'bg-danger', text: 'text-danger', label: 'none found' },
  'not-checked': { dot: 'bg-border', text: 'text-faint', label: 'not checked' },
};

/** Copy for each account state. Wording matters more than colour here. */
const STATE_META: Record<string, { dot: string; text: string; label: string }> = {
  confirmed: { dot: 'bg-a-ok', text: 'text-a-ok', label: 'Verified' },
  unverified: { dot: 'bg-a-warn', text: 'text-a-warn', label: 'Not verifiable' },
  missing: { dot: 'bg-border-strong', text: 'text-faint', label: 'Not found' },
  candidate: { dot: 'bg-border-strong', text: 'text-faint', label: 'Unconfirmed' },
};

const FOOTPRINT_META: Record<string, { dot: string; label: string }> = {
  found: { dot: 'bg-a-ok', label: '' },
  none: { dot: 'bg-border-strong', label: 'none' },
  'not-checked': { dot: 'bg-border', label: 'not checked' },
};

export function DigitalPresenceWorkspace({
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
  const [data, setData] = useState<PresenceInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('analysis');
  const [url, setUrl] = useState('');
  /** Platform the operator clicked "add" on in the Gaps tab, prefilled. */
  const [gapFor, setGapFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setData(await getPresence(projectId));
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * @param searchWeb Also sweep Google. Costs a credit per platform, so it is a
   *   separate button rather than part of the free re-scan.
   */
  const discover = async (searchWeb = false) => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const queued = await discoverPresence(projectId, searchWeb);
      const run = await pollUntilDone(() => getPresenceRun(projectId, queued.id));
      await load();
      if (run.status === 'failed') {
        onNotify(`Discovery failed: ${run.error ?? 'unknown'}`, 'warn');
      } else if (searchWeb) {
        onNotify(
          `${run.candidates} suggestion${run.candidates === 1 ? '' : 's'} from ${run.serpQueries} search${run.serpQueries === 1 ? '' : 'es'} — confirm the ones that are yours`,
        );
        setTab('suggested');
      } else if (run.found === 0) {
        onNotify('No profile links found on the site — add them by URL', 'warn');
      } else {
        onNotify(`${run.found} found · ${run.confirmed} verified · ${run.unverified} not verifiable`);
      }
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'Discovery failed', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const value = url.trim();
    if (!projectId || !value || busy) return;
    setBusy(true);
    try {
      const acc = await addPresenceAccount(projectId, value);
      setUrl('');
      setGapFor(null);
      await load();
      onNotify(`${acc.label} added${acc.handle ? ` — @${acc.handle}` : ''}`);
      setTab('accounts');
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'Could not add that URL', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (acc: PresenceAccount) => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      await confirmPresenceCandidate(projectId, acc.id);
      await load();
      onNotify(`${acc.label} confirmed — it now counts as an account`);
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'Could not confirm', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (acc: PresenceAccount) => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      await removePresenceAccount(projectId, acc.id);
      await load();
      onNotify(`${acc.label} removed`);
    } catch (e) {
      onNotify(e instanceof ApiError ? e.message : 'Could not remove', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const counts = data?.counts;
  // Candidates are kept out of the account list entirely. Mixing a search guess
  // into the same list as a verified account is precisely the error the
  // `candidate` state exists to prevent.
  const rows = data?.accounts ?? [];
  const candidates = rows.filter((a) => a.state === 'candidate');
  /* Company profiles are the footprint. A founder's own LinkedIn or Scholar page
     is shown, clearly separated, and never counted as company reach. */
  const company = rows.filter((a) => a.state !== 'candidate' && a.entity !== 'personal');
  const people = rows.filter((a) => a.state !== 'candidate' && a.entity === 'personal');
  const grouped = groupAccounts(company);

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
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">Digital presence</span>
        <span className="truncate text-caption text-faint">{data?.domain ?? domain ?? '—'}</span>
        {counts && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 text-dim">
            {counts.total} account{counts.total === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-3 text-caption text-faint">
          {data?.lastRun && <span>scanned {rel(data.lastRun.startedAt)}</span>}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => discover(false)}
          disabled={busy}
          className="shrink-0 gap-1.5"
          title="Re-read the site for linked profiles. Free."
        >
          <SyncIcon className="h-3.5 w-3.5" />
          {busy ? 'working…' : 'Re-scan site'}
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
            {t.id === 'suggested' && candidates.length > 0 && (
              <span className="num ml-1.5 rounded-full border border-border bg-bg-inset px-1.5 text-eyebrow text-dim">
                {candidates.length}
              </span>
            )}
            {t.id === 'gaps' && !!data?.gaps.length && (
              <span className="num ml-1.5 rounded-full border border-a-warn-line bg-a-warn-soft px-1.5 text-eyebrow text-a-warn">
                {data.gaps.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading && !data ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="v2skel h-10 rounded-r3" />
            ))}
          </div>
        ) : !data ? (
          <p className="text-body text-faint">Nothing to show — the project has no presence record yet.</p>
        ) : tab === 'analysis' ? (
          <Analysis data={data} />
        ) : tab === 'accounts' ? (
          <Accounts grouped={grouped} people={people} onRemove={remove} busy={busy} />
        ) : tab === 'suggested' ? (
          <Suggested
            candidates={candidates}
            serpSkipped={data.lastRun?.serpSkipped ?? null}
            gapCount={data.gaps.length}
            onSearch={() => discover(true)}
            onConfirm={confirm}
            onRemove={remove}
            busy={busy}
          />
        ) : tab === 'gaps' ? (
          <Gaps
            data={data}
            gapFor={gapFor}
            setGapFor={setGapFor}
            url={url}
            setUrl={setUrl}
            onAdd={add}
            busy={busy}
          />
        ) : tab === 'footprint' ? (
          <Footprint data={data} />
        ) : (
          <Runs data={data} />
        )}
      </div>

      {/* add bar — always reachable, not buried in a tab */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
        <PlusIcon className="h-3.5 w-3.5 text-faint" />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
          placeholder="Paste a profile URL — https://instagram.com/yourbrand"
          className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-2.5 py-1.5 text-caption text-text outline-none placeholder:text-faint focus:border-accent-dim"
        />
        <Button type="button" variant="soft" size="sm" onClick={add} disabled={busy || !url.trim()}>
          Add account
        </Button>
      </div>
    </div>
  );
}

/* ── tabs ─────────────────────────────────────────────────────────────── */

function Accounts({
  grouped,
  people,
  onRemove,
  busy,
}: {
  grouped: Array<{ group: string; accounts: PresenceAccount[] }>;
  people: PresenceAccount[];
  onRemove: (a: PresenceAccount) => void;
  busy: boolean;
}) {
  if (grouped.length === 0 && people.length === 0) {
    return (
      <p className="text-body leading-relaxed text-faint">
        No accounts yet. Run a scan, or paste a profile URL below — a site that links nothing is common,
        and the operator&apos;s list is as good a source as the crawler&apos;s.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {grouped.map(({ group, accounts }) => (
        <section key={group}>
          <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
            {GROUP_LABEL[group] ?? group}
          </h3>
          <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
            {accounts.map((a) => {
              const meta = STATE_META[a.state] ?? STATE_META.missing;
              return (
                <li key={a.id} className="flex items-start gap-3 px-3 py-2.5">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-body font-semibold text-text">{a.label}</span>
                      {a.handle && <span className="truncate text-caption text-dim">@{a.handle}</span>}
                      <span className={`ml-auto shrink-0 text-caption ${meta.text}`}>{meta.label}</span>
                    </div>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block truncate text-caption text-faint underline-offset-2 hover:text-accent hover:underline"
                    >
                      {a.url}
                    </a>
                    {/* The platform's own words, not a paraphrase — an operator
                        deciding whether to chase this needs the real reason. */}
                    {a.reason && <p className="mt-0.5 text-caption leading-relaxed text-a-warn">{a.reason}</p>}
                    <p className="mt-0.5 text-caption text-faint">
                      {a.sourceLabel}
                      {a.foundOn ? ` · found on ${a.foundOn}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(a)}
                    disabled={busy}
                    aria-label={`Remove ${a.label}`}
                    className="mt-0.5 shrink-0 rounded-full p-1 text-faint transition-colors hover:bg-bg-inset hover:text-danger disabled:opacity-40"
                  >
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {/* People, below and visibly apart. These are real and worth having, but
          they are not the company's footprint and are excluded from every count
          above — a founder's Google Scholar page is not corporate reach. */}
      {people.length > 0 && (
        <section>
          <h3 className="mb-1 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
            {GROUP_LABEL.personal}
          </h3>
          <p className="mb-1.5 max-w-prose text-caption leading-relaxed text-faint">
            Found on the site and recorded, but excluded from the company counts.
          </p>
          <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60 opacity-80">
            {people.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-3 py-2">
                <span className="text-body text-dim">{a.label}</span>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 flex-1 truncate text-caption text-faint underline-offset-2 hover:text-accent hover:underline"
                >
                  {a.url}
                </a>
                <button
                  type="button"
                  onClick={() => onRemove(a)}
                  disabled={busy}
                  aria-label={`Remove ${a.label}`}
                  className="shrink-0 rounded-full p-1 text-faint transition-colors hover:bg-bg-inset hover:text-danger disabled:opacity-40"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The "analyse" half of stage 2 — current state of the company online. */
function Analysis({ data }: { data: PresenceInventory }) {
  const a = data.assessment;
  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
          Current state
        </h3>
        <ul className="space-y-1.5">
          {a.headlines.map((h, i) => (
            <li key={i} className="flex gap-2 text-body leading-relaxed text-dim">
              <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-border-strong" />
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
          Coverage by category
        </h3>
        {/* The expected set is a guess from the client's own category text.
            Printing it makes a wrong guess arguable instead of invisible. */}
        <p className="mb-1.5 text-caption leading-relaxed text-faint">
          Judged as <span className="text-dim">{a.businessProfileLabel}</span>
          {a.inferredFrom ? <> — inferred from &ldquo;{a.inferredFrom}&rdquo;</> : null}. Change the
          project category if that is wrong; it decides which platforms count as gaps.
        </p>
        <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
          {a.coverage.map((c) => {
            const meta = COVERAGE_META[c.state] ?? COVERAGE_META['not-checked'];
            return (
              <li key={c.group} className="flex items-start gap-3 px-3 py-2.5">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-body font-semibold text-text">{c.label}</span>
                    <span className={`ml-auto shrink-0 text-caption ${meta.text}`}>{meta.label}</span>
                  </div>
                  <p className="mt-0.5 text-caption leading-relaxed text-faint">{c.note}</p>
                </div>
                <span className="w-8 shrink-0 text-right text-body font-semibold tabular-nums text-dim">
                  {c.held}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {/* Named, never implied by silence. An audit that hides what it did not
          look at is worse than one that reports less and says so. */}
      <section>
        <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
          Not measured yet
        </h3>
        <ul className="space-y-1">
          {a.notMeasured.map((n) => (
            <li key={n.label} className="flex gap-2 text-caption leading-relaxed text-faint" title={n.note}>
              <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-border" />
              <span>
                {n.label}
                <span className="ml-1.5 text-faint/70">
                  ({n.state === 'not-built' ? 'not built' : n.state === 'not-configured' ? 'not configured' : 'not run yet'})
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Suggested({
  candidates,
  serpSkipped,
  gapCount,
  onSearch,
  onConfirm,
  onRemove,
  busy,
}: {
  candidates: PresenceAccount[];
  serpSkipped: string | null;
  gapCount: number;
  onSearch: () => void;
  onConfirm: (a: PresenceAccount) => void;
  onRemove: (a: PresenceAccount) => void;
  busy: boolean;
}) {
  /* The cost is stated on the button, not buried in a tooltip. One credit per
     platform still missing — the operator should know the price before paying. */
  const searchButton = (
    <Button type="button" variant="soft" size="sm" onClick={onSearch} disabled={busy || gapCount === 0}>
      {busy ? 'searching…' : `Search Google (${gapCount} credit${gapCount === 1 ? '' : 's'})`}
    </Button>
  );

  if (candidates.length === 0) {
    return (
      <div className="max-w-prose space-y-3">
        <p className="text-body leading-relaxed text-dim">
          {gapCount === 0
            ? 'Every expected platform already has an account — nothing left to search for.'
            : `Google can be searched for accounts the site does not link. It costs one credit per platform (${gapCount} missing), and everything it finds needs your confirmation before it counts.`}
        </p>
        {serpSkipped && (
          <p className="text-caption leading-relaxed text-faint">Last scan: {serpSkipped}</p>
        )}
        <div>{searchButton}</div>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-3 max-w-prose text-body leading-relaxed text-dim">
        Google found these on platforms the site does not link. <span className="text-text">They are not
        accounts yet.</span> Search cannot tell a client&apos;s profile from a similarly named stranger&apos;s —
        a real query for HubSpot returns three genuine HubSpot accounts and one unrelated podcast — so each
        one needs your yes. Confirmed rows become operator-supplied and survive re-scans.
      </p>
      <div className="mb-3">{searchButton}</div>
      <ul className="space-y-1.5">
        {candidates.map((c) => (
          <li key={c.id} className="rounded-r3 border border-border bg-bg-raised px-3 py-2.5">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-body font-semibold text-text">{c.label}</span>
                  {c.handle && <span className="truncate text-caption text-dim">@{c.handle}</span>}
                  {c.confidence !== null && (
                    <span
                      className="ml-auto shrink-0 text-caption text-faint"
                      title="Name similarity only. A high score on the wrong company is still the wrong company."
                    >
                      {Math.round(c.confidence * 100)}% name match
                    </span>
                  )}
                </div>
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate text-caption text-faint underline-offset-2 hover:text-accent hover:underline"
                >
                  {c.url}
                </a>
                {c.title && <p className="mt-0.5 truncate text-caption text-dim">{c.title}</p>}
                {c.foundOn && (
                  <p className="mt-0.5 truncate text-caption text-faint">found via {c.foundOn}</p>
                )}
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              <Button type="button" variant="soft" size="sm" onClick={() => onConfirm(c)} disabled={busy}>
                Yes, this is us
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onRemove(c)} disabled={busy}>
                Not us
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gaps({
  data,
  gapFor,
  setGapFor,
  url,
  setUrl,
  onAdd,
  busy,
}: {
  data: PresenceInventory;
  gapFor: string | null;
  setGapFor: (p: string | null) => void;
  url: string;
  setUrl: (v: string) => void;
  onAdd: () => void;
  busy: boolean;
}) {
  if (data.gaps.length === 0) {
    return (
      <p className="text-body leading-relaxed text-faint">
        Every expected platform has an account. Nothing to fill in.
      </p>
    );
  }

  return (
    <div>
      <p className="mb-3 max-w-prose text-body leading-relaxed text-dim">
        These platforms have no account linked from {data.domain} and none supplied by hand. That may mean
        the client has no presence there — or that it exists and simply is not linked. The crawler cannot
        tell those apart, so it does not guess.
      </p>
      <ul className="space-y-1.5">
        {data.gaps.map((g) => (
          <li
            key={g.platform}
            className="rounded-r3 border border-border bg-bg-raised px-3 py-2.5"
          >
            <div className="flex items-center gap-3">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" />
              <span className="text-body font-semibold text-text">{g.label}</span>
              <span className="text-caption text-faint">not found</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => setGapFor(gapFor === g.platform ? null : g.platform)}
              >
                {gapFor === g.platform ? 'cancel' : 'I have one'}
              </Button>
            </div>
            {gapFor === g.platform && (
              <div className="mt-2 flex gap-1.5">
                <input
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onAdd();
                    if (e.key === 'Escape') setGapFor(null);
                  }}
                  placeholder={`Paste the ${g.label} profile URL`}
                  className="min-w-0 flex-1 rounded-r2 border border-border bg-bg px-2 py-1 text-caption text-text outline-none placeholder:text-faint focus:border-accent-dim"
                />
                <Button type="button" variant="soft" size="sm" onClick={onAdd} disabled={busy || !url.trim()}>
                  Save
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Footprint({ data }: { data: PresenceInventory }) {
  return (
    <div className="space-y-5">
      <p className="max-w-prose text-body leading-relaxed text-dim">
        Everything the other modules have discovered about this client. Each line names the module that
        produced it — and <span className="text-text">not checked</span> is not the same as{' '}
        <span className="text-text">none</span>: one means nobody has looked yet.
      </p>
      {data.footprint.map((section) => (
        <section key={section.key}>
          <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
            {section.label}
          </h3>
          <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
            {section.items.map((it) => (
              <FootprintRow key={`${section.key}:${it.label}`} item={it} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function FootprintRow({ item }: { item: FootprintItem }) {
  const meta = FOOTPRINT_META[item.state] ?? FOOTPRINT_META['not-checked'];
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
      <span className="text-body text-dim">{item.label}</span>
      <span
        className={`ml-auto max-w-[50%] truncate text-body ${
          item.state === 'found' ? 'font-semibold text-text' : 'text-faint'
        }`}
      >
        {item.detail ?? meta.label}
      </span>
      <span className="w-28 shrink-0 truncate text-right text-caption text-faint">{item.source}</span>
    </li>
  );
}

function Runs({ data }: { data: PresenceInventory }) {
  const run = data.lastRun;
  if (!run) {
    return <p className="text-body text-faint">No scan has been run for this project yet.</p>;
  }
  const rows: Array<[string, string]> = [
    ['Status', run.status],
    ['Pages read', String(run.pagesFetched)],
    ['Accounts found', String(run.found)],
    ['Verified', String(run.confirmed)],
    ['Not verifiable', String(run.unverified)],
    ['Started', new Date(run.startedAt).toLocaleString()],
  ];
  const sources = Object.entries(run.sources);

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
        {rows.map(([k, v]) => (
          <li key={k} className="flex items-center justify-between px-3 py-2">
            <span className="text-body text-dim">{k}</span>
            <span className="text-body font-semibold tabular-nums text-text">{v}</span>
          </li>
        ))}
      </ul>
      {sources.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-eyebrow font-semibold uppercase tracking-eyebrow text-faint">
            Where they came from
          </h3>
          <ul className="divide-y divide-border/50 overflow-hidden rounded-r3 border border-border/60">
            {sources.map(([k, n]) => (
              <li key={k} className="flex items-center justify-between px-3 py-2">
                <span className="text-body text-dim">{k}</span>
                <span className="text-body font-semibold tabular-nums text-text">{n}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.error && <p className="text-body leading-relaxed text-danger">{run.error}</p>}
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Group accounts for display, in a fixed order so the page does not reshuffle. */
function groupAccounts(accounts: PresenceAccount[]): Array<{ group: string; accounts: PresenceAccount[] }> {
  const order = ['social', 'directory', 'review', 'marketplace', 'publishing', 'other'];
  return order
    .map((group) => ({ group, accounts: accounts.filter((a) => a.group === group) }))
    .filter((g) => g.accounts.length > 0);
}

/** Coarse relative time — exact timestamps live in the Discovery tab. */
function rel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
