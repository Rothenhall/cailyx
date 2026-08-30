/**
 * PSI Adapter — Google PageSpeed Insights API v5 integration.
 *
 * Calls the PSI API to retrieve Core Web Vitals (LCP, CLS, INP) and
 * the overall performance score for a given URL.
 *
 * Requires a Google PSI API key set in the PSI_API_KEY environment variable.
 * Free tier: 25,000 requests/day.
 *
 * @module fetcher.psi-adapter
 */

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type { PsiResult } from '../fetcher.types';

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

    const params = {
      strategy: 'mobile',
      url,
      key: this.apiKey,
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

    const result: PsiResult = {
      url,
      lcp: this.extractNumeric(audits, 'largest-contentful-paint'),
      cls: this.extractNumeric(audits, 'cumulative-layout-shift'),
      inp: this.extractNumeric(audits, 'interaction-to-next-paint'),
      performanceScore: Math.round((lighthouse.categories?.performance?.score || 0) * 100),
      raw: response.data,
    };

    this.logger.log(
      `PSI result for ${url}: Score=${result.performanceScore} LCP=${result.lcp}ms CLS=${result.cls} INP=${result.inp}ms (${latencyMs}ms)`,
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
}