/**
 * Perplexity (sonar) surface adapter.
 *
 * Calls the OpenAI-compatible chat-completions endpoint with the `sonar`
 * model. Perplexity's response carries a `citations` array of URLs — parsed
 * directly, deterministic.
 *
 * Uses raw HTTP (global fetch): Perplexity exposes an OpenAI wire format and
 * the project does not maintain an OpenAI client dependency.
 *
 * @module perplexity.adapter
 */

import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import type { SurfaceAdapter, SurfaceAnswer } from '../measurement.types';

const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

/** sonar pricing ≈ $1/MTok input + $1/MTok output (2026 published; cheap problem domain). */
const SONAR_PER_MTOK = 1;

@Injectable()
export class PerplexitySurfaceAdapter implements SurfaceAdapter {
  readonly name = 'perplexity' as const;

  private readonly logger = new Logger(PerplexitySurfaceAdapter.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Ask one prompt on sonar. Stateless per call — fresh session by design.
   * @throws Error (non-retryable per request) on missing key or HTTP error.
   */
  async runPrompt(prompt: string, geo: string): Promise<SurfaceAnswer> {
    const started = Date.now();
    const model = this.config.get<string>('MEASUREMENT_PERPLEXITY_MODEL', 'sonar');
    const apiKey = this.config.get<string>('PERPLEXITY_API_KEY');
    if (!apiKey) {
      throw new Error('PERPLEXITY_API_KEY is not set — cannot run perplexity surface');
    }

    const res = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`Perplexity API ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      citations?: string[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const citations = Array.isArray(body.citations) ? body.citations.filter((u) => typeof u === 'string') : [];
    const costUsd =
      (((body.usage?.prompt_tokens ?? 0) + (body.usage?.completion_tokens ?? 0)) / 1_000_000) * SONAR_PER_MTOK;

    this.logger.debug(`perplexity surface answered (${model}, ${citations.length} citations, geo=${geo})`);

    return {
      text: body.choices?.[0]?.message?.content ?? '',
      citations,
      costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - started,
      model: body.model ?? model,
    };
  }
}