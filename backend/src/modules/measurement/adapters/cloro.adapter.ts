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

import { Injectable, Logger } from '@nestjs/common';
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
 * Per-HTTP-call timeout. `fetch` has no default one, and Cloro's task-status
 * endpoints are supposed to answer immediately (the actual work happens async
 * on their side) — a call that hangs past this is a stuck connection, not
 * slow work, so it's aborted and surfaced as a normal CloroAdapterError
 * instead of blocking the poll loop (and the whole request) indefinitely.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Thin HTTP client for Cloro's API — auth, base URL, submit/poll/credits.
 * Shared by every `CloroAdapterBase` subclass and by `aeo-audit.service.ts`'s
 * pre-flight budget guard, so there is exactly one place that knows Cloro's
 * base URL and gating rule.
 */
@Injectable()
export class CloroClient {
  private readonly logger = new Logger(CloroClient.name);

  constructor(private readonly config: ConfigService) {}

  /** Highest `CLORO_API_KEY<N>` suffix checked — generous enough for any real account count. */
  private static readonly MAX_KEY_SUFFIX = 20;

  /**
   * Multi-account fallback: `CLORO_API_KEY` is tried first, then
   * `CLORO_API_KEY1`, `CLORO_API_KEY2`, `CLORO_API_KEY3`, ... — separate Cloro
   * accounts, not one account's rotated secrets, so exhausting one's credits
   * doesn't stop a run. Unset entries are skipped, so this degrades cleanly to
   * however many keys are actually configured, and a new account can be added
   * by just setting the next `CLORO_API_KEY<N>` — no code change needed.
   */
  private keys(): string[] {
    const names = ['CLORO_API_KEY', ...Array.from({ length: CloroClient.MAX_KEY_SUFFIX }, (_, i) => `CLORO_API_KEY${i + 1}`)];
    return names.map((name) => this.config.get<string>(name)).filter((k): k is string => !!k);
  }

  /**
   * Which configured key new task submissions start from. Advances (and
   * stays advanced) once a key is found exhausted/rejected, so a run with
   * many tasks doesn't re-try a dead key on every single one — see
   * `submitAndPoll`'s create-call retry loop, the only place this moves.
   */
  private activeKeyIndex = 0;

  private requireKeys(): string[] {
    const keys = this.keys();
    if (keys.length === 0) {
      throw new CloroAdapterError(
        'cloro-disabled',
        'cloro',
        'CLORO_API_KEY is not set — sign up at cloro.dev and add the key to run this surface.',
      );
    }
    return keys;
  }

  private headersFor(key: string): Record<string, string> {
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }

  /** Headers for the currently active key — used by calls that aren't part of the create-call fallback loop (credit checks, polling an already-created task). */
  private headers(): Record<string, string> {
    const keys = this.requireKeys();
    return this.headersFor(keys[Math.min(this.activeKeyIndex, keys.length - 1)]);
  }

  /**
   * `GET /v1/credits` — the pre-flight balance check, summed across every
   * configured key. These are separate Cloro accounts (see {@link keys}), and
   * `submitAndPoll` already rotates through all of them at task-submission
   * time — a run isn't actually blocked by one account's balance. Checking
   * only the active key here made the budget guard reject runs the adapter
   * would in fact have completed by falling through to key #2/#3, so every
   * configured key's balance is queried and added together. One key failing
   * this check (bad key, suspended account) counts as 0 for that key rather
   * than aborting the whole estimate — a dead key should reduce the total,
   * not make the total unknowable.
   */
  async getRemainingCredits(): Promise<number> {
    const keys = this.requireKeys();
    const balances = await Promise.all(
      keys.map(async (key) => {
        try {
          const res = await fetch(`${CLORO_BASE_URL}/v1/credits`, { headers: this.headersFor(key) });
          if (!res.ok) return 0;
          const body = (await res.json()) as { remaining: number };
          return Number.isFinite(body.remaining) ? body.remaining : 0;
        } catch {
          return 0;
        }
      }),
    );
    return balances.reduce((sum, n) => sum + n, 0);
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
    const keys = this.requireKeys();

    let createRes: Response | null = null;
    let usedKeyIndex = this.activeKeyIndex;
    let lastErr: Error | null = null;
    for (let i = Math.min(this.activeKeyIndex, keys.length - 1); i < keys.length; i++) {
      try {
        const res = await fetch(`${CLORO_BASE_URL}/v1/async/task`, {
          method: 'POST',
          headers: this.headersFor(keys[i]),
          body: JSON.stringify({ taskType, payload }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          const body = await res.text();
          lastErr = new Error(`POST /v1/async/task returned HTTP ${res.status}: ${body.slice(0, 300)}`);
          // A failure here (typically 401/402/403 — invalid key or out of
          // credits) means THIS key is done, not that the task itself is bad
          // — try the next configured one rather than failing the whole run.
          continue;
        }
        createRes = res;
        usedKeyIndex = i;
        break;
      } catch (err) {
        lastErr = new Error(`POST /v1/async/task did not respond within ${REQUEST_TIMEOUT_MS}ms: ${(err as Error).message}`);
      }
    }
    if (!createRes) {
      throw new CloroAdapterError('cloro-api-error', surface, lastErr?.message ?? 'All configured Cloro keys failed.');
    }
    if (usedKeyIndex !== this.activeKeyIndex) {
      this.logger.warn(`Cloro: key #${this.activeKeyIndex + 1} exhausted/rejected, switched to key #${usedKeyIndex + 1}.`);
      this.activeKeyIndex = usedKeyIndex;
    }
    const activeKey = keys[usedKeyIndex];

    const created = (await createRes.json()) as CloroCreateResponse;
    const taskId = created.task.id;

    while (Date.now() - started < POLL_TIMEOUT_MS) {
      await this.sleep(POLL_INTERVAL_MS);
      let pollRes: Response;
      try {
        pollRes = await fetch(`${CLORO_BASE_URL}/v1/async/task/${taskId}`, {
          headers: this.headersFor(activeKey),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new CloroAdapterError('cloro-api-error', surface, `GET /v1/async/task/${taskId} did not respond within ${REQUEST_TIMEOUT_MS}ms: ${(err as Error).message}`);
      }
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
