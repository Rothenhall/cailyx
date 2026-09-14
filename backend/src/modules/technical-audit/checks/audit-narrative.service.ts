/**
 * Audit narrative — the textual layer over the numbers, via OpenRouter.
 *
 * Deterministic checks say *what* a number is. They cannot say whether a drop
 * from 78 to 71 is the CDN change someone shipped last week finally landing,
 * or noise. That reading is what this produces.
 *
 * Three things it is given, and the third is the point:
 *
 *   1. the current run's metrics,
 *   2. the previous run's metrics and the computed deltas,
 *   3. **the previous run's own narrative.**
 *
 * (3) makes the commentary cumulative rather than amnesiac: run N reads what
 * run N-1 concluded, so it can say "the JSON-LD gap called out last run is now
 * closed" instead of re-describing the site from scratch every time. Each run
 * stores its narrative, which becomes the next run's memory.
 *
 * The cost of (3) is that a mistake compounds: an early run asserted "the
 * sitemap lacks lastmod tags" for a sitemap where all 12 URLs carried one, and
 * the next run repeated it as established fact. Two defences, both below:
 * `keyFacts` states the handful of easily-misread facts in plain English so
 * the model never has to derive them, and the prompt frames the previous
 * narrative as unverified prose that must be re-checked against the data.
 *
 * Hard rule, matching page-analysis: **this never feeds the score.** The
 * composite is computed from the deterministic checks before this is called,
 * and a model outage degrades the narrative to null while leaving every number
 * intact. Prose is commentary on the measurement, never part of it.
 *
 * @module technical-audit/checks/audit-narrative
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuditDelta, AuditFinding, PageInventoryAnalysis } from '../technical-audit.types';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * 2026-09-13: operator's explicit "use deepseek/deepseek-v4.1-flash for
 * everything that needs an LLM, from OpenRouter" — same as
 * `common/llm/llm.service.ts`'s shared default. Still cheap at this
 * module's scale (a few thousand tokens of compact JSON in, ~700 out — a
 * fraction of a cent) even though its $/Mtok is somewhat higher than the
 * gemini-2.5-flash-lite default this replaces; this fires on every
 * scheduled audit, so worth re-checking if per-run LLM cost ever matters
 * enough to tune independently via `OPENROUTER_MODEL`.
 */
const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash';

/** What the narrator is told about a run. Numbers only — no raw HTML. */
export interface NarrativeInput {
  domain: string;
  targetUrl: string;
  currentScore: number | null;
  previousScore: number | null;
  currentAt: string;
  previousAt: string | null;
  deltas: AuditDelta[];
  findings: Array<Pick<AuditFinding, 'type' | 'status' | 'severity' | 'recommendedFix'>>;
  inventory: PageInventoryAnalysis | null;
  /**
   * Raw check details, keyed by check type. Without these the model infers
   * facts it was never given — an early run confidently reported "the sitemap
   * lacks lastmod tags" when the sitemap had them on every URL, because it
   * only saw the derived staleness number.
   */
  details: Record<string, unknown>;
  /** The previous run's narrative — the rolling memory. */
  previousNarrative: string | null;
}

export interface NarrativeResult {
  text: string;
  model: string;
  /** USD OpenRouter billed for this call, when it reports it. */
  costUsd: number;
}

@Injectable()
export class AuditNarrativeService {
  private readonly logger = new Logger(AuditNarrativeService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>('OPENROUTER_API_KEY', '') ?? '';
  }

  private get model(): string {
    return this.config.get<string>('OPENROUTER_MODEL', DEFAULT_MODEL) ?? DEFAULT_MODEL;
  }

  private get enabled(): boolean {
    return !!this.apiKey && this.config.get<string>('AUDIT_NARRATIVE', 'true') !== 'false';
  }

  /**
   * Write the run's commentary. Returns null — never throws — when the key is
   * absent, the model is unreachable, or the response is unusable.
   */
  async write(input: NarrativeInput): Promise<NarrativeResult | null> {
    if (!this.enabled) {
      this.logger.debug('Narrative skipped: no OPENROUTER_API_KEY or explicitly disabled');
      return null;
    }

    const model = this.model;
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // OpenRouter attribution headers — optional, but they keep this
          // app's usage identifiable on the dashboard.
          'HTTP-Referer': this.config.get<string>('PUBLIC_APP_URL', 'https://cailyx.local') ?? '',
          'X-Title': 'Cailyx Technical Audit',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2, // low: this is analysis, not copywriting
          max_tokens: 700,
          usage: { include: true }, // ask OpenRouter to bill-report the call

          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: this.buildPrompt(input) },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        this.logger.warn(`Narrative failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number; cost?: number };
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) {
        this.logger.warn('Narrative failed: model returned no content');
        return null;
      }

      const costUsd = typeof data.usage?.cost === 'number' ? data.usage.cost : 0;
      this.logger.log(
        `Narrative written by ${model} (${data.usage?.total_tokens ?? '?'} tokens, $${costUsd.toFixed(5)})`,
      );
      return { text, model, costUsd };
    } catch (err) {
      this.logger.warn(`Narrative failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Plain-English statements of the facts models most often get wrong here,
   * computed from the data rather than left to be inferred.
   *
   * This exists because a derived number invites a wrong inference: given only
   * "days since sitemap last changed: 7", a model concluded the sitemap had no
   * <lastmod> tags at all — when in fact every URL had one, which is the only
   * reason that number could be computed. Stating it outright is cheaper and
   * more reliable than any amount of prompt discipline.
   */
  private keyFacts(i: NarrativeInput): string[] {
    const facts: string[] = [];
    const sm = i.details.sitemap as Record<string, unknown> | undefined;

    if (sm && typeof sm.found === 'boolean') {
      if (!sm.found) {
        facts.push('No sitemap was found for this site.');
      } else {
        const total = Number(sm.urlCount ?? 0);
        const dated = Number(sm.withLastmod ?? 0);
        facts.push(
          dated === 0
            ? `The sitemap lists ${total} URLs and NONE of them declare a <lastmod> date.`
            : dated === total
              ? `The sitemap lists ${total} URLs and ALL ${total} of them declare a <lastmod> date. Do NOT claim lastmod tags are missing.`
              : `The sitemap lists ${total} URLs, of which ${dated} declare a <lastmod> date and ${total - dated} do not.`,
        );
        if (sm.staleDays !== null && sm.staleDays !== undefined) {
          facts.push(`The most recent <lastmod> in the sitemap is ${sm.staleDays} days old.`);
        }
        facts.push(
          sm.declaredInRobots
            ? 'The sitemap IS declared in robots.txt.'
            : 'The sitemap is NOT declared in robots.txt.',
        );
      }
    }

    const cwv = i.details.cwv as Record<string, unknown> | undefined;
    if (cwv) {
      // -1 is the adapter's "Lighthouse could not measure this" sentinel. Left
      // unexplained, it gets reported as a real value of negative one.
      for (const [key, label] of [['lcp', 'LCP'], ['inp', 'INP']] as const) {
        if (cwv[key] === -1) {
          facts.push(`${label} was NOT measured this run (no value available) — do not report it as a number.`);
        }
      }
    }

    const ar = i.details['agent-readiness'] as Record<string, unknown> | undefined;
    if (ar && (ar.score === null || ar.score === undefined)) {
      facts.push(`Agent readiness was not scored this run: ${String(ar.error ?? 'unknown reason')}.`);
    }

    if (i.inventory) {
      facts.push(
        `${i.inventory.crawled} of ${i.inventory.discovered} sitemap URLs were crawled and scored this run.`,
      );
    }

    return facts;
  }

  /**
   * Compact the run into JSON rather than prose. The model reads structure far
   * more reliably than a paragraph, and it keeps the token count — and so the
   * per-run cost — bounded regardless of how many findings there are.
   */
  private buildPrompt(i: NarrativeInput): string {
    const moved = i.deltas.filter((d) => d.direction === 'improved' || d.direction === 'regressed');

    const payload = {
      // Stated outright so they are never inferred. See keyFacts().
      establishedFacts: this.keyFacts(i),
      site: i.domain,
      url: i.targetUrl,
      run: { at: i.currentAt, score: i.currentScore },
      previousRun: i.previousAt ? { at: i.previousAt, score: i.previousScore } : null,
      whatMoved: moved.map((d) => ({
        metric: d.label,
        from: d.previous,
        to: d.current,
        change: d.change,
        direction: d.direction,
        higherIsBetter: d.higherIsBetter,
      })),
      unchangedOrNew: i.deltas
        .filter((d) => d.direction === 'unchanged' || d.direction === 'new')
        .map((d) => ({ metric: d.label, value: d.current, status: d.direction })),
      checks: i.findings.map((f) => ({
        check: f.type,
        status: f.status,
        severity: f.severity,
        // Truncated: the fix text is often several hundred words and the model
        // only needs the gist to reason about priority.
        guidance: f.recommendedFix.slice(0, 400),
      })),
      // Verbatim detail for the checks whose numbers are easy to misread.
      sitemap: i.details.sitemap ?? null,
      coreWebVitals: i.details.cwv ?? null,
      agentReadiness: i.details['agent-readiness'] ?? null,
      pageInventory: i.inventory
        ? {
            crawled: i.inventory.crawled,
            discovered: i.inventory.discovered,
            averageScore: i.inventory.averageScore,
            topIssues: Object.entries(i.inventory.issueCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6),
            worstPages: i.inventory.worstPages.slice(0, 5),
          }
        : null,
    };

    return [
      i.previousNarrative
        ? 'Below is your own commentary on the PREVIOUS run. It is prose you wrote, NOT measured data, and it may contain mistakes. ' +
          'Use it for continuity — say whether what you flagged was acted on — but re-check every factual claim in it against the audit data further down. ' +
          'If the data contradicts something you said last time, correct it explicitly rather than repeating it.\n' +
          `<previous_analysis_unverified>\n${i.previousNarrative}\n</previous_analysis_unverified>`
        : 'This is the first audit for this site — there is no previous analysis. Establish the baseline.',
      '',
      'Audit data for the current run:',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }
}

const SYSTEM_PROMPT = `You are the analyst on a technical SEO and AI-visibility audit tool. You write the short standing commentary an operator reads before a client call.

You are given one site's current audit run, the previous run, what moved between them, and your own analysis of the previous run.

Write plain prose in exactly these four sections, using these headings:

## Verdict
One or two sentences. Is this site getting better or worse, and is the current state acceptable? Lead with the direction of travel, not the raw score.

## What changed
Only metrics that actually moved. For each, say what moved and what plausibly caused it. If your previous analysis flagged something and it is now fixed, say so explicitly. If you flagged it and nothing happened, say that too — that is the most useful sentence in the report.

## What matters now
The two or three highest-leverage fixes, ordered. Justify the order by impact on whether an AI assistant can find, read and cite the site — not by how easy the fix is.

## Watch next run
One or two specific, checkable things to look at next time.

Rules:
- Be concrete and quantitative. "LCP rose 1.2s to 4.1s, now in the poor band" beats "performance declined".
- Never invent a number that is not in the data. If something was not measured, say it was not measured.
- \`establishedFacts\` is authoritative and already verified. Never contradict it, and never restate one of its facts in negated form.
- Your previous analysis is unverified prose, not data. Where it disagrees with the current data, the data wins and you must say so.
- Do not infer a fact from a derived number. Read the underlying field.
- Do not restate every metric. The operator can read the table; they need the reading.
- No preamble, no sign-off, no bullet-point padding. Under 350 words.
- If this is the first run, say so, describe the baseline, and skip comparisons rather than inventing them.`;
