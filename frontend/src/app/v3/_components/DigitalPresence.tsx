'use client';

/**
 * Digital Presence — /v3. The card above Audits.
 *
 * Answers the question that comes *before* any score: **where does this client
 * exist online, and what did we actually find?** Audits report on a site we
 * already know about; this reports on the footprint itself.
 *
 * Three states per account, never two. An account linked from the client's own
 * footer that the platform then refused to serve is `unverified` — Instagram and
 * Facebook wall logged-out requests and LinkedIn answers datacentre IPs with
 * `999`. Showing that as "missing" would send an operator to fix a working
 * account, so the card keeps confirmed and unverified visually distinct and
 * prints the platform's own reason on hover.
 *
 * Search suggestions are counted separately and never folded into the account
 * total: a SERP hit is an unanswered question, not a found account.
 *
 * Compact by necessity: this column is 320px. The full inventory — every
 * account, every gap, and the wider footprint from the other modules — opens in
 * <DigitalPresenceWorkspace>, the same grid→detail move the audit tiles make.
 *
 * @module app/v3/_components/DigitalPresence
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { addPresenceAccount, discoverPresence, getPresence, getPresenceRun } from '@/lib/terminal-api';
import { pollUntilDone } from '@/lib/poll-job';
import type { PresenceInventory } from '@/types/terminal';
import { Button } from './Button';
import { LayersIcon, PlusIcon, SyncIcon } from './icons';

/** Dot colour per state. `unverified` is brass, not red — it is not a fault. */
const STATE_DOT: Record<string, string> = {
  confirmed: 'bg-a-ok',
  unverified: 'bg-a-warn',
  missing: 'bg-border-strong',
};

export function DigitalPresence({
  projectId,
  domain,
  booting,
  onNotify,
  onExpand,
}: {
  projectId: string | null;
  domain: string | null;
  booting: boolean;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
  onExpand: () => void;
}) {
  const [data, setData] = useState<PresenceInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');

  const load = useCallback(async () => {
    if (!projectId) {
      setData(null);
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

  const discover = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const queued = await discoverPresence(projectId);
      const run = await pollUntilDone(() => getPresenceRun(projectId, queued.id));
      await load();
      if (run.status === 'failed') {
        onNotify(`Discovery failed: ${run.error ?? 'unknown error'}`, 'warn');
      } else if (run.found === 0 && run.candidates === 0) {
        // Not an error, and worth saying plainly: a site with no profile links
        // is common, and the fix is the operator's to make.
        onNotify(`No accounts linked from ${domain ?? 'the site'} — add them by URL`, 'warn');
      } else {
        const parts = [`${run.found} linked from the site`];
        if (run.candidates) parts.push(`${run.candidates} search suggestion${run.candidates === 1 ? '' : 's'} to confirm`);
        onNotify(parts.join(' · '));
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
      setAdding(false);
      await load();
      onNotify(`${acc.label} added${acc.handle ? ` — @${acc.handle}` : ''}`);
    } catch (e) {
      // The 400 from the backend names what was wrong with the URL (a post
      // rather than a profile, a share link); surface it verbatim.
      onNotify(e instanceof ApiError ? e.message : 'Could not add that URL', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const skeleton = booting || (loading && !data);
  const counts = data?.counts;
  /* Chips show accounts only. A search candidate sitting in this row would read
     as "we found your Instagram" when what we mean is "is this yours?". */
  const chips = (data?.accounts ?? []).filter(
    (a) => a.state !== 'candidate' && a.entity !== 'personal',
  );
  const never = !!data && data.lastRun === null && counts?.total === 0;

  return (
    <div className="v3-audit-ws flex h-full flex-col overflow-hidden rounded-r4 border border-border bg-bg-raised shadow-e1">
      {/* header */}
      <div className="shrink-0 px-4 pb-2.5 pt-4">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-r2 bg-accent text-bg-raised">
            <LayersIcon className="h-4 w-4" />
          </span>
          <span className="font-display text-ui font-semibold tracking-tight2 text-text">Presence</span>
          {counts && counts.total > 0 && (
            <button
              type="button"
              onClick={onExpand}
              className="ml-auto shrink-0 text-caption text-faint underline-offset-2 hover:text-accent hover:underline"
            >
              view all
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 px-3 pb-3">
        {skeleton ? (
          <div className="space-y-1.5">
            <div className="v3skel h-6 rounded-r2" />
            <div className="v3skel h-14 rounded-r3" />
          </div>
        ) : !projectId ? (
          <p className="px-1 py-3 text-body leading-relaxed text-faint">
            Select a project to see its digital footprint.
          </p>
        ) : (
          <>
            {/* the count line — the thing the operator came for */}
            <div className="flex items-baseline gap-2 px-1">
              <span className="num font-display text-display font-medium tabular-nums text-text">
                {counts?.total ?? 0}
              </span>
              <span className="text-body text-dim">
                company profile{counts?.total === 1 ? '' : 's'}
              </span>
              {!!counts?.personal && (
                <span
                  className="ml-auto text-caption text-faint"
                  title="A founder's own profiles. Real, but not the company's footprint, so they are not counted here."
                >
                  +{counts.personal} personal
                </span>
              )}
            </div>

            {/* provenance split — counted states never merged into one number */}
            {!!counts?.total && (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-caption text-faint">
                <span className="flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT.confirmed}`} />
                  {counts.confirmed} verified
                </span>
                {counts.unverified > 0 && (
                  <span
                    className="flex items-center gap-1.5"
                    title="Found on the client's own site, but the platform refused the check. Not a missing account."
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT.unverified}`} />
                    {counts.unverified} not verifiable
                  </span>
                )}
              </div>
            )}

            {/* what we have */}
            {!!chips.length && (
              <ul className="mt-2.5 flex flex-wrap gap-1">
                {chips.slice(0, 8).map((a) => (
                  <li key={a.id}>
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={a.reason ?? `${a.sourceLabel}${a.handle ? ` · @${a.handle}` : ''}`}
                      className="flex items-center gap-1.5 rounded-full border border-border bg-bg-raised px-2 py-0.5 text-caption text-dim transition-colors hover:border-accent-dim hover:text-accent"
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[a.state]}`} />
                      {a.label}
                    </a>
                  </li>
                ))}
                {chips.length > 8 && (
                  <li className="px-1.5 py-0.5 text-caption text-faint">
                    +{chips.length - 8} more
                  </li>
                )}
              </ul>
            )}

            {/* search suggestions — deliberately NOT folded into the count
                above; they are unanswered questions, not accounts */}
            {!!counts?.candidates && (
              <button
                type="button"
                onClick={onExpand}
                className="mt-2 flex w-full items-center gap-1.5 rounded-r2 border border-border bg-bg-raised px-2 py-1.5 text-left text-caption text-dim transition-colors hover:border-accent-dim hover:text-accent"
              >
                <span className="num font-semibold">{counts.candidates}</span>
                <span>search suggestion{counts.candidates === 1 ? '' : 's'} to confirm</span>
                <span className="ml-auto">→</span>
              </button>
            )}

            {/* what is missing — the actionable half */}
            {!!data?.gaps.length && (
              <p className="mt-2 px-1 text-caption leading-relaxed text-faint">
                Not found:{' '}
                <span className="text-dim">{data.gaps.map((g) => g.label).join(', ')}</span>
              </p>
            )}

            {never && (
              <p className="mt-2 px-1 text-body leading-relaxed text-faint">
                Nothing discovered yet. Reads {domain ?? 'the site'} for linked profiles — costs nothing.
              </p>
            )}

            {/* actions */}
            <div className="mt-3 flex items-center gap-1.5">
              <Button
                type="button"
                variant={never ? 'soft' : 'outline'}
                size="sm"
                onClick={discover}
                disabled={busy}
                className="gap-1.5"
              >
                <SyncIcon className="h-3.5 w-3.5" />
                {busy ? 'working…' : never ? 'Discover' : 'Re-scan'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAdding((v) => !v)}
                disabled={busy}
                className="gap-1.5"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                Add
              </Button>
              {!!counts?.total && (
                <button
                  type="button"
                  onClick={onExpand}
                  className="ml-auto text-caption text-faint hover:text-accent"
                >
                  details →
                </button>
              )}
            </div>

            {/* paste-a-URL — one field, because the URL already says which
                platform it is; a dropdown would only add a way to disagree */}
            {adding && (
              <div className="mt-2 flex gap-1.5">
                <input
                  autoFocus
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void add();
                    if (e.key === 'Escape') setAdding(false);
                  }}
                  placeholder="https://instagram.com/yourbrand"
                  className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-2 py-1 text-caption text-text outline-none placeholder:text-faint focus:border-accent-dim"
                />
                <Button type="button" variant="soft" size="sm" onClick={add} disabled={busy || !url.trim()}>
                  Save
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
