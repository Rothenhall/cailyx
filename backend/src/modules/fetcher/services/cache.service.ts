/**
 * Cache Service — Redis-backed response cache for the fetcher module.
 *
 * Caches HTTP responses to avoid redundant fetches. TTL is configurable per request.
 * If Redis is unavailable, caching is silently skipped (fetcher still works).
 *
 * @module fetcher.cache
 */

import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private connected = false;

  constructor() {
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
        this.logger.log('Redis cache connected');
      });

      this.redis.on('error', (err) => {
        if (this.connected) {
          this.logger.warn(`Redis cache error: ${err.message} — caching will be skipped`);
        }
        this.connected = false;
      });
    } catch (err) {
      this.logger.warn(`Redis init failed — caching disabled: ${(err as Error).message}`);
      this.redis = null;
    }
  }

  /**
   * Build a cache key from method + URL + userAgent.
   */
  /**
   * Cache key.
   *
   * `variant` exists because a POST body is part of a request's identity. Every
   * DataForSEO call goes to the *same* URL with the keyword in the body, so a
   * key of (url, userAgent) alone made every SERP request inside the TTL return
   * the first keyword's results — wrong data that looks like working data. Any
   * caller sending a body must pass one.
   */
  private buildKey(method: string, url: string, userAgent: string, variant?: string): string {
    const base = `fetcher:${method}:${Buffer.from(url).toString('base64url')}:${Buffer.from(userAgent).toString('base64url')}`;
    return variant ? `${base}:${variant}` : base;
  }

  /**
   * Retrieve a cached value. Returns null if not found or Redis unavailable.
   */
  async get<T>(method: string, url: string, userAgent: string, variant?: string): Promise<T | null> {
    if (!this.redis || !this.connected) return null;
    try {
      const key = this.buildKey(method, url, userAgent, variant);
      const data = await this.redis.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err) {
      this.logger.debug(`Cache get failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Store a value in cache with a TTL in seconds.
   * TTL of 0 means don't cache.
   */
  async set(
    method: string,
    url: string,
    userAgent: string,
    value: unknown,
    ttlSeconds: number,
    variant?: string,
  ): Promise<void> {
    if (!this.redis || !this.connected || ttlSeconds <= 0) return;
    try {
      const key = this.buildKey(method, url, userAgent, variant);
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      this.logger.debug(`Cache set failed: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a cached value.
   */
  async del(method: string, url: string, userAgent: string, variant?: string): Promise<void> {
    if (!this.redis || !this.connected) return;
    try {
      const key = this.buildKey(method, url, userAgent, variant);
      await this.redis.del(key);
    } catch (err) {
      this.logger.debug(`Cache del failed: ${(err as Error).message}`);
    }
  }

  /**
   * Check if Redis is connected and operational.
   */
  isAvailable(): boolean {
    return this.connected;
  }
}