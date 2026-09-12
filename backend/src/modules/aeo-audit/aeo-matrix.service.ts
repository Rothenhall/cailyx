/**
 * AEO Matrix Service — turns site context into a stored, categorised prompt set.
 *
 * Three steps (D3, `docs/analysis/aeo-audit.md`):
 *   1. {@link generateMatrix} builds the deterministic cells — the coverage contract.
 *   2. An optional constrained-LLM pass rewrites each cell's *phrasing* into how
 *      a person actually types, grounded in the site context. It may not add,
 *      drop, reorder or re-categorise cells; a response that tries to is rejected
 *      and the deterministic phrasing stands.
 *   3. The result is persisted as a `QuerySet` (`source="aeo-matrix"`) so it
 *      inherits versioning, draft→active immutability, client export, and the
 *      whole `measurement` execution path (D5).
 *
 * **Categorisation is persisted per prompt**: `QuerySetItem.dimension` holds the
 * category, `QuerySetItem.meta` holds the full {@link PromptMeta} (register,
 * branded/unbranded, which service or competitor the cell targets, template id).
 * That is what makes the matrix curatable after the fact — filter by category,
 * see which cells produced signal, hand-edit the rest.
 *
 * @module aeo-matrix.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AeoLlmService } from './aeo-llm.service';
import {
  generateMatrix,
  type DemandIndex,
  type GeneratedMatrix,
  type SkippedDimension,
} from './aeo-matrix.generator';
import { DIMENSION_LABELS, PROMPT_DIMENSIONS, TIER_SIZES } from './aeo-audit.types';
import type {
  MatrixCell,
  MatrixTier,
  PromptDimension,
  PromptMeta,
  SiteContextData,
} from './aeo-audit.types';

/** Cells per refinement request — small enough to keep the mapping reliable. */
const REFINE_BATCH = 20;

/** One stored matrix prompt, as returned to callers. */
export interface MatrixPromptDto {
  id: string;
  prompt: string;
  dimension: PromptDimension | null;
  funnelStage: string;
  meta: PromptMeta | null;
}

/** A matrix grouped by its categories — the shape the UI and curation use. */
export interface MatrixSummary {
  querySetId: string;
  version: number;
  status: string;
  tier: MatrixTier;
  promptCount: number;
  refined: boolean;
  byDimension: Array<{
    dimension: PromptDimension;
    label: string;
    count: number;
    branded: number;
    unbranded: number;
    prompts: MatrixPromptDto[];
  }>;
  skipped: SkippedDimension[];
}

@Injectable()
export class AeoMatrixService {
  private readonly logger = new Logger(AeoMatrixService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llm: AeoLlmService,
  ) {}

  /**
   * Generate a prompt matrix from a site context and store it as a draft QuerySet.
   *
   * @param projectId Project the matrix belongs to.
   * @param context Site context the cells interpolate from.
   * @param opts.tier Size tier (default `AEO_MATRIX_TIER`, `standard` = 100).
   * @param opts.refine Run the LLM phrasing pass (default true; skipped without a key).
   * @param opts.activate Activate immediately so `measurement` can run it (default true).
   * @returns The stored matrix, grouped by category.
   */
  async generate(
    projectId: string,
    context: SiteContextData,
    opts: { tier?: MatrixTier; refine?: boolean; activate?: boolean } = {},
  ): Promise<MatrixSummary & { costUsd: number }> {
    const tier = opts.tier ?? this.defaultTier();
    const demand = await this.demandIndex(projectId);
    const generated = generateMatrix(projectId, context, tier, demand);

    if (generated.cells.length === 0) {
      throw new BadRequestException(
        'No prompts could be generated — the site context is empty. ' +
          'Skipped: ' + generated.skipped.map((s) => `${s.dimension} (${s.reason})`).join('; '),
      );
    }

    let cells = generated.cells;
    let costUsd = 0;
    let refined = false;

    if (opts.refine !== false && this.llm.isAvailable()) {
      try {
        const result = await this.refinePhrasing(cells, context);
        cells = result.cells;
        costUsd = result.costUsd;
        refined = true;
      } catch (err) {
        // Phrasing is a nicety; coverage is the contract. Keep the templates.
        this.logger.warn('Matrix phrasing pass failed, keeping template phrasing: ' + (err as Error).message);
      }
    }

    const querySet = await this.persist(projectId, cells, tier, generated);
    if (opts.activate !== false) {
      await this.prisma.querySet.update({
        where: { id: querySet.id },
        data: { status: 'active', activatedAt: new Date() },
      });
    }

    this.logger.log(
      `Matrix v${querySet.version} for project ${projectId}: ${cells.length} prompts across ` +
        `${new Set(cells.map((c) => c.dimension)).size} categories (tier=${tier}, refined=${refined})`,
    );

    const summary = await this.summary(querySet.id);
    return { ...summary, costUsd };
  }

  /**
   * Read a stored matrix, grouped by category.
   * @throws NotFoundException when the query set does not exist.
   */
  async summary(querySetId: string): Promise<MatrixSummary> {
    const qs = await this.prisma.querySet.findUnique({
      where: { id: querySetId },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
    if (!qs) throw new NotFoundException('Matrix not found: ' + querySetId);

    const prompts: MatrixPromptDto[] = qs.items.map((item) => ({
      id: item.id,
      prompt: item.prompt,
      dimension: this.asDimension(item.dimension),
      funnelStage: item.funnelStage,
      meta: this.parseMeta(item.meta),
    }));

    const byDimension = PROMPT_DIMENSIONS.map((dimension) => {
      const group = prompts.filter((p) => p.dimension === dimension);
      return {
        dimension,
        label: DIMENSION_LABELS[dimension],
        count: group.length,
        branded: group.filter((p) => p.meta?.branding === 'branded').length,
        unbranded: group.filter((p) => p.meta?.branding === 'unbranded').length,
        prompts: group,
      };
    }).filter((g) => g.count > 0);

    const label = this.parseLabel(qs.label);

    return {
      querySetId: qs.id,
      version: qs.version,
      status: qs.status,
      tier: label.tier,
      promptCount: prompts.length,
      refined: prompts.some((p) => p.meta?.refined === true),
      byDimension,
      skipped: label.skipped,
    };
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /**
   * Store cells as the next matrix version for this project.
   *
   * Written through Prisma rather than `QuerySetService.create` because a matrix
   * spans all four personas at once (each category sits at its own funnel stage),
   * while that API is one-persona-per-set and refuses a second v1. The set's
   * `persona` column therefore records the modal persona and the real per-prompt
   * taxonomy lives on each item (`funnelStage` + `dimension` + `meta`).
   */
  private async persist(
    projectId: string,
    cells: MatrixCell[],
    tier: MatrixTier,
    generated: GeneratedMatrix,
  ) {
    const modalPersona = this.modalPersona(cells);
    const latest = await this.prisma.querySet.findFirst({
      where: { projectId, persona: modalPersona },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const querySet = await this.prisma.querySet.create({
      data: {
        projectId,
        version,
        persona: modalPersona,
        // The label doubles as the matrix's provenance record: tier + which
        // categories could not be built and why.
        label: JSON.stringify({
          kind: 'aeo-matrix',
          tier,
          requested: generated.requested,
          produced: generated.produced,
          skipped: generated.skipped,
        }),
        status: 'draft',
        source: 'aeo-matrix',
      },
    });

    // createMany keeps a 300-prompt matrix to a single round trip.
    await this.prisma.querySetItem.createMany({
      data: cells.map((cell) => ({
        querySetId: querySet.id,
        prompt: cell.prompt,
        funnelStage: cell.funnelStage,
        dimension: cell.dimension,
        meta: JSON.stringify(cell.meta),
      })),
    });

    return querySet;
  }

  // ─── LLM phrasing pass ─────────────────────────────────────────────────

  /**
   * Rewrite template phrasing into natural buyer phrasing, in batches.
   *
   * Contract enforced on every batch: same count, same order, same categories.
   * A batch that violates it keeps its deterministic phrasing rather than
   * corrupting the matrix.
   */
  private async refinePhrasing(
    cells: MatrixCell[],
    context: SiteContextData,
  ): Promise<{ cells: MatrixCell[]; costUsd: number }> {
    const out: MatrixCell[] = [];
    let costUsd = 0;

    for (let i = 0; i < cells.length; i += REFINE_BATCH) {
      const batch = cells.slice(i, i + REFINE_BATCH);
      try {
        const result = await this.refineBatch(batch, context);
        costUsd += result.costUsd;
        out.push(...result.cells);
      } catch (err) {
        this.logger.debug('Phrasing batch kept as-is: ' + (err as Error).message);
        out.push(...batch);
      }
    }

    return { cells: out, costUsd: Number(costUsd.toFixed(6)) };
  }

  /**
   * One batch of the phrasing pass.
   *
   * Contract enforced here: same count, same order, same categories. A response
   * that violates it throws, and the caller keeps the batch's deterministic
   * phrasing rather than letting a sloppy rewrite corrupt the matrix.
   */
  private async refineBatch(
    batch: MatrixCell[],
    context: SiteContextData,
  ): Promise<{ cells: MatrixCell[]; costUsd: number }> {
    const result = await this.llm.json(
      {
        purpose: 'matrix phrasing',
        maxTokens: 3000,
        system:
          'You rewrite draft search prompts so they read like a real person typing into ChatGPT. ' +
          'This is for a visibility audit: the prompts must stay realistic, not promotional.\n' +
          'Rules:\n' +
          '- Return EXACTLY one rewrite per input, in the same order. Never add, drop or reorder.\n' +
          '- Keep the intent and every named entity (brand, competitor, service, place) exactly as given. ' +
          'Never introduce a company, product or place that is not in the input.\n' +
          'Each draft is tagged with its register. The two are formatted differently and the rules for ' +
          'one must NEVER be applied to the other:\n' +
          '- register "terse": lowercase, clipped, search-like, under 10 words, NO punctuation at the end.\n' +
          '- register "conversational": a full natural sentence, written the way a person speaks. ' +
          'Keep normal capitalisation (start with a capital letter) and KEEP the terminal punctuation — ' +
          'a question ends in "?". Under 30 words. Do NOT lowercase these and do NOT strip their punctuation.\n' +
          '- Fix grammar broken by the draft\'s placeholders. If a phrase like "a funds" or "a lean teams" ' +
          'appears, drop or correct the article so it reads naturally.\n' +
          '- Never make the prompt flattering toward any company. A buyer asking is neutral or sceptical.\n' +
          '- If a draft is already natural, return it unchanged.\n' +
          'Respond with ONLY JSON: {"prompts":[{"i":number,"prompt":string}]}',
        user:
          'Client context — brand "' + context.brand + '"' +
          (context.category ? ', category "' + context.category + '"' : '') +
          (context.geo ? ', market "' + context.geo + '"' : '') + '.\n\n' +
          'Drafts to rewrite:\n' +
          batch
            .map((c, idx) => idx + '. [' + c.dimension + ' | ' + c.meta.register + '] ' + c.prompt)
            .join('\n'),
      },
      (raw) => {
        const rows = (raw as { prompts?: unknown })?.prompts;
        if (!Array.isArray(rows) || rows.length !== batch.length) {
          throw new Error(
            'phrasing pass returned ' + (Array.isArray(rows) ? rows.length : 0) + ' of ' + batch.length,
          );
        }
        return rows;
      },
    );

    const cells = batch.map((cell, idx) => {
      const row = result.data.find(
        (r): r is { i: number; prompt: string } =>
          Boolean(r) &&
          typeof r === 'object' &&
          (r as { i?: unknown }).i === idx &&
          typeof (r as { prompt?: unknown }).prompt === 'string',
      );
      const rewritten = this.tidy(row?.prompt ?? '');
      if (!rewritten || rewritten.length < 6 || rewritten.length > 300) return cell;
      // Register backstop: models bleed the "terse" rule (lowercase, no end
      // punctuation) onto conversational drafts, which turns "Who can help me
      // with RevOps? I run a fund." into "who can help me with revops i run a
      // fund". Those are different queries — a buyer typing a sentence types it
      // like a sentence — so a rewrite that flattened one is discarded rather
      // than trusted.
      if (cell.meta.register === 'conversational' && !this.readsAsSentence(rewritten)) return cell;
      // Guard the categorisation: a rewrite that dropped the named entity the
      // cell exists to test is not a rewrite, it is a different prompt.
      if (cell.meta.competitor && !rewritten.toLowerCase().includes(cell.meta.competitor.toLowerCase())) {
        return cell;
      }
      if (cell.meta.branding === 'branded' && !rewritten.toLowerCase().includes(context.brand.toLowerCase())) {
        return cell;
      }
      return { ...cell, prompt: rewritten, meta: { ...cell.meta, refined: true } };
    });

    return { cells, costUsd: result.costUsd };
  }

  /**
   * Light whitespace repair on an accepted rewrite. Models occasionally drop the
   * space around an em-dash ("cited by AI— is there a service"), which the
   * template layer never produces but the phrasing pass sometimes introduces.
   */
  private tidy(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\s*([—–])\s*/g, ' $1 ')
      .replace(/\s+([?.,!;:])/g, '$1')
      .trim();
  }

  /**
   * Does this read as a written sentence rather than a search box entry?
   * Sentence case at the front and terminal punctuation at the end — the two
   * things the terse rule strips.
   */
  private readsAsSentence(text: string): boolean {
    return /^[A-Z]/.test(text) && /[?.!]$/.test(text);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Most common persona across cells — recorded on the set for compatibility. */
  private modalPersona(cells: MatrixCell[]): string {
    const counts = new Map<string, number>();
    for (const c of cells) counts.set(c.persona, (counts.get(c.persona) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'solution-aware';
  }

  private asDimension(raw: string | null): PromptDimension | null {
    return raw && (PROMPT_DIMENSIONS as readonly string[]).includes(raw) ? (raw as PromptDimension) : null;
  }

  private parseMeta(raw: string | null): PromptMeta | null {
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as PromptMeta) : null;
    } catch {
      return null;
    }
  }

  /** The label column carries the matrix provenance JSON; tolerate plain text. */
  private parseLabel(raw: string | null): { tier: MatrixTier; skipped: SkippedDimension[] } {
    if (!raw) return { tier: 'standard', skipped: [] };
    try {
      const parsed = JSON.parse(raw) as { tier?: unknown; skipped?: unknown };
      const tier =
        typeof parsed.tier === 'string' && parsed.tier in TIER_SIZES ? (parsed.tier as MatrixTier) : 'standard';
      const skipped = Array.isArray(parsed.skipped) ? (parsed.skipped as SkippedDimension[]) : [];
      return { tier, skipped };
    } catch {
      return { tier: 'standard', skipped: [] };
    }
  }

  /**
   * Measured search demand for this project, from its latest keyword research.
   *
   * Optional by design (wave-6 step 4). No research run → `undefined` → the
   * matrix generates exactly as it did before, so this can never become a
   * hidden prerequisite for producing a matrix at all.
   *
   * Read straight from the table rather than through `keyword-research`'s
   * service: the generator wants volumes, not that module's orchestration, and
   * importing it here would couple the AEO matrix to a vendor integration it
   * does not otherwise need.
   *
   * @returns keyword → monthly search volume, or undefined when there is none.
   */
  private async demandIndex(projectId: string): Promise<DemandIndex | undefined> {
    const set = await this.prisma.keywordSet.findFirst({
      where: { projectId, status: { in: ['completed', 'partial'] } },
      orderBy: { createdAt: 'desc' },
      select: {
        keywords: {
          where: { searchVolume: { not: null, gt: 0 } },
          select: { keyword: true, searchVolume: true },
        },
      },
    });
    if (!set || set.keywords.length === 0) return undefined;

    const index: DemandIndex = new Map();
    for (const k of set.keywords) {
      if (k.searchVolume === null) continue;
      // Keep the highest volume when the same term appears twice (a seed and a
      // related suggestion can collide).
      index.set(k.keyword, Math.max(index.get(k.keyword) ?? 0, k.searchVolume));
    }
    this.logger.debug(`Demand weighting: ${index.size} keywords with volume for ${projectId}`);
    return index;
  }

  private defaultTier(): MatrixTier {
    const raw = this.config.get<string>('AEO_MATRIX_TIER', 'standard');
    return raw in TIER_SIZES ? (raw as MatrixTier) : 'standard';
  }

}
