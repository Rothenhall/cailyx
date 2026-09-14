/**
 * LlmService — the one constrained-LLM caller every "helper" LLM use in this
 * codebase should share: copy generation (`findings`, `growth-execution`),
 * refinement (`persona`, `journey`, `internal-link`, `page-analysis`),
 * classification/debate (`authority`, `council`), judging (`entity-audit`).
 *
 * Extracted from `aeo-audit/aeo-llm.service.ts` (2026-09-13), which pioneered
 * this exact OpenRouter-preferred / Anthropic-fallback shape for its own
 * three analysis passes — this generalizes it (caller-supplied model names
 * instead of `AEO_*`-prefixed env vars) so every other module's own
 * constrained-LLM call can move off constructing its own `Anthropic` client.
 *
 * ## Provider choice
 *
 * **OpenRouter is preferred** (`OPENROUTER_API_KEY`) — cheap, fast models for
 * extraction/classification/copy jobs, with real per-call cost reporting
 * (`usage.cost`) instead of a local price-table estimate that drifts.
 * Anthropic remains the fallback so a deployment with only
 * `ANTHROPIC_API_KEY` keeps working exactly as before — nothing that used to
 * work stops working when a caller migrates to this service.
 *
 * Default model: `deepseek/deepseek-v4.1-flash` (operator's explicit choice,
 * 2026-09-13, "use it for everything"). Applied here AND to every module
 * that kept its own default constant instead of using this shared one
 * (`aeo-llm.service.ts`, `presence.llm.service.ts`, `audit-narrative.service.ts`)
 * — see each for the caveat: `aeo-llm.service.ts` in particular had
 * benchmarked qwen3-30b as the accuracy winner for its specific stance-
 * judging task (absent/led/placed-behind/warned-about) and its own docblock
 * says not to change the default without re-running that comparison. Changed
 * anyway per explicit instruction; flagged to the operator, not silently
 * overridden or silently left on the old model either.
 *
 * Deliberately NOT used by `measurement/adapters/anthropic.adapter.ts`: that
 * adapter measures Claude itself as a named answer-engine SURFACE (the
 * product's share-of-voice moat), not a provider-agnostic helper call —
 * rerouting the thing being measured through a different transport is a
 * product decision, not an infra one, and out of scope here.
 *
 * @module llm.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Same benchmarked default `aeo-llm.service.ts` uses — see its docblock for the comparison table. */
export const DEFAULT_OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** Fallback $/MTok when Anthropic is used and no live cost is reported. */
const ANTHROPIC_INPUT_PER_MTOK = 5;
const ANTHROPIC_OUTPUT_PER_MTOK = 25;

export type LlmProvider = 'openrouter' | 'anthropic';

interface LlmRequestBase {
  /** Instructions for the model. */
  system: string;
  /** The payload to analyse/act on. */
  user: string;
  maxTokens: number;
  /** Label used in logs so a slow or failing call is identifiable. */
  purpose: string;
  /** Model to use when OpenRouter is the active provider. Defaults to {@link DEFAULT_OPENROUTER_MODEL}. */
  openRouterModel?: string;
  /** Model to use when Anthropic is the active provider (fallback, or the only configured one). Defaults to {@link DEFAULT_ANTHROPIC_MODEL}. */
  anthropicModel?: string;
  timeoutMs?: number;
  /** Omitted = provider default. Pass 0 for deterministic/judging tasks where a re-run must score the same input the same way. */
  temperature?: number;
  /**
   * OpenRouter reasoning mode (DeepSeek and other "thinking" models spend
   * completion tokens on hidden reasoning before the real answer, drawn from
   * the SAME `maxTokens` budget as the answer itself). Default false: every
   * caller through this service is a short, format-constrained extraction/
   * classification/brief task, and reasoning was verified live to
   * intermittently exhaust a 400-token budget on reasoning alone, truncating
   * the actual JSON before it was emitted (`json()` then throws "model
   * returned non-JSON" on what is actually a cut-off response, not a
   * malformed one). No caller has asked for it yet — pass true to opt in for
   * a task that would benefit from it, with a correspondingly larger
   * `maxTokens`. No effect on the Anthropic fallback path.
   */
  reasoning?: boolean;
}

export interface LlmJsonRequest extends LlmRequestBase {}
export interface LlmTextRequest extends LlmRequestBase {}

export interface LlmResult<T> {
  data: T;
  model: string;
  provider: LlmProvider;
  /** Real charge for this call when the provider reports one; else estimated from a static price table. */
  costUsd: number;
  costIsReported: boolean;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private anthropic: Anthropic | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Is any provider configured? Callers report honestly rather than guessing. */
  isAvailable(): boolean {
    return this.provider() !== null;
  }

  /** Which provider will be used, or null when neither key is configured. */
  provider(): LlmProvider | null {
    if (this.config.get<string>('OPENROUTER_API_KEY')) return 'openrouter';
    if (this.config.get<string>('ANTHROPIC_API_KEY')) return 'anthropic';
    return null;
  }

  /** Ask for JSON and hand the parsed value to a validator — the trust boundary; a sloppy model cannot widen the caller's type. */
  async json<T>(req: LlmJsonRequest, validate: (raw: unknown) => T): Promise<LlmResult<T>> {
    const raw = await this.call(req, true);
    return { ...raw, data: validate(this.parseJson(raw.data, req.purpose)) };
  }

  /** Ask for plain text — no JSON parsing, the raw model output trimmed. */
  async text(req: LlmTextRequest): Promise<LlmResult<string>> {
    const raw = await this.call(req, false);
    return { ...raw, data: raw.data.trim() };
  }

  // ─── Dispatch ──────────────────────────────────────────────────────────

  private async call(req: LlmRequestBase, jsonMode: boolean): Promise<LlmResult<string>> {
    const provider = this.provider();
    if (!provider) {
      throw new Error('No LLM provider configured — set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY');
    }
    return provider === 'openrouter' ? this.viaOpenRouter(req, jsonMode) : this.viaAnthropic(req);
  }

  // ─── OpenRouter ────────────────────────────────────────────────────────

  /** OpenAI-compatible call over raw `fetch` — no OpenAI SDK dependency, same approach `perplexity.adapter.ts` and `aeo-llm.service.ts` take. */
  private async viaOpenRouter(req: LlmRequestBase, jsonMode: boolean): Promise<LlmResult<string>> {
    const apiKey = this.config.getOrThrow<string>('OPENROUTER_API_KEY');
    const model = req.openRouterModel ?? DEFAULT_OPENROUTER_MODEL;
    const timeoutMs = req.timeoutMs ?? 60000;

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
          'HTTP-Referer': this.config.get<string>('OPENROUTER_REFERER', 'https://cailyx.local'),
          'X-Title': 'Cailyx',
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          // Explicit every call, not just when a "thinking" model is in play —
          // an off switch for a feature a non-reasoning model doesn't have is
          // a harmless no-op there, and this is the one place every caller's
          // choice is enforced regardless of which model config resolves to.
          reasoning: { enabled: req.reasoning === true },
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
    const reported = typeof body.usage?.cost === 'number';
    const costUsd = reported ? Number(body.usage!.cost!.toFixed(8)) : 0;

    return { data: content, model: body.model ?? model, provider: 'openrouter', costUsd, costIsReported: reported };
  }

  // ─── Anthropic (fallback) ──────────────────────────────────────────────

  /** Kept so a deployment with only `ANTHROPIC_API_KEY` behaves as every caller did before its migration to this service. */
  private async viaAnthropic(req: LlmRequestBase): Promise<LlmResult<string>> {
    const model = req.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL;
    const response = await this.ensureAnthropic().messages.create({
      model,
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const inTok = response.usage?.input_tokens ?? 0;
    const outTok = response.usage?.output_tokens ?? 0;
    const costUsd = Number(
      ((inTok / 1_000_000) * ANTHROPIC_INPUT_PER_MTOK + (outTok / 1_000_000) * ANTHROPIC_OUTPUT_PER_MTOK).toFixed(8),
    );

    return { data: content, model, provider: 'anthropic', costUsd, costIsReported: false };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /**
   * Parse JSON tolerating the three shapes callers across this codebase were
   * each individually defending against before migrating here: a clean
   * object, a fenced ```json block, or JSON with surrounding prose (brace-
   * to-matching-brace extraction, tried last since it is the least strict).
   */
  private parseJson(text: string, purpose: string): unknown {
    const trimmed = text.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through
    }
    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        // fall through
      }
    }
    const objStart = trimmed.indexOf('{');
    const objEnd = trimmed.lastIndexOf('}');
    const arrStart = trimmed.indexOf('[');
    const arrEnd = trimmed.lastIndexOf(']');
    const useArray = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    const start = useArray ? arrStart : objStart;
    const end = useArray ? arrEnd : objEnd;
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through to the throw below
      }
    }
    this.logger.debug(`Non-JSON response for ${purpose}: ${trimmed.slice(0, 200)}`);
    throw new Error(`${purpose}: model returned non-JSON`);
  }

  private ensureAnthropic(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.getOrThrow<string>('ANTHROPIC_API_KEY') });
    }
    return this.anthropic;
  }
}
