/**
 * Rate Limiter Service — Per-domain and global HTTP request rate limiting.
 *
 * Prevents Cailyx from hammering client sites. Uses Redis for distributed tracking.
 * If rate limited, the caller waits (does not fail) until the rate window allows the request.
 * If Redis is unavailable, rate limiting is silently skipped.
 *
 * @module fetcher.rate-limiter
 */

import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private redis: Redis | null = null;
  private connected = false;

  /** Minimum milliseconds between requests to the same domain */
  private readonly perDomainMs: number;
  /** Maximum requests per second across all domains */
  private readonly globalPerSec: number;

  constructor() {
    this.perDomainMs = parseInt(process.env.FETCHER_RATE_LIMIT_PER_DOMAIN_MS || '3000', 10);
    this.globalPerSec = parseInt(process.env.FETCHER_RATE_LIMIT_GLOBAL_PER_SEC || '10', 10);
    this.init();
  }

  private init(): void {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6380';
    try {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        retryStrategy: (times) => Math.min(times * 500, 2000),
      });

      this.redis.on('connect', () => {
        this.connected = true;
        this.logger.log('Rate limiter Redis connected');
      });

      this.redis.on('error', () => {
        this.connected = false;
      });
    } catch {
      this.redis = null;
    }
  }

  /**
   * Extract the domain from a URL.
   */
  private getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Wait until the rate limit allows a request to the given URL.
   * Uses Redis to track last-request time per domain and a global counter.
   * Falls back to in-memory tracking if Redis is unavailable.
   */
  async waitForSlot(url: string): Promise<void> {
    const domain = this.getDomain(url);

    if (!this.redis || !this.connected) {
      // In-memory fallback
      await this.inMemoryWait(domain);
      return;
    }

    try {
      // Per-domain rate limit
      const domainKey = `ratelimit:domain:${domain}`;
      const lastRequest = await this.redis.get(domainKey);
      if (lastRequest) {
        const elapsed = Date.now() - parseInt(lastRequest, 10);
        const waitMs = this.perDomainMs - elapsed;
        if (waitMs > 0) {
          this.logger.debug(`Rate limit: waiting ${waitMs}ms for domain ${domain}`);
          await this.sleep(waitMs);
        }
      }

      // Global rate limit (sliding window)
      const globalKey = `ratelimit:global`;
      const count = await this.redis.incr(globalKey);
      if (count === 1) {
        await this.redis.expire(globalKey, 1);
      }
      if (count > this.globalPerSec) {
        await this.sleep(1000);
      }

      // Record this request
      await this.redis.set(domainKey, Date.now(), 'PX', this.perDomainMs * 2);
    } catch (err) {
      // Redis error — fall back to in-memory
      this.logger.debug(`Rate limit Redis error, using in-memory: ${(err as Error).message}`);
      await this.inMemoryWait(domain);
    }
  }

  /** Simple in-memory rate limiter fallback */
  private lastRequestTimes = new Map<string, number>();

  private async inMemoryWait(domain: string): Promise<void> {
    const last = this.lastRequestTimes.get(domain);
    if (last) {
      const elapsed = Date.now() - last;
      const waitMs = this.perDomainMs - elapsed;
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
    }
    this.lastRequestTimes.set(domain, Date.now());
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}