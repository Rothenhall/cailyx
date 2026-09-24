/**
 * AEO Narrative Service — customer-facing framing of an already-computed verdict.
 *
 * `AeoAuditService.headlines()` produces plain factual lines ("Facts only, no
 * adjectives" — `aeo-audit.types.ts`). This service takes those same facts and
 * asks an LLM to reword them for the reader: a first audit is framed with the
 * seriousness real gaps warrant, a repeat audit (when genuinely comparable to
 * the prior one) leads with the real delta. The LLM never sees raw observation
 * rows and is instructed never to invent a number, trend, or brand mention —
 * it reframes, it does not compute.
 *
 * Deliberately a separate, explicitly-triggered pass — never called from
 * inside `buildVerdict()`/`verdict()`, which stay cheap and side-effect free.
 * Any failure here (no provider configured, LLM error, malformed response)
 * degrades to leaving `verdict.narrative` unset; `verdict.headlines` is always
 * the fallback for any consumer.
 *
 * @module aeo-narrative.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AeoLlmService } from './aeo-llm.service';
import { areAuditsComparable } from './aeo-comparability';
import type { AeoVerdict, NarrativeBlock } from './aeo-audit.types';

const MAX_NARRATIVE_LINES = 8; // headlines() typically emits 5-7 lines
const MAX_LINE_CHARS = 220; // generous single-clause cap, matches headline density

@Injectable()
export class AeoNarrativeService {
  private readonly logger = new Logger(AeoNarrativeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: AeoLlmService,
  ) {}

  isAvailable(): boolean {
    return this.llm.isAvailable();
  }

  /**
   * Generate (or regenerate) the narrative framing for one completed audit and
   * persist it into the same `AeoAudit.verdict` JSON blob, alongside the
   * existing deterministic `headlines`.
   *
   * Never throws into a caller's larger pipeline — on any failure this logs
   * and returns `null`.
   */
  async generate(auditId: string): Promise<NarrativeBlock | null> {
    const audit = await this.prisma.aeoAudit.findUnique({ where: { id: auditId } });
    if (!audit || audit.status !== 'completed' || !audit.verdict) {
      this.logger.warn(`Narrative pass skipped for ${auditId}: audit not completed or has no verdict yet`);
      return null;
    }
    if (!this.isAvailable()) {
      this.logger.warn(`Narrative pass skipped for ${auditId}: no LLM provider configured`);
      return null;
    }

    const verdict = JSON.parse(audit.verdict) as AeoVerdict;
    const { isFirstAudit, comparable, comparedToAuditId, priorFacts } = await this.resolveComparability(audit);

    try {
      const result = await this.llm.json(
        {
          purpose: 'aeo-narrative',
          maxTokens: 700,
          system: this.systemPrompt(),
          user: this.userPayload(verdict, isFirstAudit, comparable, priorFacts),
        },
        (raw) => this.validate(raw),
      );

      const narrative: NarrativeBlock = {
        headlines: result.data,
        isFirstAudit,
        comparable,
        ...(comparedToAuditId ? { comparedToAuditId } : {}),
        generatedAt: new Date().toISOString(),
        model: result.model,
      };

      const merged: AeoVerdict = { ...verdict, narrative };
      // Compare-and-swap on the exact verdict this narrative was written from.
      // The LLM call takes seconds; if judgeStance (or another pass) stored a
      // newer verdict meanwhile, writing `{...stale, narrative}` would silently
      // undo it. That newer write starts its own narrative refresh, so this
      // stale one is simply dropped.
      const written = await this.prisma.aeoAudit.updateMany({
        where: { id: auditId, verdict: audit.verdict },
        // Recorded on the audit like every other LLM pass here (stance judging
        // does the same) so the cost governor sees the true total spend.
        data: { verdict: JSON.stringify(merged), costUsd: { increment: result.costUsd } },
      });
      if (written.count === 0) {
        // The call was still paid for — record the spend without touching the verdict.
        await this.prisma.aeoAudit.update({ where: { id: auditId }, data: { costUsd: { increment: result.costUsd } } });
        this.logger.log(`Narrative for ${auditId} discarded: the verdict changed while it was being written`);
        return null;
      }
      return narrative;
    } catch (err) {
      this.logger.warn(`Narrative pass failed for ${auditId}: ${(err as Error).message}`);
      return null;
    }
  }

  // ─── Prior-audit comparability ──────────────────────────────────────────

  /**
   * The shared methodology rule (`aeo-comparability.ts`): a different question
   * set, engine set or market set means the two audits measured different
   * things, and any "improvement" framing off their raw numbers would be
   * fabricated.
   */
  private async resolveComparability(audit: {
    projectId: string;
    createdAt: Date;
    querySetId: string | null;
    surfaces: string;
    markets: string;
  }): Promise<{
    isFirstAudit: boolean;
    comparable: boolean;
    comparedToAuditId?: string;
    priorFacts?: { headlines: string[]; mentionRate: number; unbrandedMentionRate: number };
  }> {
    const prior = await this.prisma.aeoAudit.findFirst({
      where: { projectId: audit.projectId, status: 'completed', createdAt: { lt: audit.createdAt } },
      orderBy: { createdAt: 'desc' },
    });
    if (!prior || !prior.verdict) return { isFirstAudit: true, comparable: false };

    if (!areAuditsComparable(audit, prior)) {
      return { isFirstAudit: false, comparable: false };
    }

    const priorVerdict = JSON.parse(prior.verdict) as AeoVerdict;
    return {
      isFirstAudit: false,
      comparable: true,
      comparedToAuditId: prior.id,
      priorFacts: {
        headlines: priorVerdict.headlines,
        mentionRate: priorVerdict.counted.overall.mentionRate,
        unbrandedMentionRate: priorVerdict.counted.unbranded.mentionRate,
      },
    };
  }

  // ─── Prompting ───────────────────────────────────────────────────────────

  private systemPrompt(): string {
    return `You rewrite already-computed audit findings into a short, plain-spoken customer-facing summary for a brand-visibility report.

STRICT RULES — violating any of these makes your output unusable:
1. Use ONLY the facts given to you in the user message. Never invent a number, percentage, trend, or comparison that is not explicitly present in the input.
2. Never mention "Rothenhall", "Rothenhall Partners", or any consulting/agency name. Write as if the report itself is the analyst.
3. Output must be plain factual sentences — no marketing adjectives ("amazing", "incredible"), no exclamation points, no emojis.
4. Match the register of the input headlines: terse, one clause or idea per line, no more lines than the input, and no line longer than ~200 characters.
5. If "isFirstAudit" is true OR "comparable" is false: do not claim any trend, improvement, or change over time. Frame the CURRENT findings with appropriate seriousness so a reader understands their visibility has real, specific gaps — but every claim must trace to a fact in the input.
6. If "isFirstAudit" is false AND "comparable" is true: lead with the genuine change between "priorFacts" and the current facts (up or down — report it honestly either way; do not manufacture positivity if the numbers moved the wrong way). Only claim a delta that is arithmetically present in the given numbers.
7. Return ONLY a JSON object: {"headlines": ["...", "..."]}. No prose outside the JSON, no markdown fences.`;
  }

  private userPayload(
    verdict: AeoVerdict,
    isFirstAudit: boolean,
    comparable: boolean,
    priorFacts?: { headlines: string[]; mentionRate: number; unbrandedMentionRate: number },
  ): string {
    return JSON.stringify({
      isFirstAudit,
      comparable,
      currentFacts: {
        headlines: verdict.headlines,
        overallMentionRate: verdict.counted.overall.mentionRate,
        unbrandedMentionRate: verdict.counted.unbranded.mentionRate,
        observations: verdict.counted.overall.observations,
      },
      priorFacts: comparable ? priorFacts : undefined,
    });
  }

  private validate(raw: unknown): string[] {
    if (typeof raw !== 'object' || raw === null || !('headlines' in raw)) {
      throw new Error('narrative response missing "headlines"');
    }
    const lines = (raw as { headlines: unknown }).headlines;
    if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_NARRATIVE_LINES) {
      throw new Error(`narrative response has invalid line count (${Array.isArray(lines) ? lines.length : 'n/a'})`);
    }
    return lines.map((l) => {
      if (typeof l !== 'string' || l.trim().length === 0) throw new Error('narrative line is not a non-empty string');
      if (l.length > MAX_LINE_CHARS) throw new Error(`narrative line exceeds ${MAX_LINE_CHARS} chars`);
      return l.trim();
    });
  }
}
