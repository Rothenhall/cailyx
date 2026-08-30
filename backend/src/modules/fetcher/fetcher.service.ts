/**
 * Fetcher Service — The SINGLE entry point for all outbound network requests.
 *
 * Every module that needs to fetch a URL, probe with a user-agent, render a page,
 * call an API, or query an AI assistant goes through this service.
 *
 * No other module should import axios, playwright, or make HTTP requests directly.
 *
 * Capabilities:
 *   - fetch()         Raw HTTP GET/POST with custom User-Agent
 *   - probe()         Access probe: send requests with each AI bot UA, compare results
 *   - render()        Headless browser render with optional JS disabled
 *   - fetchSchema()   Extract JSON-LD structured data from a page
 *   - verifyUrl()     Resolve a URL and check identity match (for sameAs verification)
 *   - callPsiApi()    Call Google PageSpeed Insights API for Core Web Vitals
 *
 * Built-in: caching, rate limiting, retry with circuit breaker, cost tracking, logging.
 *
 * @module fetcher.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { HttpClientService } from './clients/http-client.service';
import { BrowserClientService } from './clients/browser-client.service';
import { CacheService } from './services/cache.service';
import { RateLimiterService } from './services/rate-limiter.service';
import { RetryService } from './services/retry.service';
import { CostTrackerService } from './services/cost-tracker.service';
import { PsiAdapter } from './adapters/psi.adapter';
import { BROWSER_CONTROL, getBotByName } from './fetcher.constants';
import type {
  FetchOptions,
  FetchResult,
  ProbeOptions,
  ProbeResult,
  ProbeAttempt,
  RenderOptions,
  RenderResult,
  SchemaResult,
  SchemaBlock,
  VerifyUrlOptions,
  VerifyUrlResult,
  PsiResult,
  FetchLogEntry,
} from './fetcher.types';

@Injectable()
export class FetcherService {
  private readonly logger = new Logger(FetcherService.name);
  private readonly fetchLogs: FetchLogEntry[] = [];
  private logCounter = 0;

  constructor(
    private readonly httpClient: HttpClientService,
    private readonly browserClient: BrowserClientService,
    private readonly cache: CacheService,
    private readonly rateLimiter: RateLimiterService,
    private readonly retry: RetryService,
    private readonly costTracker: CostTrackerService,
    private readonly psiAdapter: PsiAdapter,
  ) {}

  // ─── Fetch (raw HTTP) ──────────────────────────────────────────

  /**
   * Fetch a URL via HTTP with optional custom User-Agent.
   * Goes through cache → rate limiter → retry → HTTP client.
   */
  async fetch(opts: FetchOptions, calledBy: string = 'unknown', runId?: string): Promise<FetchResult> {
    const userAgent = opts.userAgent || BROWSER_CONTROL.userAgent;
    const cacheTtl = opts.cacheTtlSeconds ?? this.getDefaultCacheTtl(opts.url);

    // Check cache first
    if (!opts.bypassCache && cacheTtl > 0) {
      const cached = await this.cache.get<FetchResult>('fetch', opts.url, userAgent);
      if (cached) {
        this.log({ calledBy, runId, method: 'fetch', url: opts.url, userAgent, httpStatus: cached.status, latencyMs: 0, cost: 0, cached: true, retryCount: 0 });
        return { ...cached, cached: true };
      }
    }

    // Rate limit
    await this.rateLimiter.waitForSlot(opts.url);

    // Execute with retry
    const domain = this.getDomain(opts.url);
    const result = await this.retry.executeWithRetry(
      () => this.httpClient.fetch({ ...opts, userAgent }),
      opts.retries ?? parseInt(process.env.FETCHER_RETRY_COUNT || '3', 10),
      parseInt(process.env.FETCHER_RETRY_BACKOFF_MS || '1000', 10),
      domain,
    );

    // Cache the result
    if (cacheTtl > 0 && result.status > 0) {
      await this.cache.set('fetch', opts.url, userAgent, result, cacheTtl);
    }

    // Log
    this.log({ calledBy, runId, method: 'fetch', url: opts.url, userAgent, httpStatus: result.status, latencyMs: result.timing.latencyMs, cost: 0, cached: false, retryCount: result.retryCount });

    return result;
  }

  // ─── Probe (access probe with specific UA) ─────────────────────

  /**
   * Probe a URL with a specific AI bot User-Agent.
   * Repeats the probe N times (default 3) to distinguish deterministic blocks from rate-based ones.
   * Reports the stable (most common) status and flags inconsistency.
   */
  async probe(opts: ProbeOptions, calledBy: string = 'unknown', runId?: string): Promise<ProbeResult> {
    const repeat = opts.repeat ?? 3;
    const attempts: ProbeAttempt[] = [];

    for (let i = 0; i < repeat; i++) {
      await this.rateLimiter.waitForSlot(opts.url);

      const result = await this.retry.executeWithRetry(
        () => this.httpClient.fetch({
          url: opts.url,
          userAgent: opts.userAgent,
          method: 'GET',
          bypassCache: true, // Never cache probes — we need fresh status codes
        }),
        opts.retries ?? 2,
        1000,
        this.getDomain(opts.url),
      );

      const blocked = this.isBlockedStatus(result.status, result.body);
      attempts.push({
        attempt: i + 1,
        status: result.status,
        latencyMs: result.timing.latencyMs,
        blocked,
      });
    }

    // Determine stable status (most common)
    const statusCounts = new Map<number, number>();
    for (const a of attempts) {
      statusCounts.set(a.status, (statusCounts.get(a.status) || 0) + 1);
    }
    const stableStatus = [...statusCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const stableBlocked = this.isBlockedStatus(stableStatus);
    const inconsistent = statusCounts.size > 1;

    const avgLatency = Math.round(attempts.reduce((sum, a) => sum + a.latencyMs, 0) / attempts.length);

    this.log({
      calledBy,
      runId,
      method: 'probe',
      url: opts.url,
      userAgent: opts.userAgent,
      httpStatus: stableStatus,
      latencyMs: avgLatency,
      cost: 0,
      cached: false,
      retryCount: 0,
    });

    return {
      url: opts.url,
      botName: opts.botName,
      userAgent: opts.userAgent,
      status: stableStatus,
      blocked: stableBlocked,
      latencyMs: avgLatency,
      attempts,
      inconsistent,
    };
  }

  // ─── Render (headless browser) ─────────────────────────────────

  /**
   * Render a page with a headless browser.
   * When jsDisabled is true, blocks JS to simulate how a non-JS AI crawler sees the page.
   */
  async render(opts: RenderOptions, calledBy: string = 'unknown', runId?: string): Promise<RenderResult> {
    await this.rateLimiter.waitForSlot(opts.url);

    const result = await this.retry.executeWithRetry(
      () => this.browserClient.render(opts),
      2,
      2000,
      this.getDomain(opts.url),
    );

    this.log({
      calledBy,
      runId,
      method: 'render',
      url: opts.url,
      userAgent: 'Playwright-Chromium',
      httpStatus: result.html ? 200 : 0,
      latencyMs: result.timing.latencyMs,
      cost: 0,
      cached: false,
      retryCount: 0,
    });

    return result;
  }

  // ─── Schema (JSON-LD extraction) ───────────────────────────────

  /**
   * Fetch a page and extract JSON-LD structured data blocks.
   */
  async fetchSchema(url: string, calledBy: string = 'unknown', runId?: string): Promise<SchemaResult> {
    const fetchResult = await this.fetch({ url, cacheTtlSeconds: 3600 }, calledBy, runId);

    const schemas = this.extractJsonLd(fetchResult.body);

    return {
      url,
      schemas,
      raw: fetchResult.body,
    };
  }

  // ─── Verify URL (sameAs check) ─────────────────────────────────

  /**
   * Resolve a URL and verify its identity matches the expected entity name.
   * Used for checking sameAs links in schema markup.
   */
  async verifyUrl(opts: VerifyUrlOptions, calledBy: string = 'unknown', runId?: string): Promise<VerifyUrlResult> {
    const fetchResult = await this.fetch({
      url: opts.url,
      bypassCache: false,
      cacheTtlSeconds: 86400, // 24h — sameAs links don't change often
    }, calledBy, runId);

    const title = this.extractTitle(fetchResult.body);
    let identityMatch: boolean | undefined;

    if (opts.expectedName && title) {
      identityMatch = title.toLowerCase().includes(opts.expectedName.toLowerCase());
    }

    return {
      url: opts.url,
      finalUrl: fetchResult.finalUrl,
      resolves: fetchResult.status >= 200 && fetchResult.status < 400,
      statusCode: fetchResult.status,
      title,
      identityMatch,
      checkedAt: new Date().toISOString(),
    };
  }

  // ─── PSI (Core Web Vitals) ─────────────────────────────────────

  /**
   * Call Google PageSpeed Insights API for Core Web Vitals.
   * Costs $0 (free tier) but is rate-limited by Google.
   */
  async callPsiApi(url: string, calledBy: string = 'unknown', runId?: string): Promise<PsiResult> {
    // PSI results are cacheable for 24h
    const cached = await this.cache.get<PsiResult>('psi', url, 'psi');
    if (cached) {
      this.log({ calledBy, runId, method: 'psi', url, userAgent: 'psi-api', httpStatus: 200, latencyMs: 0, cost: 0, cached: true, retryCount: 0 });
      return { ...cached };
    }

    const result = await this.retry.executeWithRetry(
      () => this.psiAdapter.fetchPsi(url),
      2,
      3000,
      'googleapis.com',
    );

    await this.cache.set('psi', url, 'psi', result, 86400); // 24h

    this.log({
      calledBy,
      runId,
      method: 'psi',
      url,
      userAgent: 'psi-api',
      httpStatus: 200,
      latencyMs: 0,
      cost: 0,
      cached: false,
      retryCount: 0,
    });

    return result;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  /**
   * Determine if an HTTP status code indicates a block.
   * 403 = Forbidden, 401 = Unauthorized, 429 = Too Many Requests, 503 = Service Unavailable
   */
  private isBlockedStatus(status: number, body?: string): boolean {
    if (status === 403 || status === 401 || status === 429 || status === 503) return true;
    if (status === 200 && body) {
      const lower = body.toLowerCase();
      if (lower.includes('cf-challenge') || lower.includes('just a moment') ||
          lower.includes('attention required') || lower.includes('access denied')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Extract the domain from a URL for rate limiting and circuit breaking.
   */
  private getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get the default cache TTL for a URL based on its path.
   * robots.txt: 24h, homepage: 1h, other pages: 30min
   */
  private getDefaultCacheTtl(url: string): number {
    try {
      const parsed = new URL(url);
      if (parsed.pathname === '/robots.txt') return 86400; // 24h
      if (parsed.pathname === '/' || parsed.pathname === '') return 3600; // 1h
      return 1800; // 30min
    } catch {
      return 1800;
    }
  }

  /**
   * Extract JSON-LD blocks from HTML.
   */
  private extractJsonLd(html: string): SchemaBlock[] {
    const schemas: SchemaBlock[] = [];
    const regex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(html)) !== null) {
      try {
        const json = JSON.parse(match[1].trim());
        if (Array.isArray(json)) {
          for (const item of json) {
            schemas.push(this.parseSchemaBlock(item));
          }
        } else {
          schemas.push(this.parseSchemaBlock(json));
        }
      } catch {
        // Invalid JSON-LD — skip
      }
    }

    return schemas;
  }

  /**
   * Parse a single JSON-LD block into a SchemaBlock.
   */
  private parseSchemaBlock(json: any): SchemaBlock {
    const type = json['@type'] || json['@graph']?.[0]?.['@type'] || 'Unknown';
    const { '@type': _type, '@context': _context, '@graph': _graph, ...fields } = json;
    return { type, fields };
  }

  /**
   * Extract the <title> tag content from HTML.
   */
  private extractTitle(html: string): string | undefined {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match?.[1]?.trim() || undefined;
  }

  /**
   * Log a fetcher operation.
   */
  private log(entry: Omit<FetchLogEntry, 'id' | 'timestamp'>): void {
    const logEntry: FetchLogEntry = {
      ...entry,
      id: `fetch_${++this.logCounter}`,
      timestamp: new Date().toISOString(),
    };
    this.fetchLogs.push(logEntry);

    // Keep only the last 1000 logs in memory
    if (this.fetchLogs.length > 1000) {
      this.fetchLogs.shift();
    }

    this.logger.debug(
      `${entry.method} ${entry.url} [${entry.userAgent}] -> ${entry.httpStatus} (${entry.latencyMs}ms)${entry.cached ? ' [cached]' : ''}`,
    );
  }

  /**
   * Get all fetch logs (for debugging and run analysis).
   */
  getLogs(): FetchLogEntry[] {
    return [...this.fetchLogs];
  }

  /**
   * Get logs for a specific run.
   */
  getLogsByRun(runId: string): FetchLogEntry[] {
    return this.fetchLogs.filter((l) => l.runId === runId);
  }

  /**
   * Get the total cost for a run.
   */
  getRunCost(runId: string): number {
    return this.costTracker.getRunCost(runId);
  }
}
