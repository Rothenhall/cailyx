/**
 * Brand-voice synthesis — reads the captions the Apify pull already stored
 * (`PresencePost`, wave-6 D7) and organises them into how the brand actually
 * writes: tone, recurring themes, its own vocabulary, and its call-to-action
 * patterns. `presence.apify.service.ts` captures metrics (likes, followers,
 * cadence) but never reads the caption TEXT for anything — this is the pass
 * that does.
 *
 * Same two-layer discipline as `aeo-audit/aeo-context.service.ts`:
 *   1. **Deterministic** — group stored captions by platform, count them.
 *      Always computed, free, no key needed.
 *   2. **LLM synthesis** — one constrained-JSON pass over the real captions.
 *      Optional: with too few captions or no provider configured, the read
 *      stays `extraction: 'insufficient-data'` rather than inventing a voice.
 *
 * The model sees only captions that were really scraped and is told to
 * return an empty array rather than guess a tone from nothing.
 *
 * @module presence.brand-voice.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PresenceLlmService } from './presence.llm.service';

/** Captions read per platform, most-recent first — enough for a voice read
 *  without handing the model an unbounded corpus. */
const MAX_CAPTIONS_PER_PLATFORM = 40;

/** Below this, the captions on file are a handful of one-off posts, not
 *  enough to call anything a pattern. */
const MIN_CAPTIONS_FOR_SYNTHESIS = 3;

/** Cap on characters of caption text handed to the synthesis pass. */
const MAX_SYNTHESIS_CHARS = 16_000;

export interface BrandVoiceByPlatform {
  platform: string;
  postSample: number;
  tone: string[];
  themes: string[];
}

export interface BrandVoiceResult {
  projectId: string;
  domain: string;
  tone: string[];
  themes: string[];
  vocabulary: string[];
  callToActions: string[];
  summary: string | null;
  /** Total captions actually read across every platform. */
  postSample: number;
  byPlatform: BrandVoiceByPlatform[];
  extraction: 'llm-synthesized' | 'insufficient-data';
  llmModel: string | null;
  costUsd: number;
}

/** Shape the synthesis model must return. */
interface SynthesisResult {
  tone: string[];
  themes: string[];
  vocabulary: string[];
  callToActions: string[];
  summary: string | null;
  byPlatform: Array<{ platform: string; tone: string[]; themes: string[] }>;
}

@Injectable()
export class PresenceBrandVoiceService {
  private readonly logger = new Logger(PresenceBrandVoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: PresenceLlmService,
  ) {}

  /**
   * Build and persist a brand-voice read from the project's stored captions.
   *
   * @throws NotFoundException when the project does not exist.
   */
  async synthesize(projectId: string): Promise<BrandVoiceResult & { id: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const posts = await this.prisma.presencePost.findMany({
      where: { projectId, kind: 'post', caption: { not: null } },
      orderBy: { fetchedAt: 'desc' },
      select: { platform: true, caption: true },
    });

    const byPlatformCaptions = new Map<string, string[]>();
    for (const post of posts) {
      const caption = (post.caption ?? '').trim();
      if (!caption) continue;
      const list = byPlatformCaptions.get(post.platform) ?? [];
      if (list.length >= MAX_CAPTIONS_PER_PLATFORM) continue;
      list.push(caption);
      byPlatformCaptions.set(post.platform, list);
    }

    const postSample = [...byPlatformCaptions.values()].reduce((sum, l) => sum + l.length, 0);
    const baseByPlatform: BrandVoiceByPlatform[] = [...byPlatformCaptions.entries()].map(
      ([platform, captions]) => ({ platform, postSample: captions.length, tone: [], themes: [] }),
    );

    let result: BrandVoiceResult = {
      projectId,
      domain: project.domain,
      tone: [],
      themes: [],
      vocabulary: [],
      callToActions: [],
      summary: null,
      postSample,
      byPlatform: baseByPlatform,
      extraction: 'insufficient-data',
      llmModel: null,
      costUsd: 0,
    };

    if (postSample < MIN_CAPTIONS_FOR_SYNTHESIS) {
      this.logger.debug(
        `Brand voice for ${project.domain}: only ${postSample} caption(s) on file (need ${MIN_CAPTIONS_FOR_SYNTHESIS}) — run the Apify social-activity pull first`,
      );
    } else if (!this.llm.isAvailable()) {
      this.logger.debug(`Brand voice for ${project.domain}: no LLM provider configured`);
    } else {
      try {
        const synth = await this.runSynthesis(project.name, byPlatformCaptions);
        result = {
          ...result,
          tone: synth.result.tone,
          themes: synth.result.themes,
          vocabulary: synth.result.vocabulary,
          callToActions: synth.result.callToActions,
          summary: synth.result.summary,
          byPlatform: synth.result.byPlatform.length
            ? synth.result.byPlatform.map((p) => ({
                platform: p.platform,
                postSample: byPlatformCaptions.get(p.platform)?.length ?? 0,
                tone: p.tone,
                themes: p.themes,
              }))
            : baseByPlatform,
          extraction: 'llm-synthesized',
          llmModel: synth.model,
          costUsd: synth.costUsd,
        };
      } catch (err) {
        // A failed synthesis must not lose the caption counts already computed.
        this.logger.warn(
          `Brand-voice synthesis failed for ${project.domain}, keeping insufficient-data: ${(err as Error).message}`,
        );
      }
    }

    const row = await this.prisma.presenceBrandVoice.create({
      data: {
        projectId,
        domain: result.domain,
        tone: JSON.stringify(result.tone),
        themes: JSON.stringify(result.themes),
        vocabulary: JSON.stringify(result.vocabulary),
        callToActions: JSON.stringify(result.callToActions),
        summary: result.summary,
        postSample: result.postSample,
        byPlatform: JSON.stringify(result.byPlatform),
        extraction: result.extraction,
        llmModel: result.llmModel,
        costUsd: result.costUsd,
      },
    });

    this.logger.log(
      `Brand voice built for ${result.domain}: ${result.tone.length} tone descriptor(s), ${postSample} caption(s) (${result.extraction})`,
    );

    return { ...result, id: row.id };
  }

  /** Latest stored brand-voice read for a project, or null when none has been built. */
  async latest(projectId: string): Promise<(BrandVoiceResult & { id: string; createdAt: Date }) | null> {
    const row = await this.prisma.presenceBrandVoice.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.rowToResult(row) : null;
  }

  // ─── LLM synthesis ────────────────────────────────────────────────────

  private async runSynthesis(
    brand: string,
    byPlatform: Map<string, string[]>,
  ): Promise<{ result: SynthesisResult; model: string; costUsd: number }> {
    let corpus = '';
    for (const [platform, captions] of byPlatform) {
      const chunk =
        '\n\n--- ' + platform + ' ---\n' +
        captions.map((c) => '- ' + c.replace(/\s+/g, ' ').trim()).join('\n');
      if (corpus.length + chunk.length > MAX_SYNTHESIS_CHARS) break;
      corpus += chunk;
    }

    const result = await this.llm.json(
      {
        purpose: 'brand voice synthesis',
        maxTokens: 1200,
        system:
          "You read a company's real social-media captions and describe, factually, how they write. " +
          'You are building an input for a marketing audit, so ground every claim in the captions shown — ' +
          'never invent a tone or theme the text does not support.\n' +
          'Rules:\n' +
          '- tone: 2-6 short adjectives describing how the copy reads (e.g. "confident", "playful", "technical"). ' +
          'Base each one on a real pattern in the captions, not a guess about the industry.\n' +
          '- themes: 2-8 short phrases naming what they actually post about (e.g. "product updates", "customer wins").\n' +
          "- vocabulary: 3-10 distinctive words or short phrases this brand repeats across captions — their own " +
          'language, not generic marketing words every brand uses.\n' +
          '- callToActions: the recurring call-to-action patterns, verbatim or near-verbatim from the captions ' +
          '(e.g. "Book a call", "Link in bio"). Empty array if none repeat.\n' +
          '- summary: 1-2 plain sentences describing the voice, written for someone about to write copy in the same voice.\n' +
          '- byPlatform: tone + themes broken out per platform ONLY when the voice genuinely differs between them ' +
          '(e.g. LinkedIn formal, Instagram casual). Empty array when one voice covers everything — do not force a ' +
          'per-platform split that is not really there.\n' +
          'If the captions are too few or too generic to support a field, return an empty array for it — an empty ' +
          'array is a correct answer.\n' +
          'Respond with ONLY JSON matching: {"tone":string[],"themes":string[],"vocabulary":string[],' +
          '"callToActions":string[],"summary":string|null,"byPlatform":[{"platform":string,"tone":string[],"themes":string[]}]}',
        user: 'Brand: ' + brand + '\n\nCaptions follow, grouped by platform.\n' + corpus,
      },
      (raw) => this.validateSynthesis(raw),
    );

    return { result: result.data, model: result.model, costUsd: result.costUsd };
  }

  /** Coerce the model's JSON into {@link SynthesisResult}; drop anything odd. */
  private validateSynthesis(raw: unknown): SynthesisResult {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const strArr = (v: unknown, cap: number): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s.length <= 100)
            .slice(0, cap)
        : [];
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 400) : null;

    const byPlatform = Array.isArray(obj.byPlatform)
      ? obj.byPlatform
          .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
          .map((p) => ({
            platform: typeof p.platform === 'string' ? p.platform : '',
            tone: strArr(p.tone, 6),
            themes: strArr(p.themes, 8),
          }))
          .filter((p) => p.platform)
      : [];

    return {
      tone: strArr(obj.tone, 6),
      themes: strArr(obj.themes, 8),
      vocabulary: strArr(obj.vocabulary, 10),
      callToActions: strArr(obj.callToActions, 6),
      summary: str(obj.summary),
      byPlatform,
    };
  }

  /** Row → typed result, parsing the JSON string columns. */
  private rowToResult(row: {
    id: string;
    createdAt: Date;
    projectId: string;
    domain: string;
    tone: string;
    themes: string;
    vocabulary: string;
    callToActions: string;
    summary: string | null;
    postSample: number;
    byPlatform: string;
    extraction: string;
    llmModel: string | null;
    costUsd: number;
  }): BrandVoiceResult & { id: string; createdAt: Date } {
    const strArr = (v: string): string[] => {
      try {
        const p: unknown = JSON.parse(v);
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    };
    const platformArr = (v: string): BrandVoiceByPlatform[] => {
      try {
        const p: unknown = JSON.parse(v);
        return Array.isArray(p) ? (p as BrandVoiceByPlatform[]) : [];
      } catch {
        return [];
      }
    };
    return {
      id: row.id,
      createdAt: row.createdAt,
      projectId: row.projectId,
      domain: row.domain,
      tone: strArr(row.tone),
      themes: strArr(row.themes),
      vocabulary: strArr(row.vocabulary),
      callToActions: strArr(row.callToActions),
      summary: row.summary,
      postSample: row.postSample,
      byPlatform: platformArr(row.byPlatform),
      extraction: row.extraction === 'llm-synthesized' ? 'llm-synthesized' : 'insufficient-data',
      llmModel: row.llmModel,
      costUsd: row.costUsd,
    };
  }
}
