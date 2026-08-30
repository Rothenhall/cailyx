/**
 * Anthropic (Claude) surface adapter.
 *
 * Asks the buyer question of Claude with the server-side web-search tool
 * enabled — the closest clean programmatic proxy for "an operator asks
 * Claude". Citations are the URL list from `web_search_tool_result` blocks
 * (server-side, deterministic — no scraping).
 *
 * Cost: conservative estimate from response.usage at Opus-tier published
 * rates; per-model pricing refinement can be layered on later.
 *
 * @module anthropic.adapter
 */

import Anthropic from '@anthropic-ai/sdk';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger } from '@nestjs/common';
import type { SurfaceAdapter, SurfaceAnswer } from '../measurement.types';

/** Fallback $/MTok rates for cost accounting (Opus tier). */
const OPUS_INPUT_PER_MTOK = 5;
const OPUS_OUTPUT_PER_MTOK = 25;

@Injectable()
export class AnthropicSurfaceAdapter implements SurfaceAdapter {
  readonly name = 'claude' as const;

  private readonly logger = new Logger(AnthropicSurfaceAdapter.name);
  private client: Anthropic | undefined;

  constructor(private readonly config: ConfigService) {}

  /**
   * Ask one prompt with web search. Fresh context every call (PRD FR-6.2
   * fresh sessions) because the API is stateless.
   */
  async runPrompt(prompt: string, geometry: string): Promise<SurfaceAnswer> {
    void geometry; // geo steering per run arrives with proxy egress; inference found on default region for now
    const started = Date.now();
    const model = this.config.get<string>('MEASUREMENT_CLAUDE_MODEL', 'claude-opus-5');

    const response = await this.ensureClient().messages.create({
      model,
      max_tokens: 4000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: prompt }],
    });

    // Collect answer text and cited URLs from the content blocks.
    const textParts: string[] = [];
    const citations: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (
            item &&
            typeof item === 'object' &&
            (item as { type?: string }).type === 'web_search_result' &&
            typeof (item as { url?: unknown }).url === 'string'
          ) {
            citations.push((item as { url: string }).url);
          }
        }
      }
    }

    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const costUsd =
      (inputTokens / 1_000_000) * OPUS_INPUT_PER_MTOK + (outputTokens / 1_000_000) * OPUS_OUTPUT_PER_MTOK;

    this.logger.debug(`claude surface answered (${model}, ${textParts.join('').length} chars, ${citations.length} citations)`);

    return {
      text: textParts.join('\n'),
      citations,
      costUsd: Number(costUsd.toFixed(6)),
      latencyMs: Date.now() - started,
      model,
    };
  }

  /** Lazily construct the SDK client so a missing key only fails when used. */
  private ensureClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: this.config.get<string>('ANTHROPIC_API_KEY') || undefined,
      });
    }
    return this.client;
  }
}