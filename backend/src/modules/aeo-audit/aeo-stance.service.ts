/**
 * AEO Stance Service — judges *how* an answer positioned the client.
 *
 * The counted layer (`measurement`) can already tell you whether the brand was
 * named and whether the domain was cited. It cannot tell you whether ChatGPT
 * led with the client, listed them third behind two competitors, or named them
 * only to warn the buyer off. That is what this pass adds.
 *
 * **Provenance rule (D4, `docs/analysis/aeo-audit.md`).** Everything produced
 * here is an LLM *opinion* and is stored in its own table, never merged into a
 * rate. Rates come from counting; stance comes from reading. The verdict keeps
 * the two blocks separate so no downstream consumer can confuse them, and every
 * judgement carries a verbatim quote so a human can check the call.
 *
 * Runs on whichever provider `AeoLlmService` resolves — OpenRouter with a small
 * cheap model by default. With none configured this pass does not run and the
 * audit reports `judged.available = false` with the reason; it never fabricates
 * a stance.
 *
 * @module aeo-stance.service
 */

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AeoLlmService } from './aeo-llm.service';
import { STANCES } from './aeo-audit.types';
import type { PromptDimension, Stance, StanceVerdict } from './aeo-audit.types';
import { PROMPT_DIMENSIONS } from './aeo-audit.types';

/** Answer text handed to the judge, capped so one long answer cannot blow the budget. */
const MAX_ANSWER_CHARS = 12_000;

/** Result of judging a whole run. */
export interface StancePassResult {
  judged: number;
  skipped: number;
  failed: number;
  costUsd: number;
  judgeModel: string;
}

@Injectable()
export class AeoStanceService {
  private readonly logger = new Logger(AeoStanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: AeoLlmService,
  ) {}

  /** Is the judge configured? Callers use this to report honestly, not to guess. */
  isAvailable(): boolean {
    return this.llm.isAvailable();
  }

  /**
   * Judge every observation of a measurement run and persist the verdicts.
   *
   * Idempotent: observations already judged for this audit are skipped, so a
   * re-run after a partial failure only fills the gaps.
   *
   * @param auditId Audit the stances belong to.
   * @param runId Measurement run whose observations get judged.
   * @param subject The client — name and domain.
   * @param competitors Named competitors to look for in the answer.
   * @param costCapUsd Stop and return early once this much has been spent.
   * @param surface Recorded on each row so stance rolls up per engine.
   * @throws ServiceUnavailableException when no API key is configured.
   */
  async judgeRun(
    auditId: string,
    runId: string,
    subject: { name: string; domain: string },
    competitors: string[],
    costCapUsd: number,
    surface?: string,
  ): Promise<StancePassResult> {
    if (!this.isAvailable()) {
      throw new ServiceUnavailableException(
        'No LLM provider configured — stance analysis unavailable. Set OPENROUTER_API_KEY ' +
          '(preferred) or ANTHROPIC_API_KEY. The counted metrics (mention rate, citation ' +
          'rate, share of voice) are unaffected — they never depended on a model.',
      );
    }

    const judgeModel = this.llm.modelName();
    const observations = await this.prisma.observation.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });

    const alreadyJudged = new Set(
      (
        await this.prisma.aeoStance.findMany({
          where: { auditId },
          select: { observationId: true },
        })
      ).map((r) => r.observationId),
    );

    // Prompt → dimension, resolved once so each judgement can be filed under
    // its category without a join per row.
    const dimensionByPrompt = await this.dimensionsForRun(runId);

    let judged = 0;
    let skipped = 0;
    let failed = 0;
    let costUsd = 0;

    for (const obs of observations) {
      if (alreadyJudged.has(obs.id)) {
        skipped++;
        continue;
      }
      if (costUsd >= costCapUsd) {
        this.logger.warn(
          `Stance pass stopped at the cost cap ($${costCapUsd}) after ${judged} judgements — ` +
            `${observations.length - judged - skipped - failed} observations left unjudged`,
        );
        break;
      }

      try {
        const result = await this.judgeOne(
          judgeModel,
          obs.prompt,
          obs.rawAnswer,
          subject,
          competitors,
        );
        costUsd += result.costUsd;

        await this.prisma.aeoStance.create({
          data: {
            auditId,
            observationId: obs.id,
            surface: surface ?? null,
            dimension: dimensionByPrompt.get(obs.prompt) ?? null,
            stance: result.verdict.stance,
            rankAmongBrands: result.verdict.rankAmongBrands,
            brandsNamed: JSON.stringify(result.verdict.brandsNamed),
            recommendedOver: JSON.stringify(result.verdict.recommendedOver),
            losesTo: JSON.stringify(result.verdict.losesTo),
            evidenceQuote: result.verdict.evidenceQuote,
            rationale: result.verdict.rationale,
            judgeModel,
            costUsd: result.costUsd,
          },
        });
        judged++;
      } catch (err) {
        failed++;
        this.logger.warn(`Stance judgement failed for observation ${obs.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `Stance pass for audit ${auditId}: ${judged} judged, ${skipped} already done, ${failed} failed ` +
        `($${costUsd.toFixed(4)})`,
    );

    return { judged, skipped, failed, costUsd: Number(costUsd.toFixed(6)), judgeModel };
  }

  /** Every stored stance for an audit, typed. */
  async list(auditId: string): Promise<StanceVerdict[]> {
    const rows = await this.prisma.aeoStance.findMany({
      where: { auditId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      observationId: row.observationId,
      surface: row.surface,
      dimension: this.asDimension(row.dimension),
      stance: this.asStance(row.stance),
      rankAmongBrands: row.rankAmongBrands,
      brandsNamed: this.parseArray(row.brandsNamed),
      recommendedOver: this.parseArray(row.recommendedOver),
      losesTo: this.parseArray(row.losesTo),
      evidenceQuote: row.evidenceQuote,
      rationale: row.rationale,
    }));
  }

  // ─── The judge ─────────────────────────────────────────────────────────

  /**
   * Judge one answer.
   *
   * The model is told to read the answer as the buyer would and report what the
   * answer *does*, not what it thinks of the client. It must quote the answer
   * verbatim for its call, which keeps the judgement checkable by a human.
   */
  private async judgeOne(
    model: string,
    prompt: string,
    rawAnswer: string,
    subject: { name: string; domain: string },
    competitors: string[],
  ): Promise<{ verdict: StanceVerdict; costUsd: number }> {
    void model; // the provider picks the model; the caller records which one ran
    const answer = rawAnswer.slice(0, MAX_ANSWER_CHARS);

    const result = await this.llm.json(
      {
        purpose: 'stance judgement',
        maxTokens: 1200,
        system:
          'You read one AI assistant answer and report how it positioned a specific company. ' +
          'You are an impartial analyst: report what the answer does, not what you think of the company.\n' +
          'stance — pick exactly one:\n' +
          '  "recommended-primary": the answer leads with this company, or names it as the top/first choice.\n' +
          '  "recommended-alternative": named as one credible option among several, without being led with.\n' +
          '  "mentioned-neutral": named, but with no endorsement either way.\n' +
          '  "mentioned-negative": named with a caveat, warning, or as the weaker option.\n' +
          '  "absent": not named at all.\n' +
          'Rules:\n' +
          '- brandsNamed: every company the answer names, in the order the answer names them. ' +
          'Include the subject if named. Do not include the subject if it is absent.\n' +
          "- rankAmongBrands: the subject's 1-based position in brandsNamed, or null when absent.\n" +
          '- recommendedOver: competitors the answer places BELOW the subject. Only when the answer ' +
          'actually makes that comparison — an empty array is the correct answer otherwise.\n' +
          '- losesTo: competitors the answer places ABOVE the subject. Same rule.\n' +
          '- evidenceQuote: up to 280 characters copied VERBATIM from the answer that justifies the ' +
          'stance. null only when the subject is absent.\n' +
          '- rationale: one short sentence.\n' +
          '- Never infer beyond the answer text. If the answer does not compare two companies, do not rank them.\n' +
          'Respond with ONLY JSON: {"stance":string,"brandsNamed":string[],"rankAmongBrands":number|null,' +
          '"recommendedOver":string[],"losesTo":string[],"evidenceQuote":string|null,"rationale":string}',
        user:
          'Subject company: "' + subject.name + '" (' + subject.domain + ')\n' +
          'Known competitors: ' + (competitors.length ? competitors.join(', ') : 'none recorded') + '\n\n' +
          'The buyer asked:\n' + prompt + '\n\n' +
          'The assistant answered:\n' + answer,
      },
      (raw) => this.validate(raw, competitors),
    );

    return { verdict: result.data, costUsd: result.costUsd };
  }

  /**
   * Coerce the judge's JSON into a {@link StanceVerdict}.
   *
   * Competitor names are intersected with the recorded list so the judge cannot
   * invent a rival, and an absent subject is forced to a null rank — the two
   * ways a sloppy judgement could otherwise mislead the report.
   */
  private validate(raw: unknown, competitors: string[]): StanceVerdict {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const known = new Map(competitors.map((c) => [c.toLowerCase(), c]));

    const strArr = (v: unknown, cap: number): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean).slice(0, cap)
        : [];

    /** Keep only names that match a recorded competitor. */
    const knownOnly = (v: unknown): string[] => {
      const out: string[] = [];
      for (const name of strArr(v, 20)) {
        const match = known.get(name.toLowerCase());
        if (match && !out.includes(match)) out.push(match);
      }
      return out;
    };

    const stance = this.asStance(typeof obj.stance === 'string' ? obj.stance : 'absent');
    const absent = stance === 'absent';

    const rankRaw = obj.rankAmongBrands;
    const rank =
      !absent && typeof rankRaw === 'number' && Number.isFinite(rankRaw) && rankRaw >= 1
        ? Math.floor(rankRaw)
        : null;

    const quote = typeof obj.evidenceQuote === 'string' ? obj.evidenceQuote.trim().slice(0, 280) : '';

    return {
      observationId: '', // filled by the caller
      surface: null, // filled by the caller
      dimension: null, // filled by the caller
      stance,
      rankAmongBrands: rank,
      brandsNamed: strArr(obj.brandsNamed, 20),
      recommendedOver: absent ? [] : knownOnly(obj.recommendedOver),
      losesTo: knownOnly(obj.losesTo),
      evidenceQuote: absent || !quote ? null : quote,
      rationale: typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 400) : null,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Map each prompt of a run back to the matrix category it came from, so a
   * stance can be filed under its dimension without joining per row.
   */
  private async dimensionsForRun(runId: string): Promise<Map<string, string>> {
    const run = await this.prisma.measurementRun.findUnique({
      where: { id: runId },
      select: { querySetId: true },
    });
    if (!run) return new Map();
    const items = await this.prisma.querySetItem.findMany({
      where: { querySetId: run.querySetId },
      select: { prompt: true, dimension: true },
    });
    const map = new Map<string, string>();
    for (const item of items) {
      if (item.dimension) map.set(item.prompt, item.dimension);
    }
    return map;
  }

  private asStance(raw: string): Stance {
    return (STANCES as readonly string[]).includes(raw) ? (raw as Stance) : 'absent';
  }

  private asDimension(raw: string | null): PromptDimension | null {
    return raw && (PROMPT_DIMENSIONS as readonly string[]).includes(raw) ? (raw as PromptDimension) : null;
  }

  private parseArray(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

}
