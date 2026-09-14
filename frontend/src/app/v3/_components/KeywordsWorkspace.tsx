'use client';

/**
 * KeywordsWorkspace — /v3. Keyword research, reachable at last.
 *
 * The `keyword-research` module shipped with working endpoints and no route
 * into it from the console, so nobody could run or read it.
 *
 * One honesty rule shapes the whole view: **DataForSEO's Keywords Data returns
 * Google Ads *advertiser* competition, not organic ranking difficulty.** The
 * column is therefore labelled "Ad competition", never "Difficulty" — relabelling
 * it would imply a metric this vendor endpoint does not provide, and an SEO lead
 * would plan against a number that means something else entirely.
 *
 * @module app/v3/_components/KeywordsWorkspace
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@/lib/api';
import { listKeywordSets, runKeywordResearch } from '@/lib/terminal-api';
import type { KeywordSet } from '@/types/terminal';
import { Button } from './Button';
import { ChevronLeft, SyncIcon } from './icons';

/** Competition buckets, as DataForSEO reports them. */
const COMP_TONE: Record<string, string> = {
  LOW: 'text-a-ok',
  MEDIUM: 'text-a-warn',
  HIGH: 'text-danger',
};

export function KeywordsWorkspace({
  projectId,
  onClose,
  onNotify,
}: {
  projectId: string | null;
  onClose: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn') => void;
}) {
  const [sets, setSets] = useState<KeywordSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [seeds, setSeeds] = useState('');
  const [minVolume, setMinVolume] = useState(0);

  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setSets(await listKeywordSets(projectId));
    } catch {
      setSets([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    const list = seeds
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!projectId || list.length === 0 || busy) return;
    setBusy(true);
    try {
      const set = await runKeywordResearch(projectId, list);
      setSeeds('');
      await load();
      if (set.status === 'failed') {
        onNotify(`Research failed: ${set.error ?? 'unknown'}`, 'warn');
      } else {
        onNotify(
          `${set.keywords.length} keywords returned` +
            (set.status === 'partial' ? ' (related-keyword expansion failed)' : ''),
          set.status === 'partial' ? 'warn' : 'ok',
        );
      }
    } catch (e) {
      // The 503 names exactly which credentials are missing — surface it whole.
      onNotify(e instanceof ApiError ? e.message : 'Research failed', 'warn');
    } finally {
      setBusy(false);
    }
  };

  const latest = sets[0] ?? null;
  const rows = (latest?.keywords ?? []).filter((k) => (k.searchVolume ?? 0) >= minVolume);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
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
        <span className="font-display text-ui font-semibold tracking-tight2 text-text">Keywords</span>
        {latest && (
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-eyebrow font-bold uppercase tracking-wide2 text-dim">
            {latest.keywords.length} terms
          </span>
        )}
        {latest && latest.costUsd > 0 && (
          <span className="text-caption tabular-nums text-faint">${latest.costUsd.toFixed(4)}</span>
        )}
        <span className="ml-auto" />
        {rows.length > 0 && (
          <label className="flex items-center gap-1.5 text-caption text-faint">
            min volume
            <input
              type="number"
              min={0}
              step={10}
              value={minVolume}
              onChange={(e) => setMinVolume(Math.max(0, Number(e.target.value) || 0))}
              className="w-20 rounded-r2 border border-border bg-bg-raised px-1.5 py-0.5 text-caption text-text outline-none focus:border-accent-dim"
            />
          </label>
        )}
      </div>

      {/* seeds */}
      <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-2.5">
        <input
          value={seeds}
          onChange={(e) => setSeeds(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run();
          }}
          placeholder="Seed keywords, comma separated — e.g. answer engine optimization, ai visibility platform"
          className="min-w-0 flex-1 rounded-r2 border border-border bg-bg-raised px-2.5 py-1.5 text-caption text-text outline-none placeholder:text-faint focus:border-accent-dim"
        />
        <Button type="button" variant="soft" size="sm" onClick={run} disabled={busy || !seeds.trim()}>
          <SyncIcon className="mr-1.5 h-3.5 w-3.5" />
          {busy ? 'researching…' : 'Research'}
        </Button>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!projectId ? (
          <p className="text-body text-faint">Select a project first.</p>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="v3skel h-8 rounded-r2" />
            ))}
          </div>
        ) : !latest ? (
          <div className="max-w-prose space-y-3">
            <p className="text-body leading-relaxed text-dim">
              No research yet. Enter the terms your client would want to rank for — their services,
              the problems they solve — and this pulls real monthly search volume, cost-per-click and
              advertiser competition for each, plus related and long-tail suggestions.
            </p>
            <p className="text-caption leading-relaxed text-faint">
              Needs DataForSEO credentials. Without them the request returns a 503 naming exactly what
              to configure, and nothing is stored.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {latest.status !== 'completed' && (
              <p className="text-caption leading-relaxed text-a-warn">
                {latest.status === 'partial'
                  ? 'Seed volumes saved, but the related-keyword expansion failed: '
                  : 'This run failed: '}
                {latest.error ?? 'no reason given'}
              </p>
            )}

            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-border text-eyebrow uppercase tracking-eyebrow text-faint">
                  <th className="py-1.5 font-semibold">Keyword</th>
                  <th className="py-1.5 text-right font-semibold">Volume</th>
                  {/* Named for what it is. DataForSEO returns Google Ads
                      advertiser competition — calling it "difficulty" would
                      imply an organic ranking metric this endpoint never
                      provides. */}
                  <th className="py-1.5 text-right font-semibold">Ad competition</th>
                  <th className="py-1.5 text-right font-semibold">CPC</th>
                  <th className="py-1.5 text-right font-semibold">Type</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((k) => (
                  <tr key={k.id} className="border-b border-border/40">
                    <td className="py-1.5 text-body text-text">{k.keyword}</td>
                    <td className="py-1.5 text-right text-body tabular-nums text-dim">
                      {k.searchVolume === null ? '—' : k.searchVolume.toLocaleString()}
                    </td>
                    <td
                      className={`py-1.5 text-right text-caption ${
                        k.competition ? (COMP_TONE[k.competition] ?? 'text-faint') : 'text-faint'
                      }`}
                    >
                      {k.competition ?? '—'}
                      {k.competitionIndex !== null && (
                        <span className="ml-1 text-faint">({k.competitionIndex})</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right text-body tabular-nums text-dim">
                      {k.cpc === null ? '—' : `$${k.cpc.toFixed(2)}`}
                    </td>
                    <td className="py-1.5 text-right text-caption text-faint">
                      {k.isRelated ? (k.isLongTail ? 'long-tail' : 'related') : 'seed'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {rows.length === 0 && (
              <p className="text-body text-faint">
                No keywords at or above {minVolume.toLocaleString()} monthly searches.
              </p>
            )}

            <p className="max-w-prose text-caption leading-relaxed text-faint">
              &ldquo;Ad competition&rdquo; is Google Ads advertiser demand (LOW/MEDIUM/HIGH and a 0-100
              index), not an organic ranking-difficulty score — DataForSEO&rsquo;s Keywords Data does not
              provide one, so none is shown.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
