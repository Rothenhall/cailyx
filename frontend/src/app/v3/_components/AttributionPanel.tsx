'use client';

/**
 * AttributionPanel — /v3. The Attribution agent's detail view.
 *
 * This is the one number analytics cannot produce. AI referrals mostly arrive
 * as Direct, and agentic browsers present as ordinary Chrome at the HTTP layer,
 * so no amount of log parsing recovers them. Asking the buyer does.
 *
 * Two states on one surface: with responses it shows the AI share, the split by
 * source and the prompts buyers reported; with none it shows the install
 * snippet, because an empty panel here means the form isn't on the site yet.
 *
 * @module app/v3/_components/AttributionPanel
 */

import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { getAttributionSummary, type AttributionSummary } from '@/lib/terminal-api';
import { ArrowRight } from './icons';
import { EmptyHint, PanelSkeleton, SectionLabel, StatHeadline } from './panel';
import { Button } from './Button';

/** the closed set the capture endpoint accepts, in the order the form shows */
const SOURCE_LABEL: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  copilot: 'Copilot',
  'other-ai': 'Another AI',
  search: 'Search engine',
  social: 'Social',
  referral: 'Referral',
  other: 'Other',
};
const AI = new Set(['chatgpt', 'claude', 'perplexity', 'gemini', 'copilot', 'other-ai']);

function rel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** the markup an operator drops into their own site */
function snippet(projectId: string): string {
  return `<!-- Cailyx · how did you find us -->
<form id="cailyx-attr">
  <label>How did you find us?
    <select name="source" required>
      <option value="">Choose one…</option>
      <option value="chatgpt">ChatGPT</option>
      <option value="claude">Claude</option>
      <option value="perplexity">Perplexity</option>
      <option value="gemini">Gemini</option>
      <option value="copilot">Copilot</option>
      <option value="other-ai">Another AI assistant</option>
      <option value="search">Search engine</option>
      <option value="social">Social</option>
      <option value="referral">Someone referred me</option>
      <option value="other">Other</option>
    </select>
  </label>
  <label>What did you ask? (optional)
    <input name="prompt" maxlength="400">
  </label>
  <button type="submit">Send</button>
</form>
<script>
document.getElementById('cailyx-attr').addEventListener('submit', function (e) {
  e.preventDefault();
  var f = new FormData(e.target);
  fetch('${API_URL}/api/public/attribution/${projectId}', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: f.get('source'),
      prompt: f.get('prompt') || undefined,
      page: location.pathname
    })
  });
  e.target.innerHTML = '<p>Thanks — that genuinely helps.</p>';
});
<\/script>`;
}

export function AttributionPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<AttributionSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSnippet, setShowSnippet] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    getAttributionSummary(projectId)
      .then(setData)
      .catch(() => setFailed(true));
  }, [projectId]);

  useEffect(load, [load]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet(projectId));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (failed) {
    return <p className="text-body text-faint">Could not load responses.</p>;
  }
  if (!data) return <PanelSkeleton />;

  const empty = data.total === 0;
  const pct = Math.round(data.aiShare * 100);

  return (
    <div className="flex flex-col gap-3.5">
      {empty ? (
        <EmptyHint>
          No responses yet. Inferred analytics can&rsquo;t see AI referrals — they arrive as
          Direct, and agentic browsers look like ordinary Chrome. Asking is the only signal that
          survives.
        </EmptyHint>
      ) : (
        <>
          {/* the headline figure — this is the point of the panel */}
          <StatHeadline
            value={`${pct}%`}
            label={`of ${data.total} said an AI assistant sent them`}
            note={`${data.aiTotal} AI-sourced · first ${rel(data.firstAt)} · latest ${rel(data.lastAt)}`}
          />

          {/* split by source — ranked, AI sources marked */}
          <div>
            <SectionLabel>By source</SectionLabel>
            <ul className="space-y-1.5">
              {data.bySource.map((s) => {
                const isAi = AI.has(s.source);
                return (
                  <li key={s.source} className="flex items-center gap-2 text-body">
                    <span className={`w-20 shrink-0 truncate ${isAi ? 'font-semibold text-accent' : 'text-dim'}`}>
                      {SOURCE_LABEL[s.source] ?? s.source}
                    </span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                      <span
                        className={`block h-full rounded-full transition-[width] duration-morph ease-brand ${
                          isAi ? 'bg-accent' : 'bg-accent-dim/65'
                        }`}
                        style={{ width: `${Math.round(s.share * 100)}%` }}
                      />
                    </span>
                    <span className="num w-6 shrink-0 text-right text-faint">{s.count}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* the prompts — the most actionable thing on this panel */}
          {data.prompts.length > 0 && (
            <div>
<SectionLabel>Prompts they reported using</SectionLabel>
              <ul className="space-y-1.5">
                {data.prompts.slice(0, 6).map((p, i) => (
                  <li
                    key={i}
                    className="rounded-r2 border border-border/60 px-2.5 py-2 transition-colors duration-micro hover:border-border-strong"
                  >
                    <p className="text-body font-medium leading-snug text-text">
                      &ldquo;{p.prompt}&rdquo;
                    </p>
                    <p className="mt-0.5 text-eyebrow uppercase text-faint">
                      {SOURCE_LABEL[p.source] ?? p.source}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {/* install — primary when empty, tucked away once data is flowing */}
      <div>
        <Button
          type="button"
          variant={empty ? 'primary' : 'outline'}
          size="lg"
          onClick={() => setShowSnippet((v) => !v)}
        >
          {showSnippet ? 'Hide the form' : empty ? 'Get the form' : 'Form snippet'}
          {!showSnippet && <ArrowRight className="h-3 w-3" />}
        </Button>

        {showSnippet && (
          <div className="mt-2">
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-caption text-faint">Paste into any page. No key needed.</p>
              <Button
                type="button"
                variant="soft"
                size="sm"
                onClick={copy}
                className="h-auto rounded-r1 px-2 py-0.5 text-eyebrow uppercase"
              >
                {copied ? 'copied' : 'copy'}
              </Button>
            </div>
            <pre className="no-scrollbar max-h-52 overflow-auto rounded-r2 border border-border bg-bg-inset p-2.5 text-[10px] leading-relaxed text-dim">
              {snippet(projectId)}
            </pre>
            <p className="mt-1.5 text-caption leading-relaxed text-faint">
              Posts to a public endpoint that stores no IP address and never confirms whether a
              project exists.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
