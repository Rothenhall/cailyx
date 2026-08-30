/**
 * Technical Audit Service — Runs all AI visibility access checks.
 *
 * Five checks in order of value:
 *   1. robots.txt AI-bot blocks     — Can AI crawlers read the site per robots.txt?
 *   2. CDN AI-bot blocking probe     — Does the CDN silently block AI crawlers despite robots.txt?
 *   3. JS render dependency          — Can non-JS AI crawlers read the content?
 *   4. Core Web Vitals               — Does the site meet Google's performance thresholds?
 *   5. Schema audit (FR-3.2)         — JSON-LD structured data, Organization/Person, sameAs
 *
 * Also captures page metadata (FR-3.5) and generates reproduction commands (FR-2.6).
 *
 * @module technical-audit.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { FetcherService } from '../fetcher/fetcher.service';
import * as cheerio from 'cheerio';
import { PrismaService } from '../database/prisma.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { ConfigService } from '@nestjs/config';
import {
  ALL_PROBEABLE_BOTS,
  BROWSER_CONTROL,
  TRAINING_CRAWLERS,
  SEARCH_CRAWLERS,
  LIVE_FETCH_AGENTS,
  POLICY_TOKENS,
} from '../fetcher/fetcher.constants';
import type {
  AuditFinding,
  TechnicalAudit,
  RobotsAnalysis,
  RobotsRule,
  CdnAnalysis,
  CdnProbeResult,
  JsRenderAnalysis,
  CwvAnalysis,
  SchemaAnalysis,
  PageMetadata,
  HeadingInfo,
  ReproductionCommand,
  BlockLayer,
} from './technical-audit.types';

@Injectable()
export class TechnicalAuditService {
  private readonly logger = new Logger(TechnicalAuditService.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly prisma: PrismaService,
    private readonly scheduling: SchedulingService,
    private readonly configService: ConfigService,
  ) {
    // Register handler for scheduled technical audits
    this.scheduling.registerHandler('technical-audit', async (projectId, targetUrl) => {
      await this.runAudit(targetUrl, projectId, 'scheduled');
    });
  }

  // Configurable thresholds (P2 #13)
  private get jsDependencyPercent(): number { return this.configService.get<number>('technicalAudit.thresholds.jsRenderDependencyPercent', 70) ?? 70; }
  private get jsContentLossFailPercent(): number { return this.configService.get<number>('technicalAudit.thresholds.jsRenderContentLossFailPercent', 30) ?? 30; }
  private get lcpGoodMs(): number { return this.configService.get<number>('technicalAudit.thresholds.lcpGoodMs', 2500) ?? 2500; }
  private get lcpNeedsImprovementMs(): number { return this.configService.get<number>('technicalAudit.thresholds.lcpNeedsImprovementMs', 4000) ?? 4000; }
  private get clsGood(): number { return this.configService.get<number>('technicalAudit.thresholds.clsGood', 0.1) ?? 0.1; }
  private get clsNeedsImprovement(): number { return this.configService.get<number>('technicalAudit.thresholds.clsNeedsImprovement', 0.25) ?? 0.25; }
  private get inpGoodMs(): number { return this.configService.get<number>('technicalAudit.thresholds.inpGoodMs', 200) ?? 200; }
  private get inpNeedsImprovementMs(): number { return this.configService.get<number>('technicalAudit.thresholds.inpNeedsImprovementMs', 500) ?? 500; }
  private get maxCostPerRun(): number { return this.configService.get<number>('technicalAudit.maxCostPerRunUsd', 5.0) ?? 5.0; }

  /**
   * Run a complete technical audit for a target URL.
   * Executes all 5 checks, captures page metadata, and returns a combined TechnicalAudit.
   */
  async runAudit(
    targetUrl: string,
    projectId: string,
    triggeredBy: 'manual' | 'scheduled' = 'manual',
  ): Promise<TechnicalAudit> {
    const runId = `audit_${Date.now()}`;
    this.logger.log(`Starting technical audit for ${targetUrl} (run: ${runId})`);

    const findings: AuditFinding[] = [];

    // Check 1: robots.txt
    try {
      const robotsFinding = await this.checkRobotsTxt(targetUrl, runId);
      findings.push(robotsFinding);
    } catch (err) {
      findings.push(this.errorFinding('robots', (err as Error).message));
    }

    // Check 2: CDN AI-bot blocking probe
    try {
      const cdnFinding = await this.checkCdnBlocking(targetUrl, runId);
      findings.push(cdnFinding);
    } catch (err) {
      findings.push(this.errorFinding('cdn-inferred', (err as Error).message));
    }

    // Check 3: JS render dependency
    try {
      const jsFinding = await this.checkJsRenderDependency(targetUrl, runId);
      findings.push(jsFinding);
    } catch (err) {
      findings.push(this.errorFinding('js-render', (err as Error).message));
    }

    // Check 4: Core Web Vitals
    try {
      const cwvFinding = await this.checkCoreWebVitals(targetUrl, runId);
      findings.push(cwvFinding);
    } catch (err) {
      findings.push(this.errorFinding('cwv', (err as Error).message));
    }

    // Check 5: Schema (FR-3.2)
    try {
      const schemaFinding = await this.checkSchema(targetUrl, runId);
      findings.push(schemaFinding);
    } catch (err) {
      findings.push(this.errorFinding('schema', (err as Error).message));
    }

    // Capture page metadata (FR-3.5) — for downstream entity/findings stages
    let pageMetadata: PageMetadata | undefined;
    try {
      pageMetadata = await this.capturePageMetadata(targetUrl, runId);
    } catch (err) {
      this.logger.warn(`Failed to capture page metadata: ${(err as Error).message}`);
    }

    const audit: TechnicalAudit = {
      id: runId,
      projectId,
      triggeredBy,
      createdAt: new Date().toISOString(),
      findings,
      targetUrl,
      pageMetadata,
    };

    // Capture observability data (P2 #15 — PRD §12 cost + timing per run)
    const fetcherLogs = this.fetcher.getLogsByRun(runId);
    const totalCost = this.fetcher.getRunCost(runId);
    const cacheHits = fetcherLogs.filter((l) => l.cached).length;
    const totalLatency = fetcherLogs.reduce((sum, l) => sum + l.latencyMs, 0);
    audit.observability = {
      totalCostUsd: totalCost,
      fetcherLogCount: fetcherLogs.length,
      totalLatencyMs: totalLatency,
      probesRun: fetcherLogs.filter((l) => l.method === 'probe').length,
      checksRun: findings.length,
      cacheHitRate: fetcherLogs.length > 0 ? cacheHits / fetcherLogs.length : 0,
    };
    // Persist to database
    try {
      const dbAudit = await this.prisma.technicalAudit.create({
        data: {
          id: audit.id,
          projectId: audit.projectId,
          targetUrl: audit.targetUrl,
          triggeredBy: audit.triggeredBy,
          findings: {
            create: audit.findings.map((f) => ({
              type: f.type,
              status: f.status,
              severity: f.severity,
              confidence: f.confidence,
              detail: JSON.stringify(f.detail),
              recommendedFix: f.recommendedFix,
              reproductionCommands: JSON.stringify(f.reproductionCommands),
            })),
          },
          pageMetadata: audit.pageMetadata ? {
            create: {
              title: audit.pageMetadata.title,
              metaDescription: audit.pageMetadata.metaDescription,
              headings: JSON.stringify(audit.pageMetadata.headings),
              positioningCopy: audit.pageMetadata.positioningCopy,
            },
          } : undefined,
        },
      });
      this.logger.debug('Audit persisted to DB: ' + dbAudit.id);
    } catch (err) {
      this.logger.warn('Failed to persist audit to DB: ' + (err as Error).message);
    }

    const failCount = findings.filter((f) => f.status === 'fail').length;
    this.logger.log(`Technical audit complete for ${targetUrl}: ${failCount} failures, ${findings.length} findings`);

    return audit;
  }

  // ─── Check 1: robots.txt ───────────────────────────────────────

  /**
   * Fetch and parse robots.txt, checking for AI bot disallow rules.
   * Tags each rule with layer: 'robots.txt' (PRD data model).
   */
  private async checkRobotsTxt(targetUrl: string, runId: string): Promise<AuditFinding> {
    const robotsUrl = this.getRobotsUrl(targetUrl);
    this.logger.debug(`Checking robots.txt at ${robotsUrl}`);

    const result = await this.fetcher.fetch(
      { url: robotsUrl, bypassCache: false, cacheTtlSeconds: 86400 },
      'technical-audit',
      runId,
    );

    const analysis = this.analyzeRobotsTxt(result.body, result.status);

    const blockedBots = analysis.rules
      .filter((r) => r.disallowed && (r.paths.includes('/') || r.paths.includes('/*')))
      .map((r) => r.botName);

    const hasBlock = blockedBots.length > 0;
    const status = analysis.missingRobotsTxt ? 'fail' : hasBlock ? 'fail' : 'pass';
    const severity = blockedBots.some((b) => SEARCH_CRAWLERS.some((s) => s.name === b))
      ? 'high'
      : blockedBots.length > 0
        ? 'medium'
        : 'low';

    const blockedTraining = blockedBots.filter((b) => TRAINING_CRAWLERS.some((t) => t.name === b));
    const blockedSearch = blockedBots.filter((b) => SEARCH_CRAWLERS.some((s) => s.name === b));
    const blockedLiveFetch = blockedBots.filter((b) => LIVE_FETCH_AGENTS.some((l) => l.name === b));

    let fix = '';
    if (analysis.missingRobotsTxt) {
      fix = 'No robots.txt found. Create one with explicit Allow rules for AI crawlers to ensure they can access the site.';
    } else if (blockedSearch.length > 0) {
      fix = `Search/index crawlers are BLOCKED: ${blockedSearch.join(', ')}. These bots feed AI answer engines — blocking them removes the site from AI answers. Remove the Disallow rules for these bots in robots.txt.`;
    } else if (blockedLiveFetch.length > 0) {
      fix = `Live-fetch agents are blocked: ${blockedLiveFetch.join(', ')}. Users cannot ask AI assistants to "summarize this page". Consider allowing these bots.`;
    } else if (blockedTraining.length > 0) {
      fix = `Training crawlers are blocked: ${blockedTraining.join(', ')}. The site will not be included in model training data. This is a deliberate choice — verify it is intentional.`;
    } else {
      fix = 'No AI bot blocks detected in robots.txt. All AI crawlers are allowed.';
    }

    return {
      type: 'robots',
      status,
      detail: {
        robotsUrl,
        statusCode: result.status,
        layer: 'robots.txt' as BlockLayer,
        robotsTxtFound: !analysis.missingRobotsTxt,
        blockedBots,
        blockedTraining,
        blockedSearch,
        blockedLiveFetch,
        rules: analysis.rules,
        rawContent: analysis.rawContent.substring(0, 2000),
      },
      severity,
      confidence: 'confirmed',
      recommendedFix: fix,
      reproductionCommands: this.generateReproductionCommands(targetUrl, [], robotsUrl),
    };
  }

  /**
   * Parse robots.txt content and extract rules for each AI bot.
   *
   * Implements proper robots.txt grouping:
   * - Consecutive User-agent lines belong to the same group (per RFC spec)
   * - User-agent: * expands to ALL bots when no bot-specific rule exists
   * - Allow overrides Disallow for the same path (longest-match precedence)
   */
  private analyzeRobotsTxt(content: string, statusCode: number): RobotsAnalysis {
    const rules: RobotsRule[] = [];
    const missingRobotsTxt = statusCode === 404 || statusCode === 0;

    if (missingRobotsTxt) {
      return { robotsTxtFound: false, statusCode, rules: [], missingRobotsTxt: true, rawContent: '' };
    }

    const allBotNames = [
      ...TRAINING_CRAWLERS, ...SEARCH_CRAWLERS, ...LIVE_FETCH_AGENTS, ...POLICY_TOKENS,
    ].map((b) => b.name);

    interface PendingRule {
      disallowedPaths: string[];
      allowedPaths: string[];
    }

    const lines = content.split('\n');
    let currentGroup: string[] = []; // Accumulated user-agents for current group
    let currentRule: PendingRule = { disallowedPaths: [], allowedPaths: [] };
    const groupRules = new Map<string, PendingRule>(); // botName → rules

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const directive = trimmed.substring(0, colonIdx).trim().toLowerCase();
      const value = trimmed.substring(colonIdx + 1).trim();

      if (directive === 'user-agent') {
        // If we were accumulating rules and hit a new user-agent AFTER having directives,
        // flush the current group first
        if (currentRule.disallowedPaths.length > 0 || currentRule.allowedPaths.length > 0) {
          this.flushGroup(currentGroup, currentRule, groupRules);
          currentGroup = [];
          currentRule = { disallowedPaths: [], allowedPaths: [] };
        }
        // Accumulate consecutive user-agent lines into same group
        currentGroup.push(value);
      } else if (directive === 'disallow') {
        if (value) currentRule.disallowedPaths.push(value);
        else currentRule.disallowedPaths.push('/'); // Empty Disallow = disallow all
      } else if (directive === 'allow') {
        if (value) currentRule.allowedPaths.push(value);
      }
    }

    // Flush the last group
    if (currentGroup.length > 0) {
      this.flushGroup(currentGroup, currentRule, groupRules);
    }

    // Build rules array — expand wildcard to all bots
    for (const [botName, rule] of groupRules.entries()) {
      if (botName === '*') {
        // Wildcard — apply to all bots that don't have a specific rule
        for (const specificBot of allBotNames) {
          if (!groupRules.has(specificBot)) {
            rules.push(this.buildRule(specificBot, rule));
          }
        }
        // Also keep the wildcard rule itself for reporting
        rules.push(this.buildRule('*', rule));
      } else if (allBotNames.includes(botName)) {
        rules.push(this.buildRule(botName, rule));
      }
    }

    return { robotsTxtFound: true, statusCode, rules, missingRobotsTxt: false, rawContent: content };
  }

  /**
   * Flush a group of user-agents with their accumulated rules into the groupRules map.
   */
  private flushGroup(
    agents: string[],
    rule: { disallowedPaths: string[]; allowedPaths: string[] },
    groupRules: Map<string, { disallowedPaths: string[]; allowedPaths: string[] }>,
  ): void {
    for (const agent of agents) {
      groupRules.set(agent, {
        disallowedPaths: [...rule.disallowedPaths],
        allowedPaths: [...rule.allowedPaths],
      });
    }
  }

  /**
   * Build a RobotsRule from accumulated paths, applying Allow-over-Disallow precedence.
   */
  private buildRule(
    botName: string,
    rule: { disallowedPaths: string[]; allowedPaths: string[] },
  ): RobotsRule {
    // Filter out disallowed paths that are explicitly allowed (Allow overrides Disallow)
    const effectivePaths = rule.disallowedPaths.filter(
      (dp) => !rule.allowedPaths.some((ap) => ap === dp || (ap === '/' && dp === '/')),
    );

    return {
      botName,
      disallowed: effectivePaths.length > 0,
      paths: effectivePaths.length > 0 ? effectivePaths : rule.allowedPaths,
      layer: 'robots.txt',
    };
  }

  // ─── Check 2: CDN AI-bot blocking probe ────────────────────────

  /**
   * Probe the site with each AI bot User-Agent and compare against a browser control.
   * Tags each probe with layer: 'cdn-waf' (PRD data model).
   */
  private async checkCdnBlocking(targetUrl: string, runId: string): Promise<AuditFinding> {
    this.logger.debug(`Running CDN blocking probe for ${targetUrl}`);

    const controlResult = await this.fetcher.fetch(
      { url: targetUrl, bypassCache: true, cacheTtlSeconds: 0 },
      'technical-audit',
      runId,
    );

    const cdnVendor = this.detectCdnVendor(controlResult.headers);
    const detectedFromHeaders = this.getCdnHeaderSignals(controlResult.headers);

    const probes: CdnProbeResult[] = [];
    const CONCURRENCY = 5; // Max 5 concurrent probes — rate limiter still enforced

    // Process bots in concurrent batches of 5
    for (let i = 0; i < ALL_PROBEABLE_BOTS.length; i += CONCURRENCY) {
      const batch = ALL_PROBEABLE_BOTS.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (bot) => {
          const probeResult = await this.fetcher.probe(
            { url: targetUrl, userAgent: bot.userAgent, botName: bot.name, repeat: 3, retries: 1 },
            'technical-audit',
            runId,
          );
          return {
            botName: bot.name,
            category: bot.category,
            status: probeResult.status,
            blocked: probeResult.blocked,
            latencyMs: probeResult.latencyMs,
            inconsistent: probeResult.inconsistent,
            layer: 'cdn-waf' as BlockLayer,
          };
        }),
      );
      probes.push(...batchResults);
    }

    const browserOk = controlResult.status >= 200 && controlResult.status < 400;
    const blockedBots = probes.filter((p) => p.blocked && browserOk).map((p) => p.botName);
    const silentBlockDetected = blockedBots.length > 0 && browserOk;

    const blockedSearch = blockedBots.filter((b) => SEARCH_CRAWLERS.some((s) => s.name === b));
    const blockedLiveFetch = blockedBots.filter((b) => LIVE_FETCH_AGENTS.some((l) => l.name === b));

    const severity = blockedSearch.length > 0 ? 'high' : blockedBots.length > 0 ? 'medium' : 'low';

    let fix = '';
    if (silentBlockDetected) {
      const vendor = cdnVendor || 'your CDN/WAF';
      if (blockedSearch.length > 0) {
        fix = `CRITICAL: ${vendor} is silently blocking AI search crawlers (${blockedSearch.join(', ')}). The site's robots.txt may allow them, but the CDN returns 403. Check the ${vendor} dashboard for an "AI Bot" or "Bot Management" setting and add Allow rules for these crawlers.`;
      } else {
        fix = `${vendor} appears to be blocking AI bots (${blockedBots.join(', ')}). Check the ${vendor} bot management settings. The site's robots.txt allows these bots, but the CDN is overriding it.`;
      }
    } else {
      fix = 'No CDN-level AI bot blocking detected. All AI crawlers can reach the site.';
    }

    // Build reproduction commands for blocked bots
    const blockedBotDefs = ALL_PROBEABLE_BOTS
      .filter((b) => blockedBots.includes(b.name))
      .map((b) => ({ name: b.name, userAgent: b.userAgent }));

    return {
      type: 'cdn-inferred',
      status: silentBlockDetected ? 'fail' : 'pass',
      detail: {
        cdnVendor,
        detectedFromHeaders,
        layer: 'cdn-waf' as BlockLayer,
        browserControlStatus: controlResult.status,
        silentBlockDetected,
        blockedBots,
        blockedSearch,
        blockedLiveFetch,
        probeCount: probes.length,
        probes,
      },
      severity,
      confidence: 'inferred',
      recommendedFix: fix,
      reproductionCommands: this.generateReproductionCommands(targetUrl, blockedBotDefs),
    };
  }

  /**
   * Detect CDN vendor from response headers.
   */
  private detectCdnVendor(headers: Record<string, string>): string | null {
    const server = headers['server']?.toLowerCase() || '';
    if (headers['cf-ray']) return 'Cloudflare';
    if (headers['x-amz-cf-id']) return 'AWS CloudFront';
    if (server.includes('cloudfront')) return 'AWS CloudFront';
    if (server.includes('akamai') || (headers['via']?.toLowerCase() || '').includes('akamai')) return 'Akamai';
    if (server.includes('varnish') || (headers['via']?.toLowerCase() || '').includes('varnish')) return 'Varnish/Fastly';
    if ((headers['x-served-by']?.toLowerCase() || '').includes('cache-') || (headers['via']?.toLowerCase() || '').includes('fastly')) return 'Fastly';
    if (server.includes('nginx')) return 'Nginx';
    return null;
  }

  /**
   * Get the header signals that indicated the CDN vendor.
   */
  private getCdnHeaderSignals(headers: Record<string, string>): string[] {
    const signals: string[] = [];
    for (const [key, value] of Object.entries(headers)) {
      if (['server', 'cf-ray', 'via', 'x-served-by', 'x-amz-cf-id', 'x-cache', 'x-cdn'].includes(key.toLowerCase())) {
        signals.push(`${key}: ${value}`);
      }
    }
    return signals;
  }

  // ─── Check 3: JS render dependency ─────────────────────────────

  /**
   * Render the page with JS enabled and disabled, diff the content.
   */
  private async checkJsRenderDependency(targetUrl: string, runId: string): Promise<AuditFinding> {
    this.logger.debug(`Checking JS render dependency for ${targetUrl}`);

    const withJs = await this.fetcher.render({ url: targetUrl, jsDisabled: false, timeout: 30000 }, 'technical-audit', runId);
    const withoutJs = await this.fetcher.render({ url: targetUrl, jsDisabled: true, timeout: 30000 }, 'technical-audit', runId);

    const textLengthWithJs = withJs.text.length;
    const textLengthWithoutJs = withoutJs.text.length;
    const contentLossPercent = textLengthWithJs > 0 ? Math.round((1 - textLengthWithoutJs / textLengthWithJs) * 100) : 0;
    const isJsDependent = contentLossPercent > this.jsDependencyPercent;

    const analysis: JsRenderAnalysis = {
      serverRenderedText: withoutJs.text.substring(0, 500),
      jsRenderedText: withJs.text.substring(0, 500),
      textLengthWithoutJs,
      textLengthWithJs,
      isJsDependent,
      contentLossPercent,
      titleWithoutJs: withoutJs.title,
      titleWithJs: withJs.title,
    };

    let fix = '';
    if (isJsDependent) {
      fix = `The page loses ${contentLossPercent}% of its content without JavaScript. AI crawlers like GPTBot and ClaudeBot do not execute JS, meaning they cannot read the page content. Implement server-side rendering (SSR) or static generation (SSG) so the HTML contains the content without requiring JS execution.`;
    } else if (contentLossPercent > this.jsContentLossFailPercent) {
      fix = `The page loses ${contentLossPercent}% of its content without JavaScript. Some AI crawlers may miss important content. Consider server-side rendering for critical content.`;
    } else {
      fix = 'The page is well server-rendered. Content is accessible to non-JS AI crawlers.';
    }

    return {
      type: 'js-render',
      status: isJsDependent || contentLossPercent > this.jsContentLossFailPercent ? 'fail' : 'pass',
      detail: analysis as unknown as Record<string, unknown>,
      severity: isJsDependent ? 'high' : contentLossPercent > this.jsContentLossFailPercent ? 'medium' : 'low',
      confidence: 'confirmed',
      recommendedFix: fix,
    };
  }

  // ─── Check 4: Core Web Vitals ──────────────────────────────────

  /**
   * Call Google PageSpeed Insights API for LCP, CLS, INP, and performance score.
   */
  private async checkCoreWebVitals(targetUrl: string, runId: string): Promise<AuditFinding> {
    this.logger.debug(`Checking Core Web Vitals for ${targetUrl}`);

    const psiResult = await this.fetcher.callPsiApi(targetUrl, 'technical-audit', runId);

    const lcpStatus = this.rateLcp(psiResult.lcp);
    const clsStatus = this.rateCls(psiResult.cls);
    const inpStatus = this.rateInp(psiResult.inp);

    const analysis: CwvAnalysis = {
      lcp: psiResult.lcp, cls: psiResult.cls, inp: psiResult.inp,
      performanceScore: psiResult.performanceScore, lcpStatus, clsStatus, inpStatus,
    };

    const hasPoorMetric = lcpStatus === 'poor' || clsStatus === 'poor' || inpStatus === 'poor';
    const hasNeedsImprovement = lcpStatus === 'needs-improvement' || clsStatus === 'needs-improvement' || inpStatus === 'needs-improvement';

    const failingMetrics: string[] = [];
    if (lcpStatus !== 'good') failingMetrics.push(`LCP: ${psiResult.lcp}ms (${lcpStatus})`);
    if (clsStatus !== 'good') failingMetrics.push(`CLS: ${psiResult.cls} (${clsStatus})`);
    if (inpStatus !== 'good') failingMetrics.push(`INP: ${psiResult.inp}ms (${inpStatus})`);

    let fix = '';
    if (hasPoorMetric) {
      fix = `Core Web Vitals are poor: ${failingMetrics.join(', ')}. These affect both Google search rankings and AI crawler experience. Prioritize: optimize images and fonts for LCP, prevent layout shifts for CLS, reduce JS execution time for INP.`;
    } else if (hasNeedsImprovement) {
      fix = `Core Web Vitals need improvement: ${failingMetrics.join(', ')}. Not critical but should be addressed for optimal crawl performance.`;
    } else {
      fix = 'Core Web Vitals are all good. The site performs well for both users and crawlers.';
    }

    return {
      type: 'cwv',
      status: hasPoorMetric || hasNeedsImprovement ? 'fail' : 'pass',
      detail: analysis as unknown as Record<string, unknown>,
      severity: hasPoorMetric ? 'high' : hasNeedsImprovement ? 'medium' : 'low',
      confidence: 'confirmed',
      recommendedFix: fix,
    };
  }

  // ─── Check 5: Schema (FR-3.2) ──────────────────────────────────

  /**
   * Fetch and analyze JSON-LD structured data on the page.
   * Checks for Organization/Person schema, sameAs completeness, missing fields.
   */
  private async checkSchema(targetUrl: string, runId: string): Promise<AuditFinding> {
    this.logger.debug(`Checking schema for ${targetUrl}`);

    const schemaResult = await this.fetcher.fetchSchema(targetUrl, 'technical-audit', runId);
    const schemas = schemaResult.schemas;
    const schemaTypes = schemas.map((s) => s.type);
    const hasOrganization = schemaTypes.some((t) => t.includes('Organization') || t.includes('LocalBusiness'));
    const hasPerson = schemaTypes.some((t) => t.includes('Person'));

    const sameAsUrls: string[] = [];
    for (const schema of schemas) {
      const sameAs = schema.fields['sameAs'];
      if (Array.isArray(sameAs)) {
        sameAsUrls.push(...sameAs.filter((u): u is string => typeof u === 'string'));
      } else if (typeof sameAs === 'string') {
        sameAsUrls.push(sameAs);
      }
    }

    const missingFields: string[] = [];
    if (hasOrganization) {
      const orgSchema = schemas.find((s) => s.type.includes('Organization') || s.type.includes('LocalBusiness'));
      if (orgSchema) {
        for (const field of ['name', 'url', 'logo', 'sameAs', 'description']) {
          if (!orgSchema.fields[field]) missingFields.push(field);
        }
      }
    }

    // Verify each sameAs URL — does it resolve and match the entity identity?
    const sameAsVerification = await Promise.all(
      sameAsUrls.slice(0, 10).map(async (url) => { // Limit to 10 to control cost
        try {
          const verification = await this.fetcher.verifyUrl(
            { url, expectedName: schemaResult.schemas.find(s => s.fields['name'])?.fields['name'] as string },
            'technical-audit',
            runId,
          );
          return { url, resolves: verification.resolves, identityMatch: verification.identityMatch };
        } catch {
          return { url, resolves: false, identityMatch: false };
        }
      }),
    );

    const analysis: SchemaAnalysis = {
      schemasFound: schemas.length > 0, schemaTypes, hasOrganization, hasPerson,
      sameAsCount: sameAsUrls.length, sameAsUrls, missingFields, rawSchemas: schemas,
      sameAsVerification,
    };

    let fix = '';
    if (!analysis.schemasFound) {
      fix = 'No JSON-LD structured data found. Add Organization schema with name, url, logo, description, and sameAs links to help AI assistants understand the entity.';
    } else if (missingFields.length > 0) {
      fix = `Schema found but missing recommended fields: ${missingFields.join(', ')}. Add these to improve entity recognition by AI assistants.`;
    } else {
      fix = `Schema found: ${schemaTypes.join(', ')}. ${sameAsUrls.length} sameAs links present. Structured data looks complete.`;
    }

    return {
      type: 'schema',
      status: !analysis.schemasFound || missingFields.length > 3 ? 'fail' : 'pass',
      detail: analysis as unknown as Record<string, unknown>,
      severity: !analysis.schemasFound ? 'medium' : 'low',
      confidence: 'confirmed',
      recommendedFix: fix,
    };
  }

  // ─── Page Metadata Capture (FR-3.5) ───────────────────────────

  /**
   * Capture title, meta description, headings, and positioning copy from the page.
   * Used by downstream entity-audit and findings stages.
   */
  private async capturePageMetadata(targetUrl: string, runId: string): Promise<PageMetadata> {
    this.logger.debug(`Capturing page metadata for ${targetUrl}`);
    const fetchResult = await this.fetcher.fetch({ url: targetUrl, cacheTtlSeconds: 3600 }, 'technical-audit', runId);

    return {
      title: this.extractTitle(fetchResult.body) || '',
      metaDescription: this.extractMetaDescription(fetchResult.body) || '',
      headings: this.extractHeadings(fetchResult.body),
      positioningCopy: this.extractPositioningCopy(fetchResult.body, this.extractHeadings(fetchResult.body)),
      capturedAt: new Date().toISOString(),
    };
  }

  // ─── Reproduction Commands (FR-2.6) ───────────────────────────

  /**
   * Generate exact curl reproduction commands for the report appendix.
   * These let the client verify findings independently.
   */
  private generateReproductionCommands(
    targetUrl: string,
    blockedBots: Array<{ name: string; userAgent: string }>,
    robotsUrl?: string,
  ): ReproductionCommand[] {
    const commands: ReproductionCommand[] = [];

    commands.push({
      bot: 'Browser (control)',
      command: `curl -sI -A "${BROWSER_CONTROL.userAgent}" ${targetUrl}`,
      expectedResult: 'HTTP 200 — site accessible to normal browsers',
    });

    for (const bot of blockedBots) {
      commands.push({
        bot: bot.name,
        command: `curl -sI -A "${bot.userAgent}" ${targetUrl}`,
        expectedResult: 'HTTP 403 — blocked by CDN/WAF (confirm this is the issue)',
      });
    }

    commands.push({
      bot: 'robots.txt',
      command: `curl -s ${robotsUrl || this.getRobotsUrl(targetUrl)}`,
      expectedResult: 'robots.txt content — check for Disallow rules targeting AI bots',
    });

    return commands;
  }

  // ─── CWV Rating Thresholds (Google 2026) ───────────────────────

  private rateLcp(lcpMs: number): 'good' | 'needs-improvement' | 'poor' {
    if (lcpMs <= this.lcpGoodMs) return 'good';
    if (lcpMs <= this.lcpNeedsImprovementMs) return 'needs-improvement';
    return 'poor';
  }

  private rateCls(cls: number): 'good' | 'needs-improvement' | 'poor' {
    if (cls <= this.clsGood) return 'good';
    if (cls <= this.clsNeedsImprovement) return 'needs-improvement';
    return 'poor';
  }

  private rateInp(inpMs: number): 'good' | 'needs-improvement' | 'poor' {
    if (inpMs <= this.inpGoodMs) return 'good';
    if (inpMs <= this.inpNeedsImprovementMs) return 'needs-improvement';
    return 'poor';
  }

  // ─── HTML Helpers ──────────────────────────────────────────────

  private getRobotsUrl(targetUrl: string): string {
    try {
      const parsed = new URL(targetUrl);
      return `${parsed.protocol}//${parsed.host}/robots.txt`;
    } catch {
      return `${targetUrl.replace(/\/$/, '')}/robots.txt`;
    }
  }

  private extractTitle(html: string): string | undefined {
    const $ = cheerio.load(html);
    return $('title').first().text().trim() || undefined;
  }

  private extractMetaDescription(html: string): string | undefined {
    const $ = cheerio.load(html);
    const meta = $('meta[name="description"]').attr('content') ||
                 $('meta[property="og:description"]').attr('content');
    return meta?.trim() || undefined;
  }

  private extractHeadings(html: string): HeadingInfo[] {
    const $ = cheerio.load(html);
    const headings: HeadingInfo[] = [];
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const level = parseInt(el.tagName.substring(1), 10);
      const text = $(el).text().trim();
      if (text) headings.push({ level, text });
    });
    return headings;
  }

  private extractPositioningCopy(html: string, headings: HeadingInfo[]): string {
    const $ = cheerio.load(html);
    const h1 = $('h1').first();
    if (h1.length) {
      const nextP = h1.nextAll('p').first();
      if (nextP.length) {
        const text = nextP.text().trim();
        if (text.length >= 20) return text;
      }
    }
    const firstP = $('p').filter((_, el) => $(el).text().trim().length >= 20).first();
    if (firstP.length) return firstP.text().trim();
    return headings.find((h) => h.level === 1)?.text || '';
  }

  private errorFinding(type: AuditFinding['type'], errorMsg: string): AuditFinding {
    return {
      type,
      status: 'error',
      detail: { error: errorMsg },
      severity: 'low',
      confidence: 'confirmed',
      recommendedFix: `Check failed with error: ${errorMsg}. Retry the audit or check logs.`,
    };
  }
}