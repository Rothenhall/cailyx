/**
 * HTTP Client Service — Raw HTTP fetch via axios with User-Agent support.
 *
 * Handles all plain HTTP requests for the fetcher module.
 * Supports custom User-Agent strings (for AI bot probing), redirects, and timeouts.
 * Includes SSRF guard to prevent requests to private/internal IP ranges.
 *
 * @module fetcher.http-client
 */

import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { BROWSER_CONTROL } from '../fetcher.constants';
import type { FetchOptions, FetchResult } from '../fetcher.types';

@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: 30_000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  }

  /**
   * Fetch a URL via HTTP with optional custom User-Agent.
   *
   * @returns FetchResult with status, headers, body, and timing
   */
  async fetch(opts: FetchOptions): Promise<FetchResult> {
    const userAgent = opts.userAgent || BROWSER_CONTROL.userAgent;
    const timeout = opts.timeout || parseInt(process.env.FETCHER_TIMEOUT_MS || '30000', 10);
    const method = opts.method || 'GET';

    // SSRF guard — block private/internal IPs
    if (this.isPrivateUrl(opts.url)) {
      this.logger.warn(`SSRF blocked: ${opts.url}`);
      return {
        url: opts.url, finalUrl: opts.url, status: 0, statusText: 'SSRF blocked',
        headers: {}, body: '', timing: { latencyMs: 0 }, userAgent, cached: false, retryCount: 0,
      };
    }

    const config: AxiosRequestConfig = {
      url: opts.url,
      method,
      headers: { ...opts.headers, 'User-Agent': userAgent },
      timeout,
      maxRedirects: 5,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(data) => data],
    };

    if (opts.body && method !== 'GET') {
      config.data = opts.body;
    }

    const startTime = performance.now();
    let retryCount = 0;

    try {
      const response: AxiosResponse = await this.client.request(config);
      const latencyMs = Math.round(performance.now() - startTime);

      return {
        url: opts.url,
        finalUrl: response.config.url || opts.url,
        status: response.status,
        statusText: response.statusText,
        headers: this.normalizeHeaders(response.headers),
        body: typeof response.data === 'string' ? response.data : String(response.data),
        timing: { latencyMs },
        userAgent,
        cached: false,
        retryCount,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now() - startTime);
      this.logger.debug(`HTTP ${method} ${opts.url} failed after ${latencyMs}ms: ${(err as Error).message}`);

      return {
        url: opts.url, finalUrl: opts.url, status: 0, statusText: (err as Error).message,
        headers: {}, body: '', timing: { latencyMs }, userAgent, cached: false, retryCount,
      };
    }
  }

  /**
   * SSRF guard — blocks requests to private/internal IP ranges.
   * Prevents the public form from being used to scan internal networks.
   */
  private isPrivateUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
      if (host.startsWith('10.') || host.startsWith('172.16.') || host.startsWith('172.17.') ||
          host.startsWith('172.18.') || host.startsWith('172.19.') || host.startsWith('172.2') ||
          host.startsWith('172.30.') || host.startsWith('172.31.') || host.startsWith('192.168.')) return true;
      if (host.startsWith('169.254.')) return true;
      if (host === 'metadata.google.internal') return true;
      if (host === '0.0.0.0') return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Normalize axios response headers into a simple Record.
   */
  private normalizeHeaders(headers: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (headers && typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (value !== undefined && value !== null) {
          result[key.toLowerCase()] = String(value);
        }
      }
    }
    return result;
  }
}