/**
 * Retry Service — Exponential backoff with circuit breaker.
 *
 * Wraps async operations with configurable retry logic.
 * Includes a per-domain circuit breaker that pauses after consecutive failures.
 *
 * @module fetcher.retry
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CircuitBreakerState } from '../fetcher.types';

@Injectable()
export class RetryService {
  private readonly logger = new Logger(RetryService.name);
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();

  /** Number of consecutive failures before opening the circuit */
  private readonly failureThreshold = 5;
  /** How long to keep the circuit open (ms) */
  private readonly openDurationMs = 60_000;

  /**
   * Execute a function with retry + exponential backoff.
   *
   * @param fn - The async function to execute
   * @param retries - Number of retry attempts (default 3)
   * @param backoffMs - Initial backoff in ms, doubles each retry (default 1000)
   * @param domain - Domain for circuit breaker tracking (optional)
   * @returns The result of fn
   * @throws The last error if all retries fail or circuit is open
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    retries: number = 3,
    backoffMs: number = 1000,
    domain?: string,
  ): Promise<T> {
    // Check circuit breaker
    if (domain && this.isCircuitOpen(domain)) {
      throw new Error(`Circuit breaker open for domain ${domain} — too many consecutive failures`);
    }

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= retries) {
      try {
        const result = await fn();
        // Success — reset circuit breaker
        if (domain) this.recordSuccess(domain);
        return result;
      } catch (err) {
        lastError = err as Error;
        attempt++;

        if (attempt <= retries) {
          const waitMs = backoffMs * Math.pow(2, attempt - 1);
          this.logger.debug(
            `Retry ${attempt}/${retries} after ${waitMs}ms — ${(err as Error).message}`,
          );
          await this.sleep(waitMs);
        }
      }
    }

    // All retries failed
    if (domain) this.recordFailure(domain);
    throw lastError || new Error('Retry exhausted with unknown error');
  }

  /**
   * Check if the circuit breaker is open for a domain.
   */
  private isCircuitOpen(domain: string): boolean {
    const breaker = this.circuitBreakers.get(domain);
    if (!breaker || !breaker.isOpen) return false;

    // Check if the open duration has elapsed — half-open state
    if (breaker.openedAt && Date.now() - breaker.openedAt > this.openDurationMs) {
      breaker.isOpen = false;
      breaker.failures = 0;
      this.logger.log(`Circuit breaker half-open for domain ${domain}`);
      return false;
    }

    return true;
  }

  /**
   * Record a successful request — resets the circuit breaker for the domain.
   */
  private recordSuccess(domain: string): void {
    const breaker = this.circuitBreakers.get(domain);
    if (breaker) {
      breaker.failures = 0;
      breaker.isOpen = false;
      breaker.openedAt = undefined;
    }
  }

  /**
   * Record a failed request — increments failure count and may open the circuit.
   */
  private recordFailure(domain: string): void {
    let breaker = this.circuitBreakers.get(domain);
    if (!breaker) {
      breaker = { domain, failures: 0, isOpen: false };
      this.circuitBreakers.set(domain, breaker);
    }

    breaker.failures++;
    breaker.lastFailureAt = Date.now();

    if (breaker.failures >= this.failureThreshold && !breaker.isOpen) {
      breaker.isOpen = true;
      breaker.openedAt = Date.now();
      this.logger.warn(
        `Circuit breaker OPEN for domain ${domain} after ${breaker.failures} consecutive failures — pausing for ${this.openDurationMs / 1000}s`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}