/**
 * Browser Client Service — Playwright headless browser for JS rendering.
 *
 * Used for the JS render dependency check and high-fidelity page capture.
 * Maintains a singleton browser instance and manages page lifecycle.
 *
 * @module fetcher.browser-client
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium, type Browser, type Page } from 'playwright';
import type { RenderOptions, RenderResult } from '../fetcher.types';

@Injectable()
export class BrowserClientService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserClientService.name);
  private browser: Browser | null = null;

  /**
   * Lazily initialize the Chromium browser instance.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.logger.log('Launching Chromium browser...');
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      });
      this.logger.log('Chromium browser launched');
    }
    return this.browser;
  }

  /**
   * Render a page with optional JS disabled.
   *
   * When jsDisabled is true, blocks all script resources via route interception,
   * simulating how a non-JS-executing AI crawler would see the page.
   *
   * @returns RenderResult with HTML, extracted text, title, and optional screenshot
   */
  async render(opts: RenderOptions): Promise<RenderResult> {
    const browser = await this.ensureBrowser();
    const timeout = opts.timeout || 30_000;
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    try {
      // If JS disabled, block script tags
      if (opts.jsDisabled) {
        await page.route('**/*', (route) => {
          const resourceType = route.request().resourceType();
          if (resourceType === 'script' || resourceType === 'xhr' || resourceType === 'fetch') {
            route.abort();
          } else {
            route.continue();
          }
        });
      }

      const startTime = performance.now();
      await page.goto(opts.url, {
        waitUntil: opts.jsDisabled ? 'domcontentloaded' : 'networkidle',
        timeout,
      });

      // Give a short delay for any lazy-loaded content (only when JS is enabled)
      if (!opts.jsDisabled) {
        await page.waitForTimeout(1500);
      }

      const html = await page.content();
      const text = await page.evaluate(() => document.body?.innerText || '');
      const title = await page.title();
      const latencyMs = Math.round(performance.now() - startTime);

      let screenshot: string | undefined;
      if (opts.screenshot) {
        const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
        screenshot = screenshotBuffer.toString('base64');
      }

      return {
        url: opts.url,
        finalUrl: page.url(),
        html,
        text: text.trim(),
        title,
        screenshot,
        timing: { latencyMs },
        jsDisabled: opts.jsDisabled || false,
      };
    } catch (err) {
      const latencyMs = Math.round(performance.now());
      this.logger.warn(`Browser render failed for ${opts.url}: ${(err as Error).message}`);
      return {
        url: opts.url,
        finalUrl: opts.url,
        html: '',
        text: '',
        title: '',
        timing: { latencyMs: 0 },
        jsDisabled: opts.jsDisabled || false,
      };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  /**
   * Clean up the browser instance on module destroy.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      this.logger.log('Closing Chromium browser...');
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}