/**
 * Page Analysis Service — SOP-6 copy-structure analysis (FR-3.3).
 *
 * Fetches a URL (FetcherModule) and runs a strictly deterministic
 * extractability pipeline over the HTML with cheerio:
 *   - BLUF: is the answer stated in the first 40–60 words?
 *   - question-shaped H2 share
 *   - standalone-section heuristic (H2 mentions the page topic or is self-descriptive)
 *   - extractable claims: number + noun + timeframe (+ source)
 *   - format analysis: tables / ordered lists / definition blocks
 *
 * Scores come ONLY from this deterministic path (reproducible, per the 3×
 * determinism rule). The optional `useLlm` flag adds a Claude refinement pass
 * stored as `llmNotes` — it never feeds the score.
 *
 * @module page-analysis.service
 */

import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { FetcherService } from '../fetcher/fetcher.service';
import { PrismaService } from '../database/prisma.service';
import type { ExtractableClaim, FormatFindings, HeadingInfo, StructureScore } from './page-analysis.types';

/** Disclosed subscore weights (sum to 100 — never renormalized, FR-8.4 spirit). */
const WEIGHTS = { bluf: 30, questionH2: 25, format: 25, claims: 20 } as const;

/** SOP-6 BLUF window: the first-paragraph answer must land in 40–60 words. */
const BLUF_MIN_WORDS = 40;
const BLUF_MAX_WORDS = 60;

/** Claim pattern: number + noun, and (soft) a timeframe or source cue. */
const CLAIM_NUMBER = /(\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%|\b\d[\d,.]{1,}\b|\b(?:ten|twenty|hundreds|thousands|millions)\b)/i;
const CLAIM_TIMEFRAME = /(\b20\d{2}\b|\b(?:Q[1-4])\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:last|past|next)\s+(?:year|quarter|month|week|days?)\b|\bannual(?:ly)?\b|\bmonthly\b|\bweekly\b|\bper\s+year\b)/i;
const CLAIM_SOURCE = /(\baccording to\b|\bper\b\s+\w|\bsurvey\b|\bstudy\b|\breport(ed)?\b|\bdata\s+from\b|\bresearch\b|\bcensus\b|\bbased on\b)/i;

const QUESTION_STARTERS = /^(what|why|how|when|where|which|who|can|do|does|is|are|should)\b/i;
const QUESTION_TRAIL = /\?\s*$/;

@Injectable()
export class PageAnalysisService {
  private readonly logger = new Logger(PageAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: FetcherService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Analyze a URL deterministically; optionally refine with Claude (`useLlm`).
   * One persisted PageAnalysis row per call (history is a feature — re-analysis
   * after a restructure must be comparable).
   */
  async analyze(projectId: string, rawUrl: string, useLlm = false) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Invalid URL: ' + rawUrl);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('URL must be http(s): ' + rawUrl);
    }

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const result = await this.fetcher.fetch({ url: rawUrl }, 'page-analysis');
    if (result.status < 200 || result.status >= 300 || !result.body) {
      const failed = await this.prisma.pageAnalysis.create({
        data: { projectId, url: rawUrl, status: 'fetch-failed' },
      });
      return { ...failed, analysis: null, fetchStatus: result.status };
    }

    const analyzed = this.analyzeHtml(result.body);

    const llmNotes = useLlm ? await this.generateLlmNotes(analyzed) : null;

    const row = await this.prisma.pageAnalysis.create({
      data: {
        projectId,
        url: rawUrl,
        title: analyzed.title,
        wordCount: analyzed.wordCount,
        blufScore: analyzed.score.bluf,
        questionH2Score: analyzed.score.questionH2,
        formatScore: analyzed.score.format,
        claimsScore: analyzed.score.claims,
        structureScore: analyzed.score.total,
        blufText: analyzed.blufText,
        headingStructure: JSON.stringify(analyzed.headings),
        extractableClaims: JSON.stringify(analyzed.claims),
        formatFindings: JSON.stringify(analyzed.format),
        llmNotes,
        fetchedAt: new Date(),
        status: 'complete',
      },
    });
    this.logger.log('Page analysis for ' + rawUrl + ': structureScore=' + analyzed.score.total + '/100');
    return { ...row, analysis: analyzed, fetchStatus: result.status };
  }

  /** History for a project, newest first (scoring picks the best/latest). */
  async list(projectId: string) {
    return this.prisma.pageAnalysis.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  /** One analysis (ownership-checked). */
  async getOne(projectId: string, analysisId: string) {
    const row = await this.prisma.pageAnalysis.findUnique({ where: { id: analysisId } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException('Page analysis not found in this project: ' + analysisId);
    }
    return row;
  }

  /**
   * Deterministic HTML analysis (pure function of the fetched body).
   */
  private analyzeHtml(html: string) {
    const $ = cheerio.load(html);
    const title = $('title').text().trim() || null;
    $('script, style, nav, footer, header').remove();

    // ── Text body + word count ───────────────────────────────────
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const words = bodyText.split(' ').filter(Boolean);
    const wordCount = words.length;

    // ── BLUF: first paragraph in the 40–60 word window (or whole-lead short answer) ──
    const firstParaText = $('p').first().text().replace(/\s+/g, ' ').trim();
    const paraWords = firstParaText.split(' ').filter(Boolean).length;
    const blufText = firstParaText || null;
    let bluf = 0;
    if (paraWords >= 10 && paraWords <= BLUF_MAX_WORDS) {
      // A short lead paragraph that opens with an answer-shaped statement.
      bluf = paraWords >= 12 ? WEIGHTS.bluf : Math.round(WEIGHTS.bluf / 2);
      if (paraWords < BLUF_MIN_WORDS && paraWords < 25) bluf = WEIGHTS.bluf; // crisp 1-line BLUF is ideal
    } else if (paraWords > BLUF_MAX_WORDS) {
      bluf = Math.max(0, WEIGHTS.bluf - Math.min(20, Math.floor((paraWords - BLUF_MAX_WORDS) / 20) * 5));
    }

    // ── Question-shaped H2s ──────────────────────────────────────
    const h2s: string[] = [];
    $('h2').each((_, el) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) h2s.push(t);
    });
    const questionH2s = h2s.filter((t) => QUESTION_STARTERS.test(t) || QUESTION_TRAIL.test(t));
    const questionShare = h2s.length > 0 ? questionH2s.length / h2s.length : 0;
    const questionH2 = Math.round(WEIGHTS.questionH2 * questionShare);

    // ── Standalone heuristic per H2 section ──────────────────────
    const headings: HeadingInfo[] = h2s.map((t) => {
      const questionShaped = QUESTION_STARTERS.test(t) || QUESTION_TRAIL.test(t);
      // Standalone if the H2 names the topic explicitly (pronoun-free, not
      // "It"/"This/These" alone) or is a question — either can be lifted out
      // of context and still describe the section.
      const generic = /^(it|this|these|those|more|also|final|conclusion|next steps)\b/i.test(t);
      const standalone = !generic && (questionShaped || t.split(' ').length >= 3);
      const standaloneReason = generic
        ? 'Generic/anaphoric heading — loses meaning out of context'
        : standalone
          ? 'Self-descriptive heading (topic-named or question)'
          : 'Too terse to describe the section out of context';
      return { level: 2, text: t, questionShaped, standalone, standaloneReason };
    });

    // ── Format analysis ──────────────────────────────────────────
    const format: FormatFindings = {
      tables: $('table').length,
      orderedLists: $('ol > li').length,
      definitionBlocks: $('dl').length + $('dfn').length,
    };
    let formatScore = 0;
    if (format.tables > 0) formatScore += 10;
    if (format.orderedLists >= 3) formatScore += 10;
    else if (format.orderedLists > 0) formatScore += 5;
    if (format.definitionBlocks > 0) formatScore += 5;
    formatScore = Math.min(WEIGHTS.format, formatScore);

    // ── Extractable claims ───────────────────────────────────────
    const claims: ExtractableClaim[] = [];
    const seen = new Set<string>();
    $('p, td, li').each((_, el) => {
      if (claims.length >= 20) return;
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (!t || t.length > 400 || seen.has(t)) return;
      if (CLAIM_NUMBER.test(t)) {
        seen.add(t);
        claims.push({
          text: t.slice(0, 300),
          hasNumber: true,
          hasTimeframe: CLAIM_TIMEFRAME.test(t),
          hasSource: CLAIM_SOURCE.test(t),
        });
      }
    });
    const sourced = claims.filter((c) => c.hasTimeframe || c.hasSource).length;
    const claimShare = claims.length > 0 ? Math.min(1, sourced / Math.min(claims.length, 8)) : 0;
    const claimsScore = Math.round(WEIGHTS.claims * Math.min(1, sourced / 5) * (claims.length > 0 ? 1 : 0));

    const score: StructureScore = {
      bluf,
      questionH2,
      format: formatScore,
      claims: claimsScore,
      total: bluf + questionH2 + formatScore + claimsScore,
    };

    return { title, wordCount, blufText, headings, claims, format, score };
  }

  /**
   * Optional Claude refinement — stored as `llmNotes` text, never scored.
   * @throws ServiceUnavailableException when useLlm requested without a key.
   */
  private async generateLlmNotes(analyzed: {
    title: string | null;
    blufText: string | null;
    headings: HeadingInfo[];
    claims: ExtractableClaim[];
    wordCount: number;
  }): Promise<string> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'useLlm requested but no ANTHROPIC_API_KEY configured — the deterministic analysis was NOT persisted; re-run without useLlm or set the key.',
      );
    }
    const client = new Anthropic({ apiKey });
    const prompt =
      'Section headings from a page (title: ' + (analyzed.title ?? 'unknown') + '):\n' +
      analyzed.headings.map((h) => (h.standalone ? 'OK  ' : 'BAD ') + h.text).join('\n') +
      '\n\nFirst paragraph: ' + (analyzed.blufText ?? '(none)') +
      '\n\nWord count: ' + analyzed.wordCount +
      '\n\nIn at most 12 bullet lines: (1) which "BAD" headings read fine standalone anyway and which genuinely do not, (2) one BLUF rewrite suggestion (<=55 words) if the first paragraph buries the answer, (3) which claims lack a timeframe or source (quote them). Plain text bullets only.';
    try {
      const msg = await client.messages.create({
        model: process.env.FINDINGS_MODEL || 'claude-opus-5',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = msg.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('')
        .trim();
      return text || 'LLM returned no text';
    } catch (err) {
      this.logger.warn('LLM refinement failed: ' + (err as Error).message);
      return 'LLM refinement failed: ' + (err as Error).message;
    }
  }
}