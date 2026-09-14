'use client';

/**
 * AEO audit report — the panel widgets.
 *
 * Sibling of the SEO and Technical audit reports, but the subject is answer
 * engines rather than Google. Where SEO asks "do we rank", this asks "when a
 * buyer asks ChatGPT, Perplexity or Gemini the things they actually ask, does
 * the engine name us — and when it names a rival too, who does it put first?"
 *
 *   Overview    visibility gauge · branded vs unbranded · engine comparison · headlines
 *   Engines     one card per answer engine, including the ones that failed and why
 *   Categories  the ten buyer intents, ranked worst-first — this is the gap map
 *   Rivals      who gets named instead of you, and where they beat you
 *   Prompts     the actual questions, with the verbatim answer quotes
 *
 * ## The one rule this file must not break
 *
 * `counted` and `judged` are never shown as the same kind of number. Counted
 * values (mention rate, citation rate, share of voice) come from deterministic
 * extraction over n>=5 repeats and can be quoted to a client. Judged values
 * (stance) are an LLM reading the same answers — they carry an evidence quote
 * and are always labelled as a read, not a measurement. Every judged block in
 * here is visually marked.
 *
 * @module app/v3/_components/AeoAuditReport
 */

import { useMemo, useState } from 'react';
import type {
  AeoCompetitorStanding,
  AeoDimensionResult,
  AeoMatrix,
  AeoStance,
  AeoSurfaceComparison,
  AeoSurfaceRun,
  AeoVerdict,
  MarketResult,
} from '@/types/terminal';
import { tone as toneOf, type ToneKind } from '@/app/v3/_lib/audit';
import { Gauge, Pill } from './TechnicalAuditReport';
import { SectionLabel } from './panel';

/* ════════════════════════════════════════════════════════════════════════
   primitives
   ════════════════════════════════════════════════════════════════════════ */

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="no-scrollbar h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex max-w-[980px] flex-col gap-4 p-5">{children}</div>
    </div>
  );
}

function Card({ title, right, children }: { title?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-r4 border border-border/70 bg-bg-raised p-4">
      {title && <SectionLabel right={right}>{title}</SectionLabel>}
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] leading-relaxed text-faint">{children}</p>;
}

/**
 * Marks a block as LLM judgement rather than measurement. Used everywhere a
 * stance appears, so a reader never mistakes an opinion for a rate.
 */
function JudgedTag({ model }: { model?: string }) {
  return (
    <span
      className="rounded-full border border-border px-1.5 py-0.5 text-eyebrow uppercase tracking-wide2 text-faint"
      title={
        'Read by a language model from the answer text, not counted. Every call carries a verbatim quote ' +
        'so you can check it.' + (model ? ` Model: ${model}` : '')
      }
    >
      judged
    </span>
  );
}

/** Marks a block as deterministic counting over n>=5 repeats. */
function CountedTag({ n }: { n: number }) {
  return (
    <span
      className="rounded-full border border-border px-1.5 py-0.5 text-eyebrow uppercase tracking-wide2 text-faint"
      title={`Counted from ${n} recorded answers, ${'n≥5'} repeats per prompt. Safe to quote.`}
    >
      counted
    </span>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pct0 = (n: number) => `${Math.round(n * 100)}%`;

/** Visibility is a rate; the gauge wants 0-100. */
const rateScore = (rate: number) => Math.round(rate * 100);

/** Worse visibility reads "bad" — inverted from the usual score semantics. */
function rateKind(rate: number): ToneKind {
  if (rate >= 0.4) return 'ok';
  if (rate >= 0.15) return 'warn';
  if (rate > 0) return 'bad';
  return 'bad';
}

/** Colour + copy for one stance value. */
const STANCE_META: Record<AeoStance, { label: string; kind: ToneKind }> = {
  'recommended-primary': { label: 'Led the answer', kind: 'ok' },
  'recommended-alternative': { label: 'Named as an option', kind: 'ok' },
  'mentioned-neutral': { label: 'Named, neutral', kind: 'warn' },
  'mentioned-negative': { label: 'Named with a caveat', kind: 'bad' },
  absent: { label: 'Not named', kind: 'bad' },
};

const STANCE_ORDER: AeoStance[] = [
  'recommended-primary',
  'recommended-alternative',
  'mentioned-neutral',
  'mentioned-negative',
  'absent',
];

/** Human copy for an adapter failure reason. */
const FAILURE_COPY: Record<string, string> = {
  'surface-disabled': 'Browser surfaces are switched off (AEO_ALLOW_BROWSER_SURFACE).',
  'no-session': 'No saved sign-in for this engine.',
  'session-expired': 'The saved sign-in has expired — sign in again and re-export it.',
  challenged: 'The engine showed a human-verification challenge. The run stops there by design.',
  'rate-limited': 'The engine rate-limited the session. Try a smaller tier or a longer gap.',
  blocked: 'The engine blocked the session.',
  'selector-drift': 'The engine changed its interface — the adapter needs updating.',
  timeout: 'The engine did not answer in time.',
  unknown: 'The engine produced no answers.',
};

/** A horizontal proportion bar — used for stance spread and share of voice. */
function StackBar({ parts }: { parts: Array<{ value: number; kind: ToneKind; label: string }> }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total === 0) return <div className="h-2 rounded-full bg-bg-inset" />;
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-bg-inset">
      {parts
        .filter((p) => p.value > 0)
        .map((p, i) => (
          <div
            key={i}
            title={`${p.label}: ${p.value}`}
            style={{ width: `${(p.value / total) * 100}%` }}
            className={
              p.kind === 'ok'
                ? 'bg-a-ok'
                : p.kind === 'warn'
                  ? 'bg-a-warn'
                  : p.kind === 'bad'
                    ? 'bg-a-bad'
                    : 'bg-faint/40'
            }
          />
        ))}
    </div>
  );
}

/** A single labelled meter, 0-100%. */
function RateBar({ rate, kind }: { rate: number; kind?: ToneKind }) {
  const t = toneOf(kind ?? rateKind(rate));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-inset">
      <div
        style={{ width: `${Math.max(rate * 100, rate > 0 ? 2 : 0)}%` }}
        className={t.kind === 'ok' ? 'h-full bg-a-ok' : t.kind === 'warn' ? 'h-full bg-a-warn' : 'h-full bg-a-bad'}
      />
    </div>
  );
}

function stanceParts(counts: Record<AeoStance, number>) {
  return STANCE_ORDER.map((s) => ({
    value: counts?.[s] ?? 0,
    kind: STANCE_META[s].kind,
    label: STANCE_META[s].label,
  }));
}

/* ════════════════════════════════════════════════════════════════════════
   Overview
   ════════════════════════════════════════════════════════════════════════ */

export function AeoOverview({ verdict, context }: { verdict: AeoVerdict; context?: { brand: string } | null }) {
  const c = verdict.counted;
  const measured = c.bySurface.filter((s) => s.status === 'completed' && s.observations > 0);
  const failed = verdict.surfaceRuns.filter((s) => s.status === 'failed');

  const stat = (label: string, value: string, hint: string) => (
    <div className="rounded-r3 border border-border/60 bg-bg-inset/40 px-3 py-2.5" title={hint}>
      <p className="text-eyebrow uppercase tracking-eyebrow text-faint">{label}</p>
      <p className="num mt-0.5 font-display text-display font-semibold tabular-nums text-text">{value}</p>
    </div>
  );

  return (
    <Panel>
      {/* headline gauge — unbranded is the honest number, so that is what it shows */}
      <div className={`rounded-r4 border bg-bg-raised p-5 ${toneOf(rateKind(c.unbranded.mentionRate)).line}`}>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <Gauge value={rateScore(c.unbranded.mentionRate)} size={120} sub="unbranded" />
          <div className="min-w-[200px] flex-1">
            <p className={`font-display text-display font-semibold ${toneOf(rateKind(c.unbranded.mentionRate)).text}`}>
              {c.unbranded.mentionRate === 0
                ? 'Invisible'
                : c.unbranded.mentionRate < 0.15
                  ? 'Rarely named'
                  : c.unbranded.mentionRate < 0.4
                    ? 'Sometimes named'
                    : 'Regularly named'}
            </p>
            <p className="mt-1 text-caption leading-relaxed text-faint">
              {context?.brand ?? 'The client'} was named in{' '}
              <span className="tabular-nums text-dim">{pct(c.unbranded.mentionRate)}</span> of{' '}
              <span className="tabular-nums text-dim">{c.unbranded.observations}</span> answers to prompts that never
              mention the brand — across {measured.length || 1} engine
              {measured.length === 1 ? '' : 's'}, n={verdict.runCount} per prompt.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <CountedTag n={c.overall.observations} />
              {measured.map((s) => (
                <Pill key={s.surface} t={toneOf(rateKind(s.unbrandedMentionRate))}>
                  {s.label} {pct0(s.unbrandedMentionRate)}
                </Pill>
              ))}
              {failed.map((s) => (
                <Pill key={s.surface} t={toneOf('neutral')}>
                  {s.label} not measured
                </Pill>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* branded vs unbranded — never averaged together */}
      <Card
        title="Branded vs unbranded"
        right={<CountedTag n={c.overall.observations} />}
      >
        <p className="mb-3 text-[13px] leading-relaxed text-faint">
          Unbranded prompts are the real test — they never mention the brand, so being named means the engine chose
          you. Branded prompts only prove the engine knows the name once you hand it over. These are reported
          separately and never averaged.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { k: 'Unbranded', m: c.unbranded, note: 'the visibility number that matters' },
            { k: 'Branded', m: c.branded, note: 'recognition, not discovery' },
          ].map(({ k, m, note }) => (
            <div key={k} className="rounded-r3 border border-border/60 bg-bg-inset/40 p-3">
              <div className="flex items-baseline justify-between">
                <p className="text-eyebrow uppercase tracking-eyebrow text-faint">{k}</p>
                <p className="num font-display text-ui font-semibold tabular-nums text-text">{pct(m.mentionRate)}</p>
              </div>
              <div className="mt-2">
                <RateBar rate={m.mentionRate} />
              </div>
              <p className="mt-1.5 text-caption text-faint">
                {m.prompts} prompts · {m.observations} answers · {note}
              </p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat('Answers', String(c.overall.observations), 'Total recorded answers across every engine measured.')}
        {stat('Prompts', String(c.overall.prompts), 'Distinct buyer questions in the matrix.')}
        {stat('Mention rate', pct(c.overall.mentionRate), 'All prompts, branded and unbranded together.')}
        {stat('Citation rate', pct(c.overall.citationRate), 'Answers that linked to the client’s own domain.')}
      </div>

      {measured.length > 1 && <EngineCompare rows={c.bySurface} />}

      <Card title="What this says" right={<span className="text-eyebrow uppercase tracking-eyebrow text-faint">plain language</span>}>
        <ul className="flex flex-col gap-1.5">
          {verdict.headlines.map((h, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-dim">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint/60" />
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Panel>
  );
}

/** The engine-by-engine bar chart. The whole point of measuring more than one. */
function EngineCompare({ rows }: { rows: AeoSurfaceComparison[] }) {
  const live = rows.filter((r) => r.status === 'completed' && r.observations > 0);
  const spread =
    live.length > 1
      ? Math.max(...live.map((r) => r.unbrandedMentionRate)) - Math.min(...live.map((r) => r.unbrandedMentionRate))
      : 0;

  return (
    <Card title="Engine by engine" right={<CountedTag n={live.reduce((a, r) => a + r.observations, 0)} />}>
      <p className="mb-3 text-[13px] leading-relaxed text-faint">
        The same prompts, asked of each engine. {spread >= 0.05
          ? 'The spread below is a finding in itself — being strong on one engine and absent on another is a different problem from being weak everywhere.'
          : 'A narrow spread means the gap is in your content, not in one engine’s quirks.'}
      </p>
      <div className="flex flex-col gap-2.5">
        {rows.map((r) => (
          <div key={r.surface} className="rounded-r3 border border-border/60 bg-bg-inset/40 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-ui font-semibold text-text">{r.label}</span>
              {r.status === 'completed' && r.observations > 0 ? (
                <span className="num font-display text-ui font-semibold tabular-nums text-text">
                  {pct(r.unbrandedMentionRate)}
                  <span className="ml-1 text-caption font-normal text-faint">unbranded</span>
                </span>
              ) : (
                <Pill t={toneOf('neutral')}>not measured</Pill>
              )}
            </div>
            {r.status === 'completed' && r.observations > 0 ? (
              <>
                <div className="mt-2">
                  <RateBar rate={r.unbrandedMentionRate} />
                </div>
                <p className="mt-1.5 text-caption text-faint">
                  {r.observations} answers · {pct(r.mentionRate)} overall · {pct(r.citationRate)} cited you
                  {r.rivalsAheadCount > 0 && ` · ${r.rivalsAheadCount} answers named a rival and not you`}
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-caption text-faint">Contributes nothing to the numbers above.</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

/**
 * Per-market roll-up (wave-6 D8) — only rendered as a tab when more than one
 * market was actually measured (a single-market audit's `byMarket` is a
 * one-item array and belongs in Overview, not here).
 */
export function AeoMarkets({ verdict }: { verdict: AeoVerdict }) {
  const rows: MarketResult[] = verdict.counted.byMarket ?? [];

  return (
    <Panel>
      <Card title="Market by market" right={<CountedTag n={rows.reduce((a, r) => a + r.observations, 0)} />}>
        <p className="mb-3 text-[13px] leading-relaxed text-faint">
          The same prompts, asked with each market steered where the surface supports it. A gap here is
          a different problem from an overall weak rate — it means the answer changes depending on where the buyer is asking from.
        </p>
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <div key={r.market} className="rounded-r3 border border-border/60 bg-bg-inset/40 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-ui font-semibold text-text">{r.market}</span>
                <span className="num font-display text-ui font-semibold tabular-nums text-text">
                  {pct(r.mentionRate)}
                  <span className="ml-1 text-caption font-normal text-faint">mentioned</span>
                </span>
              </div>
              <div className="mt-2">
                <RateBar rate={r.mentionRate} />
              </div>
              <p className="mt-1.5 text-caption text-faint">
                {r.observations} answers · {r.prompts} prompts · {pct(r.citationRate)} cited you
              </p>
            </div>
          ))}
        </div>
      </Card>
    </Panel>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Engines
   ════════════════════════════════════════════════════════════════════════ */

export function AeoEngines({ verdict }: { verdict: AeoVerdict }) {
  const bySurface = new Map(verdict.counted.bySurface.map((s) => [s.surface, s]));

  return (
    <Panel>
      <Card title="Answer engines measured">
        <p className="text-[13px] leading-relaxed text-faint">
          Each engine is driven as a real user would — the consumer product, signed in, one fresh conversation per
          prompt. An engine that fails is reported here with its reason and contributes nothing to the numbers;
          it never silently drags an average down.
        </p>
      </Card>

      {verdict.surfaceRuns.map((run) => (
        <EngineCard key={run.surface} run={run} cmp={bySurface.get(run.surface)} judgeModel={verdict.judged.judgeModel} />
      ))}
    </Panel>
  );
}

function EngineCard({
  run,
  cmp,
  judgeModel,
}: {
  run: AeoSurfaceRun;
  cmp?: AeoSurfaceComparison;
  judgeModel?: string;
}) {
  const ok = run.status === 'completed' && run.observations > 0;
  const t = ok ? toneOf(rateKind(cmp?.unbrandedMentionRate ?? 0)) : toneOf('neutral');

  return (
    <div className={`rounded-r4 border bg-bg-raised p-4 ${t.line}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-ui font-semibold text-text">{run.label}</span>
        <Pill t={ok ? toneOf('ok') : toneOf('bad')}>{run.status}</Pill>
        {run.observations > 0 && <span className="text-caption text-faint">{run.observations} answers</span>}
        {run.costUsd > 0 && <span className="text-caption text-faint">${run.costUsd.toFixed(4)}</span>}
      </div>

      {ok && cmp ? (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {[
              { k: 'Unbranded', v: pct(cmp.unbrandedMentionRate) },
              { k: 'All prompts', v: pct(cmp.mentionRate) },
              { k: 'Cited you', v: pct(cmp.citationRate) },
            ].map(({ k, v }) => (
              <div key={k} className="rounded-r3 border border-border/60 bg-bg-inset/40 px-3 py-2">
                <p className="text-eyebrow uppercase tracking-eyebrow text-faint">{k}</p>
                <p className="num mt-0.5 font-display text-ui font-semibold tabular-nums text-text">{v}</p>
              </div>
            ))}
          </div>

          {run.stanceJudged > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="text-eyebrow uppercase tracking-eyebrow text-faint">How it positioned you</span>
                <JudgedTag model={judgeModel} />
              </div>
              <StackBar parts={stanceParts(cmp.stanceCounts)} />
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                {STANCE_ORDER.filter((s) => (cmp.stanceCounts?.[s] ?? 0) > 0).map((s) => (
                  <span key={s} className="text-caption text-faint">
                    <span className={toneOf(STANCE_META[s].kind).text}>{'●'}</span> {STANCE_META[s].label}{' '}
                    <span className="tabular-nums text-dim">{cmp.stanceCounts[s]}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="mt-3 rounded-r3 border border-border/60 bg-bg-inset/40 p-3">
          <p className="text-[13px] font-medium text-dim">
            {FAILURE_COPY[run.failureKind ?? 'unknown'] ?? 'This engine produced no answers.'}
          </p>
          {run.error && <p className="mt-1 break-words text-caption leading-relaxed text-faint">{run.error}</p>}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Categories — the gap map
   ════════════════════════════════════════════════════════════════════════ */

export function AeoCategories({ verdict, matrix }: { verdict: AeoVerdict; matrix?: AeoMatrix | null }) {
  const rows = useMemo(
    () => [...verdict.counted.byDimension].sort((a, b) => a.mentionRate - b.mentionRate),
    [verdict.counted.byDimension],
  );
  const skipped = matrix?.skipped ?? [];

  return (
    <Panel>
      <Card title="Where you are invisible" right={<CountedTag n={verdict.counted.overall.observations} />}>
        <p className="text-[13px] leading-relaxed text-faint">
          Ten ways a buyer comes at an answer engine, worst first. A low rate on{' '}
          <span className="text-dim">competitor alternatives</span> means people shopping away from a rival never hear
          your name. A low rate on <span className="text-dim">problem framed</span> means you are absent before the
          buyer even knows the category exists.
        </p>
      </Card>

      {rows.map((d) => (
        <CategoryRow key={d.dimension} d={d} judgeModel={verdict.judged.judgeModel} />
      ))}

      {skipped.length > 0 && (
        <Card title="Categories not generated">
          <p className="mb-2 text-[13px] leading-relaxed text-faint">
            These were skipped rather than filled with invented prompts. Each says what was missing.
          </p>
          <ul className="flex flex-col gap-1.5">
            {skipped.map((s) => (
              <li key={s.dimension} className="text-caption leading-relaxed text-faint">
                <span className="text-dim">{s.dimension}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Panel>
  );
}

function CategoryRow({ d, judgeModel }: { d: AeoDimensionResult; judgeModel?: string }) {
  const judged = STANCE_ORDER.reduce((a, s) => a + (d.stanceCounts?.[s] ?? 0), 0);
  return (
    <div className="rounded-r4 border border-border/70 bg-bg-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-ui font-semibold text-text">{d.label}</span>
        <span className="num font-display text-ui font-semibold tabular-nums text-text">{pct(d.mentionRate)}</span>
      </div>
      <div className="mt-2">
        <RateBar rate={d.mentionRate} />
      </div>
      <p className="mt-1.5 text-caption text-faint">
        {d.prompts} prompts · {d.observations} answers · {pct(d.citationRate)} cited you
      </p>
      {judged > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-eyebrow uppercase tracking-eyebrow text-faint">Positioning</span>
            <JudgedTag model={judgeModel} />
          </div>
          <StackBar parts={stanceParts(d.stanceCounts)} />
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Rivals
   ════════════════════════════════════════════════════════════════════════ */

export function AeoRivals({ verdict }: { verdict: AeoVerdict }) {
  const rivals = verdict.counted.competitors;
  const sov = verdict.counted.shareOfVoice;

  return (
    <Panel>
      <Card title="Share of voice" right={<CountedTag n={verdict.counted.overall.observations} />}>
        {sov.length === 0 ? (
          <Empty>No competitors were named in any answer.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {sov.map((s) => (
              <div key={s.name} className="flex items-center gap-3">
                <span className="w-[160px] shrink-0 truncate text-[13px] text-dim" title={s.name}>
                  {s.name}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-inset">
                  <div
                    style={{ width: `${Math.max(s.share * 100, s.share > 0 ? 2 : 0)}%` }}
                    className={s.name.includes('(you)') ? 'h-full bg-a-ok' : 'h-full bg-faint/50'}
                  />
                </div>
                <span className="num w-[52px] shrink-0 text-right text-caption tabular-nums text-faint">
                  {pct0(s.share)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Who gets named instead of you" right={<CountedTag n={verdict.counted.overall.observations} />}>
        {rivals.length === 0 ? (
          <Empty>No rival was named in any answer.</Empty>
        ) : (
          <div className="no-scrollbar overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-border/70 text-left">
                  <th className="pb-2 pr-3 text-eyebrow uppercase tracking-eyebrow text-faint">Rival</th>
                  <th className="pb-2 pr-3 text-right text-eyebrow uppercase tracking-eyebrow text-faint">Named in</th>
                  <th className="pb-2 pr-3 text-right text-eyebrow uppercase tracking-eyebrow text-faint">
                    Won while you were absent
                  </th>
                  <th className="pb-2 pr-3 text-right text-eyebrow uppercase tracking-eyebrow text-faint">
                    You ahead
                  </th>
                  <th className="pb-2 text-right text-eyebrow uppercase tracking-eyebrow text-faint">You behind</th>
                </tr>
              </thead>
              <tbody>
                {rivals.map((r) => (
                  <RivalRow key={r.name} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-caption leading-relaxed text-faint">
          &ldquo;Named in&rdquo; and &ldquo;won while you were absent&rdquo; are counted. &ldquo;You ahead / behind&rdquo;
          are read from the answer text by a language model and carry a quote — see the Prompts tab.
        </p>
      </Card>
    </Panel>
  );
}

function RivalRow({ r }: { r: AeoCompetitorStanding }) {
  return (
    <tr className="border-b border-border/40 last:border-0">
      <td className="py-2 pr-3 text-dim">{r.name}</td>
      <td className="py-2 pr-3 text-right tabular-nums text-dim">
        {pct(r.mentionRate)}
        <span className="ml-1 text-faint">({r.observations})</span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">
        <span className={r.wonWhileClientAbsent > 0 ? toneOf('bad').text : 'text-faint'}>
          {r.wonWhileClientAbsent}
        </span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-faint">{r.clientAheadCount}</td>
      <td className="py-2 text-right tabular-nums">
        <span className={r.clientBehindCount > 0 ? toneOf('warn').text : 'text-faint'}>{r.clientBehindCount}</span>
      </td>
    </tr>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Prompts — the evidence
   ════════════════════════════════════════════════════════════════════════ */

export function AeoPrompts({ verdict, matrix }: { verdict: AeoVerdict; matrix?: AeoMatrix | null }) {
  const [view, setView] = useState<'losing' | 'winning' | 'all'>('losing');
  const j = verdict.judged;

  if (!j.available) {
    return (
      <Panel>
        <Card title="Positioning not judged">
          <p className="text-[13px] leading-relaxed text-faint">{j.unavailableReason ?? 'The stance pass has not run.'}</p>
          <p className="mt-2 text-[13px] leading-relaxed text-faint">
            The counted numbers on the other tabs are unaffected — they never depended on a language model.
          </p>
        </Card>
        {matrix && <MatrixList matrix={matrix} />}
      </Panel>
    );
  }

  const rows = view === 'losing' ? j.losingPrompts : view === 'winning' ? j.winningPrompts : [];

  return (
    <Panel>
      <Card
        title="Evidence"
        right={<JudgedTag model={j.judgeModel} />}
      >
        <p className="mb-3 text-[13px] leading-relaxed text-faint">
          Every call below is a language model reading the answer, with the sentence it read. {j.observationsJudged}{' '}
          answers judged. Check the quotes — that is what they are for.
        </p>
        <div className="flex gap-1.5">
          {(
            [
              ['losing', `Losing (${j.losingPrompts.length})`],
              ['winning', `Winning (${j.winningPrompts.length})`],
              ['all', 'All prompts'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`rounded-r2 border px-2 py-1 text-caption ${
                view === id ? 'border-border-strong bg-bg-inset text-text' : 'border-border text-faint hover:text-dim'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </Card>

      {view === 'all' ? (
        matrix ? (
          <MatrixList matrix={matrix} />
        ) : (
          <Card>
            <Empty>The prompt matrix is not loaded.</Empty>
          </Card>
        )
      ) : rows.length === 0 ? (
        <Card>
          <Empty>
            {view === 'losing'
              ? 'No answer placed a named rival above you.'
              : 'No answer led with you or placed you above a named rival.'}
          </Empty>
        </Card>
      ) : (
        rows.map((p, i) => (
          <div key={i} className="rounded-r4 border border-border/70 bg-bg-raised p-4">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[13px] font-medium text-text">{p.prompt}</span>
              {p.dimension && (
                <span className="text-eyebrow uppercase tracking-eyebrow text-faint">{p.dimension}</span>
              )}
            </div>
            {view === 'losing' && p.losesTo && p.losesTo.length > 0 && (
              <p className="mt-1.5 text-caption text-faint">
                Placed above you: <span className={toneOf('bad').text}>{p.losesTo.join(', ')}</span>
              </p>
            )}
            {view === 'winning' && p.recommendedOver && p.recommendedOver.length > 0 && (
              <p className="mt-1.5 text-caption text-faint">
                You were placed above: <span className={toneOf('ok').text}>{p.recommendedOver.join(', ')}</span>
              </p>
            )}
            {p.evidenceQuote && (
              <blockquote className="mt-2 border-l-2 border-border pl-3 text-[13px] italic leading-relaxed text-dim">
                {p.evidenceQuote}
              </blockquote>
            )}
          </div>
        ))
      )}
    </Panel>
  );
}

/** The generated matrix, grouped by category — the curation view. */
function MatrixList({ matrix }: { matrix: AeoMatrix }) {
  const [open, setOpen] = useState<string | null>(matrix.byDimension[0]?.dimension ?? null);

  return (
    <>
      <Card title={`Prompt matrix — ${matrix.promptCount} questions`}>
        <p className="text-[13px] leading-relaxed text-faint">
          Built from what the site actually sells, then {matrix.refined ? 'rewritten to read the way a person types' : 'left in template phrasing'}.
          Every prompt keeps its category, register and target so the set can be curated after you see which cells
          produced signal.
        </p>
      </Card>
      {matrix.byDimension.map((g) => (
        <div key={g.dimension} className="rounded-r4 border border-border/70 bg-bg-raised">
          <button
            type="button"
            onClick={() => setOpen(open === g.dimension ? null : g.dimension)}
            className="flex w-full items-center justify-between gap-3 p-4 text-left"
          >
            <span className="text-ui font-semibold text-text">{g.label}</span>
            <span className="text-caption text-faint">
              {g.count} prompts · {g.unbranded} unbranded
            </span>
          </button>
          {open === g.dimension && (
            <ul className="flex flex-col gap-1.5 border-t border-border/50 p-4 pt-3">
              {g.prompts.map((p) => (
                <li key={p.id} className="text-[13px] leading-relaxed text-dim">
                  <span className="text-faint">{'›'}</span> {p.prompt}
                  {p.meta && (
                    <span className="ml-2 text-caption text-faint">
                      {p.meta.register}
                      {p.meta.competitor ? ` · vs ${p.meta.competitor}` : ''}
                      {p.meta.service ? ` · ${p.meta.service}` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}
