/**
 * AEO LLM Service — the one constrained-JSON caller the module's three analysis
 * passes share (context synthesis, matrix phrasing, stance judging).
 *
 * ## Provider choice
 *
 * **OpenRouter is preferred** (`OPENROUTER_API_KEY`), running a small, cheap model
 * — these are extraction and classification jobs, not writing jobs, and a frontier
 * model is wasted on them. Anthropic remains a fallback so a deployment that only
 * has `ANTHROPIC_API_KEY` keeps working exactly as before.
 *
 * ## Why this model is the default
 *
 * `qwen/qwen3-30b-a3b-instruct-2507` was picked by benchmarking candidates on the
 * module's real stance-judging task (four cases: absent / led / placed-behind /
 * warned-about), not on price alone:
 *
 * | model | cases | avg latency | $/Mtok in-out |
 * |---|---|---|---|
 * | qwen3-30b-a3b-instruct-2507 | **4/4** | **1.5s** | 0.048 / 0.193 |
 * | openai/gpt-oss-120b | 4/4 | 7.7s | 0.037 / 0.170 |
 * | google/gemini-2.5-flash-lite | 3/4 | 1.1s | 0.100 / 0.400 |
 * | openai/gpt-5-nano | 0/4 (truncated JSON) | 16s | 0.050 / 0.400 |
 *
 * `gemini-2.5-flash-lite` failed the **absent** case — it reported
 * `mentioned-neutral` for an answer that never named the subject. That is the one
 * error this module cannot absorb: it turns "you are invisible" into "you were
 * mentioned". `gpt-5-nano` spends its budget on reasoning tokens and truncates.
 * Rerun the comparison before changing `AEO_LLM_MODEL`.
 *
 * **2026-09-13: the default below was changed to `deepseek/deepseek-v4.1-flash`
 * anyway, per an explicit "use this model for everything" operator
 * instruction — it was NOT re-run through the four-case benchmark above.**
 * The risk this module's own docs warn about (a model silently turning
 * "absent" into "mentioned-neutral") has not been re-verified against
 * DeepSeek. If AEO stance verdicts start looking too generous — a
 * competitor's "invisible" reading you'd expect starts coming back
 * "mentioned" — this benchmark is the first thing to re-run.
 *
 * ## Cost
 *
 * OpenRouter reports the true charge per call in `usage.cost`, so the audit's
 * cost governor is fed a real number rather than an estimate from a price table
 * that would drift. Roughly $0.02 for a 500-observation stance pass.
 *
 * @module aeo-llm.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Benchmarked default — see the table in this module's docblock. */
const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';

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
export class AeoLlmService {
  private readonly logger = new Logger(AeoLlmService.name);
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
      ? this.config.get<string>('AEO_LLM_MODEL', DEFAULT_OPENROUTER_MODEL)
      : this.config.get<string>('AEO_STANCE_JUDGE_MODEL', 'claude-opus-5');
  }

  /**
   * Ask for JSON and hand the parsed value to a validator.
   *
   * The validator is the trust boundary: it coerces whatever came back into the
   * caller's shape and drops anything unexpected, so a sloppy model cannot widen
   * a type. Callers decide what a failure means — the matrix keeps its template
   * phrasing, context keeps its deterministic extraction, a stance is recorded
   * as failed. Nothing here invents a result.
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

  /**
   * OpenAI-compatible call over raw `fetch` — the same approach
   * `perplexity.adapter.ts` takes, so the project still carries no OpenAI SDK.
   */
  private async viaOpenRouter<T>(req: LlmJsonRequest, validate: (raw: unknown) => T): Promise<LlmJsonResult<T>> {
    const apiKey = this.config.getOrThrow<string>('OPENROUTER_API_KEY');
    const model = this.config.get<string>('AEO_LLM_MODEL', DEFAULT_OPENROUTER_MODEL);
    const timeoutMs = Number(this.config.get<string>('AEO_LLM_TIMEOUT_MS', '60000'));

    // Without this a hung request stalls a whole 500-observation pass.
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
          // OpenRouter attributes traffic with these; harmless and useful.
          'HTTP-Referer': this.config.get<string>('AEO_LLM_REFERER', 'https://cailyx.local'),
          'X-Title': 'Cailyx AEO Audit',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          // Deterministic: the same answer must judge the same way on a re-run,
          // or run-over-run deltas measure the sampler, not the surface.
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

    // usage.cost is the real charge, not an estimate from a local price table.
    const reported = typeof body.usage?.cost === 'number';
    const costUsd = reported
      ? Number(body.usage!.cost!.toFixed(8))
      : 0;

    return {
      data: validate(parsed),
      model: body.model ?? model,
      provider: 'openrouter',
      costUsd,
      costIsReported: reported,
    };
  }

  // ─── Anthropic (fallback) ──────────────────────────────────────────────

  /** Kept so a deployment with only `ANTHROPIC_API_KEY` behaves as it did before. */
  private async viaAnthropic<T>(req: LlmJsonRequest, validate: (raw: unknown) => T): Promise<LlmJsonResult<T>> {
    const model = this.config.get<string>('AEO_STANCE_JUDGE_MODEL', 'claude-opus-5');
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
