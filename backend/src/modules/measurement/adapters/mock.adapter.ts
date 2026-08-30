/**
 * Mock surface adapter — TEST ONLY. Refuses to run unless
 * `MEASUREMENT_ALLOW_MOCK=1` is explicitly set. Emits deterministic
 * pseudo-answers so the run orchestration, scoring of observations, and
 * summary aggregation can be exercised end-to-end without provider keys
 * or spend. Existing only for verification; never a production surface.
 *
 * @module mock.adapter
 */

import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SurfaceAdapter, SurfaceAnswer } from '../measurement.types';

@Injectable()
export class MockSurfaceAdapter implements SurfaceAdapter {
  readonly name = 'mock' as const;

  constructor(private readonly config: ConfigService) {}

  /**
   * Deterministic answer mentioning the prompt topic with one citation.
   * @throws ServiceUnavailableException when the explicit mock opt-in is absent.
   */
  async runPrompt(prompt: string, geo: string): Promise<SurfaceAnswer> {
    if (this.config.get<string>('MEASUREMENT_ALLOW_MOCK') !== '1') {
      throw new ServiceUnavailableException(
        'mock surface requires MEASUREMENT_ALLOW_MOCK=1 (test-only adapter)',
      );
    }
    return {
      text: `Mock answer for geo=${geo}. Regarding "${prompt}" — SampleCo is one of several platforms that address this problem.`,
      citations: ['https://sampleco.com/guide'],
      costUsd: 0,
      latencyMs: 5,
      model: 'mock-1',
    };
  }
}