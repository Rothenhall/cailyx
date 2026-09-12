/**
 * Browser answer-engine surfaces — ChatGPT, Perplexity and Gemini, driven as a
 * real user would (decision D1-B, `docs/analysis/aeo-audit.md`).
 *
 * Each surface is the vendor's **consumer product** in headless Chromium, using
 * a session the operator supplies. That is the point: an API answer is not what
 * a buyer sees, and this audit is about what buyers see.
 *
 * ## Read this before enabling any of them
 *
 * Automating these products is **against their Terms of Use** (OpenAI, Perplexity
 * and Google alike). The risk — account suspension, IP blocks — sits with whoever
 * supplies the session. Point them only at accounts the operator controls and has
 * accepted that risk for. **Never a client's account.**
 *
 * They are also fragile by nature: each breaks whenever its vendor changes the
 * UI. When a composer selector stops matching, the adapter says exactly that
 * rather than failing mysteriously, and names the constant to update.
 *
 * ## What these adapters deliberately do NOT do
 *
 * - No CAPTCHA solving and no solver-service integration.
 * - No stealth plugin, fingerprint spoofing or other anti-detection layer.
 * - No credential handling — the operator signs in by hand once and exports a
 *   Playwright `storageState`; this module never sees a password.
 *
 * On a challenge, block or rate limit the adapter **fails the observation with a
 * typed reason** and lets the run record it. It does not try to get past it.
 *
 * ## Cost
 *
 * `costUsd: 0` on every answer. These are paid for by the operator's
 * subscriptions, not per call. Inventing a per-prompt price would corrupt the
 * run's cost governor, so the truth is reported instead.
 *
 * @module browser-surface.adapter
 */

import { existsSync } from 'node:fs';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Surface, SurfaceAdapter, SurfaceAnswer } from '../measurement.types';

/** Typed failure reasons — recorded on the run, never worked around. */
export type BrowserSurfaceFailure =
  | 'surface-disabled'
  | 'no-session'
  | 'session-expired'
  | 'challenged'
  | 'rate-limited'
  | 'blocked'
  | 'timeout'
  | 'selector-drift'
  | 'no-answer';

/** Error carrying the typed reason so a run can report *why* it stopped. */
export class BrowserSurfaceError extends Error {
  constructor(
    readonly reason: BrowserSurfaceFailure,
    readonly surface: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserSurfaceError';
  }
}

/** Text meaning "we are not getting an answer" — matched case-insensitively. */
const COMMON_BLOCK_SIGNALS: Array<{ pattern: RegExp; reason: BrowserSurfaceFailure }> = [
  { pattern: /verify you are human|just a moment|checking your browser|cf-challenge|unusual traffic/i, reason: 'challenged' },
  { pattern: /you'?ve (reached|hit) (your|the) .{0,30}limit|too many requests|rate limit|slow down/i, reason: 'rate-limited' },
  { pattern: /access denied|unusual activity|account (has been )?(suspended|deactivated)|forbidden/i, reason: 'blocked' },
];

/** Everything that differs between one answer engine and the next. */
export interface BrowserSurfaceProfile {
  /** Where a fresh conversation starts. */
  readonly url: string;
  /** Where the buyer types, most stable selector first. */
  readonly composer: readonly string[];
  /** The answer container, most stable first. */
  readonly answer: readonly string[];
  /** Present only while a response streams — the completion signal. */
  readonly stop: readonly string[];
  /** Hosts that are product chrome rather than a cited source. */
  readonly ownHosts: RegExp;
  /** Signals that mean "signed out", which differ per product. */
  readonly signedOut: RegExp;
  /** Some composers need a click before they accept keystrokes. */
  readonly clickComposerFirst: boolean;
}

/** The three products this audit measures. */
export const SURFACE_PROFILES: Record<string, BrowserSurfaceProfile> = {
  chatgpt: {
    url: 'https://chatgpt.com/',
    composer: ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]', 'form textarea', 'div[contenteditable="true"]'],
    answer: ['[data-message-author-role="assistant"]', 'div.agent-turn', 'article:has([data-message-author-role="assistant"])'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
    ownHosts: /(^|\.)(openai\.com|chatgpt\.com|oaiusercontent\.com)$/i,
    signedOut: /log in|sign up to continue|create an account|welcome back/i,
    clickComposerFirst: true,
  },
  perplexity: {
    url: 'https://www.perplexity.ai/',
    composer: ['textarea[placeholder*="Ask" i]', 'textarea[placeholder*="anything" i]', 'div[contenteditable="true"]', 'main textarea'],
    answer: ['[data-testid="answer"]', 'div[class*="prose"]', 'main [class*="answer"]', 'main article'],
    stop: ['button[aria-label*="Stop" i]', 'button[data-testid="stop-generating"]'],
    ownHosts: /(^|\.)perplexity\.ai$/i,
    signedOut: /sign in to continue|create an account|log in to perplexity/i,
    clickComposerFirst: true,
  },
  gemini: {
    url: 'https://gemini.google.com/app',
    composer: ['rich-textarea div[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'textarea'],
    answer: ['model-response', 'message-content', '[class*="model-response-text"]', 'main [class*="response"]'],
    stop: ['button[aria-label*="Stop" i]', 'mat-icon[fonticon="stop"]'],
    ownHosts: /(^|\.)(google\.com|gstatic\.com|googleusercontent\.com|withgoogle\.com)$/i,
    signedOut: /sign in|choose an account|use your google account/i,
    clickComposerFirst: true,
  },
};

/**
 * Shared driver. Subclasses supply only a {@link Surface} name and the env-var
 * prefix their session/model settings live under.
 */
export abstract class BrowserSurfaceAdapterBase implements SurfaceAdapter, OnModuleDestroy {
  abstract readonly name: Surface;
  /** Key into {@link SURFACE_PROFILES}. */
  protected abstract readonly profileKey: string;
  /** Env prefix, e.g. `AEO_CHATGPT` → `AEO_CHATGPT_SESSION_PATH`. */
  protected abstract readonly envPrefix: string;

  protected readonly logger = new Logger(this.constructor.name);
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  /** Wall-clock of the last prompt, so consecutive prompts stay spaced out. */
  private lastPromptAt = 0;

  constructor(protected readonly config: ConfigService) {}

  protected get profile(): BrowserSurfaceProfile {
    return SURFACE_PROFILES[this.profileKey];
  }

  /**
   * Ask one question in a brand-new conversation.
   *
   * A fresh chat per prompt is required by the measurement design (PRD FR-6.2):
   * otherwise earlier answers steer later ones and the n≥5 repeats stop being
   * independent samples.
   *
   * @param geo Recorded on the observation. Not steered — that needs proxy
   *   egress, and faking it would be worse than saying so.
   * @throws BrowserSurfaceError with a typed reason on any non-answer outcome.
   */
  async runPrompt(prompt: string, geo: string): Promise<SurfaceAnswer> {
    this.assertEnabled();
    const started = Date.now();
    await this.respectMinGap();

    const page = await this.newPage();
    try {
      await this.openFreshChat(page);
      await this.send(page, prompt);
      const { text, citations } = await this.readAnswer(page);

      if (!text.trim()) {
        throw new BrowserSurfaceError('no-answer', this.name, `${this.name} returned an empty answer`);
      }

      this.logger.debug(
        `${this.name} answered (${text.length} chars, ${citations.length} citations, geo=${geo} not steered)`,
      );

      return {
        text,
        citations,
        // Paid for by the operator's subscription, not per call.
        costUsd: 0,
        latencyMs: Date.now() - started,
        model: this.config.get<string>(`${this.envPrefix}_LABEL`, `${this.profileKey}-web`),
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Close the browser when Nest tears the module down. */
  async onModuleDestroy(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }

  // ─── Gating ────────────────────────────────────────────────────────────

  /**
   * Fail closed unless the operator explicitly enabled browser surfaces AND
   * supplied a session for this one.
   */
  protected assertEnabled(): void {
    if (this.config.get<string>('AEO_ALLOW_BROWSER_SURFACE') !== '1') {
      throw new BrowserSurfaceError(
        'surface-disabled',
        this.name,
        `Browser surfaces are disabled. Set AEO_ALLOW_BROWSER_SURFACE=1 to enable them, ` +
          `and read the ToS note in the module README first.`,
      );
    }
    const sessionPath = this.sessionPath();
    if (!sessionPath) {
      throw new BrowserSurfaceError(
        'no-session',
        this.name,
        `${this.envPrefix}_SESSION_PATH is not set — sign in to ${this.profile.url} manually once ` +
          `and save the Playwright storageState to that path.`,
      );
    }
    if (!existsSync(sessionPath)) {
      throw new BrowserSurfaceError('no-session', this.name, `Session file not found at ${sessionPath}`);
    }
  }

  protected sessionPath(): string | undefined {
    return this.config.get<string>(`${this.envPrefix}_SESSION_PATH`) || undefined;
  }

  /**
   * Keep a deliberate gap between prompts. This is politeness, not evasion —
   * hammering a surface would be both rude and the fastest route to a block.
   */
  private async respectMinGap(): Promise<void> {
    const minGap = Number(this.config.get<string>(`${this.envPrefix}_MIN_GAP_MS`, '8000'));
    const waited = Date.now() - this.lastPromptAt;
    if (this.lastPromptAt > 0 && waited < minGap) {
      await this.sleep(minGap - waited);
    }
    this.lastPromptAt = Date.now();
  }

  // ─── Browser lifecycle ─────────────────────────────────────────────────

  /** One browser + context (the operator's session) per surface, one page per prompt. */
  private async newPage(): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({
        headless: this.config.get<string>('AEO_BROWSER_HEADLESS', '1') !== '0',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      });
      this.context = null;
    }
    if (!this.context) {
      this.context = await this.browser.newContext({
        storageState: this.sessionPath(),
        viewport: { width: 1280, height: 900 },
      });
    }
    return this.context.newPage();
  }

  /** Load a brand-new conversation so repeats stay independent. */
  private async openFreshChat(page: Page): Promise<void> {
    const url = this.config.get<string>(`${this.envPrefix}_URL`, this.profile.url);
    const timeout = this.timeout();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (err) {
      throw new BrowserSurfaceError('timeout', this.name, `Could not load ${url}: ${(err as Error).message}`);
    }
    await this.assertNotBlocked(page);

    const composer = await this.findFirst(page, this.profile.composer, timeout);
    if (!composer) {
      await this.assertNotBlocked(page); // a block is the usual reason it is missing
      throw new BrowserSurfaceError(
        'selector-drift',
        this.name,
        `Could not find the ${this.profileKey} composer — the UI has probably changed. ` +
          `Update SURFACE_PROFILES.${this.profileKey}.composer in browser-surface.adapter.ts. ` +
          `Re-run with AEO_BROWSER_HEADLESS=0 to see the page.`,
      );
    }
  }

  /** Type the prompt and submit it. */
  private async send(page: Page, prompt: string): Promise<void> {
    const selector = await this.findFirst(page, this.profile.composer, this.timeout());
    if (!selector) {
      throw new BrowserSurfaceError('selector-drift', this.name, 'Composer disappeared before send');
    }

    if (this.profile.clickComposerFirst) await page.click(selector);
    // `fill` does not work on contenteditable composers; type into the focused node.
    await page.keyboard.insertText(prompt);
    await page.keyboard.press('Enter');
  }

  /**
   * Wait for generation to finish, then read the last answer turn.
   *
   * Completion = the stop control disappears, or the text stops growing across
   * consecutive polls — the fallback for when a stop selector drifts.
   */
  private async readAnswer(page: Page): Promise<{ text: string; citations: string[] }> {
    const timeout = this.timeout();
    const deadline = Date.now() + timeout;
    const answerSelector = (await this.findFirst(page, this.profile.answer, 30_000)) ?? this.profile.answer[0];

    let lastText = '';
    let stableFor = 0;

    while (Date.now() < deadline) {
      await this.sleep(1500);
      await this.assertNotBlocked(page);

      const generating = await this.isGenerating(page);
      const text = await this.lastAnswerText(page, answerSelector);

      if (text === lastText && text.length > 0) {
        stableFor += 1500;
      } else {
        stableFor = 0;
        lastText = text;
      }

      if (!generating && text.length > 0 && stableFor >= 3000) {
        return { text, citations: await this.citations(page, answerSelector) };
      }
    }

    if (lastText.length > 0) {
      // Timed out mid-stream — return what was actually produced rather than
      // discarding a partial answer, and say so.
      this.logger.warn(`${this.name} timed out mid-answer; returning the partial text`);
      return { text: lastText, citations: await this.citations(page, answerSelector) };
    }
    throw new BrowserSurfaceError('timeout', this.name, `No answer within ${timeout}ms`);
  }

  /** Is a response still streaming? */
  private async isGenerating(page: Page): Promise<boolean> {
    for (const selector of this.profile.stop) {
      if ((await page.locator(selector).count()) > 0) return true;
    }
    return false;
  }

  /** Text of the last answer turn. */
  private async lastAnswerText(page: Page, selector: string): Promise<string> {
    try {
      const turns = page.locator(selector);
      const count = await turns.count();
      if (count === 0) return '';
      return ((await turns.nth(count - 1).innerText()) || '').trim();
    } catch {
      return '';
    }
  }

  /**
   * Cited URLs from the last answer turn, in the order they appear.
   *
   * These products render sources as ordinary external anchors; product chrome
   * and own-domain links are dropped so only real sources are counted.
   */
  private async citations(page: Page, selector: string): Promise<string[]> {
    try {
      const turns = page.locator(selector);
      const count = await turns.count();
      if (count === 0) return [];
      const hrefs = await turns
        .nth(count - 1)
        .locator('a[href^="http"]')
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).href));

      const out: string[] = [];
      const seen = new Set<string>();
      for (const href of hrefs) {
        try {
          const host = new URL(href).hostname.replace(/^www\./, '');
          if (this.profile.ownHosts.test(host)) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          out.push(href);
        } catch {
          // not a usable URL — skip
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  // ─── Honest failure detection ──────────────────────────────────────────

  /**
   * Detect a challenge / block / rate limit / signed-out state and raise it as a
   * typed error. Detection only — nothing here attempts to get past any of them.
   */
  private async assertNotBlocked(page: Page): Promise<void> {
    let body = '';
    try {
      body = (await page.locator('body').innerText({ timeout: 5000 })) || '';
    } catch {
      return; // page not readable yet; the caller's own timeout governs
    }
    // Only inspect the top of the page: an answer's own text can legitimately
    // contain phrases like "log in", and must not be mistaken for a block.
    const head = body.slice(0, 1200);

    for (const { pattern, reason } of COMMON_BLOCK_SIGNALS) {
      if (pattern.test(head)) {
        throw new BrowserSurfaceError(
          reason,
          this.name,
          `${this.name} returned a ${reason} state. The run stops here — this adapter does not ` +
            `attempt to bypass it.`,
        );
      }
    }
    if (this.profile.signedOut.test(head)) {
      throw new BrowserSurfaceError(
        'session-expired',
        this.name,
        `${this.name} is signed out — refresh ${this.envPrefix}_SESSION_PATH by signing in again.`,
      );
    }
  }

  // ─── Small helpers ─────────────────────────────────────────────────────

  /** First selector that resolves within the budget, or null. */
  private async findFirst(page: Page, selectors: readonly string[], timeout: number): Promise<string | null> {
    const per = Math.max(2000, Math.floor(timeout / selectors.length));
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: per, state: 'attached' });
        return selector;
      } catch {
        // try the next candidate
      }
    }
    return null;
  }

  private timeout(): number {
    return Number(this.config.get<string>(`${this.envPrefix}_TIMEOUT_MS`, '120000'));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** ChatGPT (chatgpt.com) as a buyer sees it. */
@Injectable()
export class ChatGptBrowserAdapter extends BrowserSurfaceAdapterBase {
  readonly name = 'chatgpt-browser' as const;
  protected readonly profileKey = 'chatgpt';
  protected readonly envPrefix = 'AEO_CHATGPT';
}

/** Perplexity (perplexity.ai) as a buyer sees it. */
@Injectable()
export class PerplexityBrowserAdapter extends BrowserSurfaceAdapterBase {
  readonly name = 'perplexity-browser' as const;
  protected readonly profileKey = 'perplexity';
  protected readonly envPrefix = 'AEO_PERPLEXITY';
}

/** Gemini (gemini.google.com) as a buyer sees it. */
@Injectable()
export class GeminiBrowserAdapter extends BrowserSurfaceAdapterBase {
  readonly name = 'gemini-browser' as const;
  protected readonly profileKey = 'gemini';
  protected readonly envPrefix = 'AEO_GEMINI';
}
