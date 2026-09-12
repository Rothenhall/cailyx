/**
 * Cloro (cloro.dev) answer-engine surfaces — ChatGPT, Perplexity, Gemini,
 * Google AI Mode and Google AI Overview, queried through Cloro's API instead
 * of a Playwright-driven browser session (decision D1, `docs/analysis/wave-6-audit-pipeline.md`).
 *
 * Cloro queries the *consumer* products on our behalf, which is the same
 * motivation as the `*-browser` adapters ("an API answer is not what a buyer
 * sees") without the ToS exposure of automating a signed-in session ourselves.
 * Those browser adapters become the automatic fallback when a Cloro engine
 * fails — see the fallback chain in `aeo-audit.service.ts`.
 *
 * ## API shape (verified against a live call, not just the docs)
 *
 * `POST /v1/async/task` submits one task (`{ taskType, payload }`) and returns
 * `{ task: { id, status }, credits: { creditsToCharge, creditsCharged } }`.
 * `GET /v1/async/task/{taskId}` is polled until `status` is `COMPLETED` or
 * `FAILED`; a completed task's `response` field is the **flat** provider
 * result (`{ text, sources, ... }`) — not wrapped in a `result` envelope the
 * way the sync `/v1/monitor/*` endpoints' documented schema suggests. That
 * mismatch was caught by a real test call before this adapter was written.
 *
 * Google AI Overview is not its own `taskType` — it is a `GOOGLE` task with
 * `include: { aioverview: { markdown: true } }`, and the box appears at
 * `response.aioverview`. A different flag (`include.paaAioverview`) returns
 * AI-style answers to expanded "People Also Ask" questions instead — a
 * related but distinct thing, not what "AI Overview" means here.
 *
 * ## Cost
 *
 * `costUsd` is `creditsCharged * CLORO_CREDIT_USD` — a real number, computed
 * only after Cloro reports what it actually charged. Failures charge 0
 * credits, so a thrown error never inflates a run's cost.
 *
 * @module cloro.adapter
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SurfaceAdapter, SurfaceAnswer } from '../measurement.types';

const CLORO_BASE_URL = 'https://api.cloro.dev';

/** Typed failure reasons — recorded on the run, never worked around. */
export type CloroFailure =
  | 'cloro-disabled'
  | 'cloro-budget-exceeded'
  | 'cloro-task-failed'
  | 'cloro-timeout'
  | 'cloro-api-error';

/** Error carrying the typed reason so a run can report *why* it stopped. */
export class CloroAdapterError extends Error {
  constructor(
    readonly reason: CloroFailure,
    readonly surface: string,
    message: string,
  ) {
    super(message);
    this.name = 'CloroAdapterError';
  }
}

/** The five Cloro-backed surfaces this adapter family provides. */
export type CloroSurface = 'cloro-chatgpt' | 'cloro-perplexity' | 'cloro-gemini' | 'cloro-ai-overview' | 'cloro-ai-mode';

/**
 * Flat per-task credit costs, for the pre-flight budget *estimate* only — the
 * real charge always comes from `creditsCharged` on the completed task.
 * `cloro-chatgpt` and `cloro-ai-overview` (with `include.aioverview`) were
 * confirmed at 5 credits each by a live call; `cloro-perplexity`,
 * `cloro-gemini` and `cloro-ai-mode` are Cloro's disclosed base rates
 * (unverified live — confirm if the estimate drifts from reality in practice).
 */
export const CLORO_BASE_CREDITS: Record<CloroSurface, number> = {
  'cloro-chatgpt': 5,
  'cloro-perplexity': 4,
  'cloro-gemini': 4,
  'cloro-ai-overview': 5,
  'cloro-ai-mode': 4,
};

interface CloroTaskSummary {
  id: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
}

interface CloroTaskCredits {
  creditsToCharge: number;
  creditsCharged: number | null;
}

interface CloroCreateResponse {
  success: boolean;
  task: CloroTaskSummary;
  credits: CloroTaskCredits;
}

interface CloroStatusResponse {
  task: CloroTaskSummary;
  credits: CloroTaskCredits;
  response?: Record<string, unknown>;
}

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120_000;

/**
 * Thin HTTP client for Cloro's API — auth, base URL, submit/poll/credits.
 * Shared by every `CloroAdapterBase` subclass and by `aeo-audit.service.ts`'s
 * pre-flight budget guard, so there is exactly one place that knows Cloro's
 * base URL and gating rule.
 */
@Injectable()
export class CloroClient {
  constructor(private readonly config: ConfigService) {}

  private key(): string {
    const key = this.config.get<string>('CLORO_API_KEY');
    if (!key) {
      throw new CloroAdapterError(
        'cloro-disabled',
        'cloro',
        'CLORO_API_KEY is not set — sign up at cloro.dev and add the key to run this surface.',
      );
    }
    return key;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.key()}`, 'Content-Type': 'application/json' };
  }

  /** `GET /v1/credits` — the pre-flight balance check. */
  async getRemainingCredits(): Promise<number> {
    const res = await fetch(`${CLORO_BASE_URL}/v1/credits`, { headers: this.headers() });
    if (!res.ok) {
      throw new CloroAdapterError('cloro-api-error', 'cloro', `GET /v1/credits returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as { remaining: number };
    return body.remaining;
  }

  /**
   * In-flight Cloro tasks, and the queue waiting for a slot.
   *
   * The executor happens to run prompts sequentially today, so concurrency is
   * 1 by accident. That is not the same as being 1 by contract: the moment
   * anything upstream parallelises, Cloro would be handed more simultaneous
   * tasks than the plan permits and start rejecting them mid-run. The limit is
   * enforced here, where the plan's rule actually lives, and read from config so
   * a paid tier can raise it without touching the executor.
   */
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  /** `CLORO_MAX_CONCURRENCY`, default 1 — the free tier's limit. */
  private limit(): number {
    const raw = Number(this.config.get<string>('CLORO_MAX_CONCURRENCY', '1'));
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  }

  /** Take a slot, waiting in FIFO order when the limit is reached. */
  private async acquire(): Promise<void> {
    if (this.inFlight < this.limit()) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight++;
  }

  /** Release a slot and wake the next waiter, if any. */
  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiting.shift();
    if (next) next();
  }

  /** Submit one task and poll it to completion. Throws a typed `CloroAdapterError` on any failure path. */
  async runTask(surface: string, taskType: string, payload: Record<string, unknown>): Promise<CloroStatusResponse> {
    await this.acquire();
    try {
      return await this.submitAndPoll(surface, taskType, payload);
    } finally {
      // `finally`, not after the return: a thrown task must free its slot or
      // one failure permanently shrinks the pool.
      this.release();
    }
  }

  private async submitAndPoll(
    surface: string,
    taskType: string,
    payload: Record<string, unknown>,
  ): Promise<CloroStatusResponse> {
    const started = Date.now();
    const createRes = await fetch(`${CLORO_BASE_URL}/v1/async/task`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ taskType, payload }),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      throw new CloroAdapterError('cloro-api-error', surface, `POST /v1/async/task returned HTTP ${createRes.status}: ${body.slice(0, 300)}`);
    }
    const created = (await createRes.json()) as CloroCreateResponse;
    const taskId = created.task.id;

    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await this.sleep(POLL_INTERVAL_MS);
      const pollRes = await fetch(`${CLORO_BASE_URL}/v1/async/task/${taskId}`, { headers: this.headers() });
      if (!pollRes.ok) {
        throw new CloroAdapterError('cloro-api-error', surface, `GET /v1/async/task/${taskId} returned HTTP ${pollRes.status}`);
      }
      const status = (await pollRes.json()) as CloroStatusResponse;
      if (status.task.status === 'COMPLETED' || status.task.status === 'FAILED') {
        if (status.task.status === 'FAILED' || !status.response) {
          throw new CloroAdapterError('cloro-task-failed', surface, `Task ${taskId} failed`);
        }
        return status;
      }
    }
    throw new CloroAdapterError('cloro-timeout', surface, `Task ${taskId} did not finish within ${POLL_TIMEOUT_MS}ms`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** One cited source, in whichever provider's response carries it. */
interface CloroSource {
  url: string;
}

/** Flat `{ text, sources }` shape shared by ChatGPT, Perplexity, Gemini and AI Mode. */
function extractFlat(response: Record<string, unknown>): { text: string; sources: CloroSource[] } {
  return {
    text: typeof response.text === 'string' ? response.text : '',
    sources: Array.isArray(response.sources) ? (response.sources as CloroSource[]) : [],
  };
}

@Injectable()
export abstract class CloroAdapterBase implements SurfaceAdapter {
  abstract readonly name: CloroSurface;
  protected abstract readonly taskType: string;

  constructor(
    protected readonly client: CloroClient,
    protected readonly config: ConfigService,
  ) {}

  protected abstract buildPayload(prompt: string, geo: string): Record<string, unknown>;
  protected abstract extractAnswer(response: Record<string, unknown>): { text: string; sources: CloroSource[] };

  async runPrompt(prompt: string, geo: string): Promise<SurfaceAnswer> {
    const started = Date.now();
    const status = await this.client.runTask(this.name, this.taskType, this.buildPayload(prompt, geo));
    const { text, sources } = this.extractAnswer(status.response!);
    const creditsCharged = status.credits.creditsCharged ?? 0;

    return {
      text,
      citations: sources.map((s) => s.url),
      costUsd: creditsCharged * (this.config.get<number>('CLORO_CREDIT_USD') ?? 0.0004),
      latencyMs: Date.now() - started,
      model: this.name,
    };
  }
}

/** ChatGPT via Cloro. */
@Injectable()
export class CloroChatGptAdapter extends CloroAdapterBase {
  readonly name = 'cloro-chatgpt' as const;
  protected readonly taskType = 'CHATGPT';
  protected buildPayload(prompt: string, geo: string) {
    return { prompt, country: geo };
  }
  protected extractAnswer = extractFlat;
}

/** Perplexity via Cloro. */
@Injectable()
export class CloroPerplexityAdapter extends CloroAdapterBase {
  readonly name = 'cloro-perplexity' as const;
  protected readonly taskType = 'PERPLEXITY';
  protected buildPayload(prompt: string, geo: string) {
    return { prompt, country: geo };
  }
  protected extractAnswer = extractFlat;
}

/** Gemini via Cloro. */
@Injectable()
export class CloroGeminiAdapter extends CloroAdapterBase {
  readonly name = 'cloro-gemini' as const;
  protected readonly taskType = 'GEMINI';
  protected buildPayload(prompt: string, geo: string) {
    return { prompt, country: geo };
  }
  protected extractAnswer = extractFlat;
}

/** Google AI Mode via Cloro. */
@Injectable()
export class CloroAiModeAdapter extends CloroAdapterBase {
  readonly name = 'cloro-ai-mode' as const;
  protected readonly taskType = 'AIMODE';
  protected buildPayload(prompt: string, geo: string) {
    return { prompt, country: geo };
  }
  protected extractAnswer = extractFlat;
}

/**
 * Google's main AI Overview box via Cloro — a `GOOGLE` task, not its own
 * taskType. `include.aioverview` (not `paaAioverview`, which is a different,
 * per-question feature) is what surfaces `response.aioverview`.
 */
@Injectable()
export class CloroGoogleAiOverviewAdapter extends CloroAdapterBase {
  readonly name = 'cloro-ai-overview' as const;
  protected readonly taskType = 'GOOGLE';
  protected buildPayload(prompt: string, geo: string) {
    return { query: prompt, country: geo, include: { aioverview: { markdown: false } } };
  }
  protected extractAnswer(response: Record<string, unknown>): { text: string; sources: CloroSource[] } {
    const overview = response.aioverview as { text?: string; sources?: CloroSource[] } | undefined;
    if (!overview) {
      // No AI Overview box for this query — a real, reportable absence, not an error.
      return { text: '', sources: [] };
    }
    return { text: overview.text ?? '', sources: Array.isArray(overview.sources) ? overview.sources : [] };
  }
}
