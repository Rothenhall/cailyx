/**
 * PSI Adapter — Google PageSpeed Insights API v5 integration.
 *
 * Calls the PSI API for Core Web Vitals (LCP, CLS, INP) AND the full
 * Lighthouse result: every requested category's score, every non-passing
 * audit, and CrUX field data when Google has enough real-user traffic for the
 * origin.
 *
 * Note the explicit `category` parameters below. PSI v5 returns ONLY the
 * performance category when none are given — the SEO, accessibility and
 * best-practices audits simply are not in the response. Asking for all four
 * costs nothing extra (one Lighthouse run either way) and is the difference
 * between 4 numbers and ~150 audits.
 *
 * Requires a Google PSI API key set in the PSI_API_KEY environment variable.
 * Free tier: 25,000 requests/day.
 *
 * @module fetcher.psi-adapter
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type { PsiFailedAudit, PsiResult } from '../fetcher.types';

@Injectable()
export class PsiAdapter {
  private readonly logger = new Logger(PsiAdapter.name);
  private readonly apiKey: string;
  private readonly baseUrl = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

  constructor() {
    this.apiKey = process.env.PSI_API_KEY || '';
    if (!this.apiKey) {
      this.logger.warn('PSI_API_KEY not set — Core Web Vitals check will fail');
    }
  }

  /**
   * Query the PSI API for a URL's Core Web Vitals and performance score.
   *
   * @returns PsiResult with LCP, CLS, INP, and performance score (0-100)
   * @throws Error if the API key is not configured or the API call fails
   */
  async fetchPsi(url: string): Promise<PsiResult> {
    if (!this.apiKey) {
      throw new Error('PSI_API_KEY not configured — cannot fetch Core Web Vitals');
    }

    // Repeated `category` keys — axios serialises an array to
    // `category=performance&category=seo&...`, which is the form PSI expects.
    const params = {
      strategy: 'mobile',
      url,
      key: this.apiKey,
      category: ['performance', 'seo', 'accessibility', 'best-practices'],
    };

    this.logger.debug(`PSI API call for ${url}`);
    const startTime = performance.now();

    const response = await axios.get(this.baseUrl, {
      params,
      timeout: 60_000, // PSI can be slow
      validateStatus: () => true,
    });

    const latencyMs = Math.round(performance.now() - startTime);

    if (response.status !== 200) {
      const errMsg = response.data?.error?.message || `HTTP ${response.status}`;
      this.logger.warn(`PSI API failed for ${url}: ${errMsg}`);
      throw new Error(`PSI API error: ${errMsg}`);
    }

    const lighthouse = response.data?.lighthouseResult;
    if (!lighthouse) {
      throw new Error('PSI API returned no lighthouse result');
    }

    const audits = lighthouse.audits || {};
    const categories = lighthouse.categories || {};

    const result: PsiResult = {
      url,
      lcp: this.extractNumeric(audits, 'largest-contentful-paint'),
      cls: this.extractNumeric(audits, 'cumulative-layout-shift'),
      inp: this.extractNumeric(audits, 'interaction-to-next-paint'),
      performanceScore: Math.round((categories.performance?.score || 0) * 100),
      categories: this.extractCategories(categories),
      failedAudits: this.extractFailedAudits(categories, audits),
      fieldData: this.extractFieldData(response.data?.loadingExperience),
      finalUrl: lighthouse.finalUrl ?? null,
      lighthouseVersion: lighthouse.lighthouseVersion ?? null,
      raw: response.data,
    };

    this.logger.log(
      `PSI result for ${url}: ` +
        Object.entries(result.categories).map(([k, v]) => `${k}=${v}`).join(' ') +
        ` LCP=${result.lcp}ms CLS=${result.cls} INP=${result.inp}ms ` +
        `${result.failedAudits.length} failing audits (${latencyMs}ms)`,
    );

    return result;
  }

  /**
   * Extract a numeric value from a Lighthouse audit.
   * Handles the nested structure of PSI API responses.
   */
  private extractNumeric(audits: Record<string, any>, auditKey: string): number {
    const audit = audits[auditKey];
    if (!audit) return -1;

    // All CWV metrics (LCP, CLS, INP) use numericValue — never fall back to score.
    // score is a 0-1 pass/fail rating, NOT the actual metric value.
    if (typeof audit.numericValue === 'number') {
      return Math.round(audit.numericValue * 1000) / 1000; // Round CLS to 3 decimals, LCP/INP to ms
    }

    return -1;
  }

  /** Category scores as whole numbers, 0-100. */
  private extractCategories(categories: Record<string, any>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, cat] of Object.entries(categories)) {
      if (cat && typeof cat.score === 'number') out[key] = Math.round(cat.score * 100);
    }
    return out;
  }

  /**
   * Flatten every non-passing audit across the requested categories.
   *
   * Lighthouse scores an audit 0-1, with null meaning "informational, not
   * scored". Only genuinely scored audits below 1 are failures — treating null
   * as a failure would report a wall of notices as problems.
   */
  private extractFailedAudits(
    categories: Record<string, any>,
    audits: Record<string, any>,
  ): PsiFailedAudit[] {
    const out: PsiFailedAudit[] = [];
    const seen = new Set<string>();

    for (const [categoryKey, cat] of Object.entries(categories)) {
      for (const ref of cat?.auditRefs ?? []) {
        const a = audits[ref.id];
        if (!a || typeof a.score !== 'number' || a.score >= 1) continue;
        if (seen.has(ref.id)) continue;
        seen.add(ref.id);
        out.push({
          id: ref.id,
          title: a.title ?? ref.id,
          category: categoryKey,
          score: a.score,
          description: this.stripLinks(a.description ?? ''),
          displayValue: a.displayValue ?? '',
        });
      }
    }

    // Worst first, so a truncated render still shows what matters.
    return out.sort((x, y) => (x.score ?? 1) - (y.score ?? 1));
  }

  /**
   * Lighthouse descriptions are markdown with trailing doc links. Strip the
   * links so the text is renderable anywhere without a markdown parser.
   */
  private stripLinks(md: string): string {
    return md
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * CrUX field data — real users, not the lab run. Absent for low-traffic
   * origins, which is normal and not an error.
   */
  private extractFieldData(
    loadingExperience: any,
  ): Record<string, { percentile: number; category: string }> | null {
    const metrics = loadingExperience?.metrics;
    if (!metrics || typeof metrics !== 'object') return null;
    const out: Record<string, { percentile: number; category: string }> = {};
    for (const [key, m] of Object.entries<any>(metrics)) {
      if (typeof m?.percentile === 'number') {
        out[key] = { percentile: m.percentile, category: m.category ?? 'UNKNOWN' };
      }
    }
    return Object.keys(out).length ? out : null;
  }
}