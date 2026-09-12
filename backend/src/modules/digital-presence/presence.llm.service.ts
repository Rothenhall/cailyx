/**
 * Presence LLM Service — the one constrained-JSON caller this module's
 * analysis passes use (today: brand-voice synthesis).
 *
 * Same shape and provider convention as `aeo-audit/aeo-llm.service.ts`
 * (OpenRouter preferred, Anthropic fallback), kept as its own small copy
 * rather than a cross-module import — every module in this codebase owns its
 * own LLM caller (`aeo-llm.service.ts`, `technical-audit/checks/audit-
 * narrative.service.ts`), so a module can be read, tested and reasoned about
 * without following an import into a sibling module's internals.
 *
 * @module presence.llm.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Same benchmarked default as `aeo-llm.service.ts` — an extraction/classification
 *  job, not a writing job, so a small cheap model is the right tool. */
const DEFAULT_OPENROUTER_MODEL = 'qwen/qwen3-30b-a3b-instruct-2507';

/** Fallback $/MTok when Anthropic is used and no live cost is reported. */
const ANTHROPIC_INPUT_PER_MTOK = 5;
const ANTHROPIC_OUTPUT_PER_MTOK = 25;

export type LlmProvider = 'openrouter' | 'anthropic';

/** One constrained-JSON request. */
export interface LlmJsonRequest {
  /** Instructions + the exact JSON shape required. */
  system: string;
  /** The payload to analyse. */
  user: string;
  maxTokens: number;
  /** Label used in logs so a slow or failing pass is identifiable. */
  purpose: string;
}

export interface LlmJsonResult<T> {
  data: T;
  model: string;
  provider: LlmProvider;
  /** Real charge for this call when the provider reports one; else estimated. */
  costUsd: number;
  costIsReported: boolean;
}

@Injectable()
export class PresenceLlmService {
  private readonly logger = new Logger(PresenceLlmService.name);
  private anthropic: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Is any provider configured? Callers report honestly rather than guessing. */
  isAvailable(): boolean {
    return this.provider() !== null;
  }

  /** Which provider will be used, or null when none is configured. */
  provider(): LlmProvider | null {
    if (this.config.get<string>('OPENROUTER_API_KEY')) return 'openrouter';
    if (this.config.get<string>('ANTHROPIC_API_KEY')) return 'anthropic';
    return null;
  }

  /** The model that will actually run, for logging and provenance records. */
  modelName(): string {
    return this.provider() === 'openrouter'
      ? this.config.get<string>('PRESENCE_LLM_MODEL', DEFAULT_OPENROUTER_MODEL)
      : this.config.get<string>('PRESENCE_LLM_ANTHROPIC_MODEL', 'claude-opus-5');
  }

  /**
   * Ask for JSON and hand the parsed value to a validator.
   *
   * The validator is the trust boundary: it coerces whatever came back into the
   * caller's shape and drops anything unexpected, so a sloppy model cannot widen
   * a type. Callers decide what a failure means — nothing here invents a result.
   *
   * @throws Error when no provider is configured, the call fails, or the
   *   response is not parseable JSON.
   */
  async json<T>(req: LlmJsonRequest, validate: (raw: unknown) => T): Promise<LlmJsonResult<T>> {
    const provider = this.provider();
    if (!provider) {
      throw new Error(
        'No LLM provider configured — set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY',
      );
    }
    return provider === 'openrouter' ? this.viaOpenRouter(req, validate) : this.viaAnthropic(req, validate);
  }

  // ─── OpenRouter ────────────────────────────────────────────────────────

  private async viaOpenRouter<T>(req: LlmJsonRequest, validate: (raw: unknown) => T): Promise<LlmJsonResult<T>> {
    const apiKey = this.config.getOrThrow<string>('OPENROUTER_API_KEY');
    const model = this.config.get<string>('PRESENCE_LLM_MODEL', DEFAULT_OPENROUTER_MODEL);
    const timeoutMs = Number(this.config.get<string>('PRESENCE_LLM_TIMEOUT_MS', '60000'));

    // Without this a hung request stalls the whole synthesis pass.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    let body: {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number };
      model?: string;
      error?: { message?: string };
    };
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        signal: abort.signal,
        headers: {
          Authorization: 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'HTTP-Referer': this.config.get<string>('AEO_LLM_REFERER', 'https://cailyx.local'),
          'X-Title': 'Cailyx Digital Presence',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          // Deterministic: the same captions must produce the same voice read
          // on a re-run, or a re-run reads as the brand's voice changing.
          temperature: 0,
          response_format: { type: 'json_object' },
          usage: { include: true },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
      }
      body = JSON.parse(text) as typeof body;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`OpenRouter timed out after ${timeoutMs}ms (${req.purpose})`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (body.error?.message) throw new Error('OpenRouter: ' + body.error.message);

    const content = body.choices?.[0]?.message?.content ?? '';
    const parsed = this.parseJson(content, req.purpose);

    const reported = typeof body.usage?.cost === 'number';
    const costUsd = reported ? Number(body.usage!.cost!.toFixed(8)) : 0;

    return {
      data: validate(parsed),
      model: body.model ?? model,
      provider: 'openrouter',
      costUsd,
      costIsReported: reported,
    };
  }

  // ─── Anthropic (fallback) ──────────────────────────────────────────────

  private async viaAnthropic<T>(req: LlmJsonRequest, validate: (raw: unknown) => T): Promise<LlmJsonResult<T>> {
    const model = this.config.get<string>('PRESENCE_LLM_ANTHROPIC_MODEL', 'claude-opus-5');
    const response = await this.ensureAnthropic().messages.create({
      model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const parsed = this.parseJson(content, req.purpose);

    const inTok = response.usage?.input_tokens ?? 0;
    const outTok = response.usage?.output_tokens ?? 0;
    const costUsd = Number(
      ((inTok / 1_000_000) * ANTHROPIC_INPUT_PER_MTOK + (outTok / 1_000_000) * ANTHROPIC_OUTPUT_PER_MTOK).toFixed(8),
    );

    return { data: validate(parsed), model, provider: 'anthropic', costUsd, costIsReported: false };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Parse JSON, tolerating a fenced block despite the instruction not to use one. */
  private parseJson(text: string, purpose: string): unknown {
    const trimmed = text.trim();
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    const candidate = fence ? fence[1] : trimmed;
    try {
      return JSON.parse(candidate);
    } catch {
      this.logger.debug(`Non-JSON response for ${purpose}: ${candidate.slice(0, 200)}`);
      throw new Error(`${purpose}: model returned non-JSON`);
    }
  }

  private ensureAnthropic(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.anthropic;
  }
}
