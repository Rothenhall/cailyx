/**
 * Technical Audit Service — Runs all AI visibility access checks.
 *
 * Eight checks, ordered so the cheap access questions answer before the
 * expensive site-wide crawl (there is no point scoring 150 pages a crawler
 * cannot reach):
 *
 *   1. robots.txt AI-bot blocks  — Can AI crawlers read the site per robots.txt?
 *   2. CDN AI-bot blocking probe — Does the CDN silently block them anyway?
 *   3. Sitemap                   — Present, and actually being kept up to date?
 *   4. JS render dependency      — Can non-JS AI crawlers read the content?
 *   5. Lighthouse / CWV          — Full PSI run: 4 categories, all failing audits.
 *   6. Schema (FR-3.2)           — JSON-LD, Organization/Person, sameAs.
 *   7. Agent readiness           — Vercel/Ora `is-agentic` score.
 *   8. Page inventory            — Every sitemap URL: JSON-LD, title/meta lengths, H1.
 *
 * Also captures page metadata (FR-3.5), generates reproduction commands
 * (FR-2.6), rolls the checks into one 0-100 composite, and diffs the run
 * against the project's previous audit so a series is comparable.
 *
 * @module technical-audit.service
 */

import { Injectable, Logger } from '@nestjs/common';
import { FetcherService } from '../fetcher/fetcher.service';
import * as cheerio from 'cheerio';
import { PrismaService } from '../database/prisma.service';
import { SchedulingService } from '../scheduling/scheduling.service';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
import { ConfigService } from '@nestjs/config';
import {
  ALL_PROBEABLE_BOTS,
  BROWSER_CONTROL,
  TRAINING_CRAWLERS,
  SEARCH_CRAWLERS,
  LIVE_FETCH_AGENTS,
  POLICY_TOKENS,
} from '../fetcher/fetcher.constants';
import { SitemapCheckService } from './checks/sitemap.check';
import { AgentReadinessCheckService } from './checks/agent-readiness.check';
import { PageInventoryCheckService } from './checks/page-inventory.check';
import { AuditNarrativeService } from './checks/audit-narrative.service';
import { buildComparison, computeDeltas, type ComparableRun } from './technical-audit.deltas';
import { ISSUE_LABELS } from './checks/seo-rubric';
import type {
  AuditCheckType,
  AgentReadinessAnalysis,
  AuditDelta,
  AuditPageResult,
  PageInventoryAnalysis,
  SitemapAnalysis,
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
    private readonly pipelineQueue: PipelineQueueService,
    private readonly configService: ConfigService,
    private readonly sitemapCheck: SitemapCheckService,
    private readonly agentReadinessCheck: AgentReadinessCheckService,
    private readonly pageInventoryCheck: PageInventoryCheckService,
    private readonly narrative: AuditNarrativeService,
  ) {
    // Register handler for scheduled technical audits (cron/BullMQ scheduling backend)
    this.scheduling.registerHandler('technical-audit', async (projectId, targetUrl) => {
      await this.runAudit(targetUrl, projectId, 'scheduled');
    });

    // Register handler for manually-triggered audits queued via PipelineQueueService
    this.pipelineQueue.registerHandler('technical-audit', (data: {
      targetUrl: string; projectId: string; triggeredBy: 'manual' | 'scheduled';
    }) => this.runAudit(data.targetUrl, data.projectId, data.triggeredBy));
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
  private get sitemapStaleDays(): number { return this.configService.get<number>('technicalAudit.thresholds.sitemapStaleDays', 90) ?? 90; }
  private get pageCrawlBudget(): number { return this.configService.get<number>('technicalAudit.pageCrawlBudget', 150) ?? 150; }
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

    // Each check is isolated: one failing adapter must not cost the operator
    // the other seven results.
    const run = async (label: AuditCheckType, fn: () => Promise<AuditFinding>) => {
      try {
        findings.push(await fn());
      } catch (err) {
        findings.push(this.errorFinding(label, (err as Error).message));
      }
    };

    await run('robots', () => this.checkRobotsTxt(targetUrl, runId));
    await run('cdn-inferred', () => this.checkCdnBlocking(targetUrl, runId));

    // The sitemap runs before the page inventory because it *is* the
    // inventory's input — its entries decide what gets crawled.
    let sitemap: SitemapAnalysis | null = null;
    await run('sitemap', async () => {
      sitemap = await this.sitemapCheck.analyze(targetUrl, runId);
      return this.sitemapFinding(sitemap);
    });

    await run('js-render', () => this.checkJsRenderDependency(targetUrl, runId));
    await run('cwv', () => this.checkCoreWebVitals(targetUrl, runId));
    await run('schema', () => this.checkSchema(targetUrl, runId));

    let readiness: AgentReadinessAnalysis | null = null;
    await run('agent-readiness', async () => {
      readiness = await this.agentReadinessCheck.analyze(targetUrl);
      return this.agentReadinessFinding(readiness);
    });

    // Site-wide crawl. Skipped rather than failed when there is no sitemap —
    // "we could not enumerate the site" is not the same claim as "the pages
    // are bad", and failing here would double-count the sitemap finding that
    // has already fired.
    let inventory: PageInventoryAnalysis | null = null;
    let pages: AuditPageResult[] = [];
    const entries = (sitemap as SitemapAnalysis | null)?.entries ?? [];
    if (entries.length) {
      await run('page-inventory', async () => {
        const res = await this.pageInventoryCheck.analyze(entries, runId, this.pageCrawlBudget, targetUrl);
        inventory = res.analysis;
        pages = res.pages;
        return this.pageInventoryFinding(res.analysis);
      });
    } else {
      findings.push({
        type: 'page-inventory',
        status: 'not-run',
        detail: { reason: 'No sitemap URLs to crawl', discovered: 0, crawled: 0 },
        severity: 'low',
        confidence: 'confirmed',
        recommendedFix:
          'Publish a sitemap.xml listing your indexable pages and declare it in robots.txt. ' +
          'Without one, the per-page structured-data and metadata audit cannot enumerate the site.',
      });
    }

    // Capture page metadata (FR-3.5) — for downstream entity/findings stages
    let pageMetadata: PageMetadata | undefined;
    try {
      pageMetadata = await this.capturePageMetadata(targetUrl, runId);
    } catch (err) {
      this.logger.warn(`Failed to capture page metadata: ${(err as Error).message}`);
    }

    const score = this.computeComposite(findings, inventory, readiness);

    // Diff against the project's previous run BEFORE this one is written, so
    // "previous" is unambiguous even if two audits overlap.
    const { previousAuditId, previousScore, previousAt, previousNarrative, deltas } =
      await this.diffAgainstPrevious(projectId, {
      id: runId,
      createdAt: new Date().toISOString(),
      score,
      findings,
      pages,
    });

    const audit: TechnicalAudit = {
      id: runId,
      projectId,
      triggeredBy,
      createdAt: new Date().toISOString(),
      findings,
      targetUrl,
      score,
      previousAuditId,
      deltas,
      sitemapUrl: (sitemap as SitemapAnalysis | null)?.sitemapUrl ?? null,
      pagesCrawled: pages.length,
      pages,
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
    if (totalCost > this.maxCostPerRun) {
      this.logger.warn(
        `Audit ${runId} cost $${totalCost.toFixed(4)}, over the $${this.maxCostPerRun} per-run ceiling`,
      );
    }

    // Persist to database
    try {
      await this.prisma.technicalAudit.create({
        data: {
          id: audit.id,
          projectId: audit.projectId,
          targetUrl: audit.targetUrl,
          triggeredBy: audit.triggeredBy,
          score: audit.score ?? null,
          previousAuditId: audit.previousAuditId ?? null,
          deltas: JSON.stringify(audit.deltas ?? []),
          sitemapUrl: audit.sitemapUrl ?? null,
          pagesCrawled: audit.pagesCrawled ?? 0,
          observability: JSON.stringify(audit.observability ?? null),
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
          pageMetadata: audit.pageMetadata
            ? {
                create: {
                  title: audit.pageMetadata.title,
                  metaDescription: audit.pageMetadata.metaDescription,
                  headings: JSON.stringify(audit.pageMetadata.headings),
                  positioningCopy: audit.pageMetadata.positioningCopy,
                },
              }
            : undefined,
        },
      });

      // Pages are written separately and in chunks. A 150-page nested create
      // builds one enormous statement and SQLite caps host variables per
      // statement, so a large sitemap would fail the whole persist.
      if (pages.length) {
        const CHUNK = 25;
        for (let i = 0; i < pages.length; i += CHUNK) {
          await this.prisma.auditPage.createMany({
            data: pages.slice(i, i + CHUNK).map((pg) => ({
              auditId: audit.id,
              url: pg.url,
              status: pg.status,
              lastmod: pg.lastmod ? new Date(pg.lastmod) : null,
              title: pg.title,
              titleLength: pg.titleLength,
              metaDescription: pg.metaDescription,
              metaDescLength: pg.metaDescLength,
              h1Count: pg.h1Count,
              canonical: pg.canonical,
              wordCount: pg.wordCount,
              imageCount: pg.imageCount,
              imagesMissingAlt: pg.imagesMissingAlt,
              jsonLdTypes: JSON.stringify(pg.jsonLdTypes),
              jsonLdValid: pg.jsonLdValid,
              jsonLdCount: pg.jsonLdCount,
              issues: JSON.stringify(pg.issues),
              score: pg.score,
            })),
          });
        }
      }
      this.logger.debug(`Audit persisted to DB: ${audit.id} (${pages.length} pages)`);
    } catch (err) {
      this.logger.warn('Failed to persist audit to DB: ' + (err as Error).message);
    }

    // Narrative last, and deliberately after the write. It is the only step
    // that leaves the machine for a model, so it must not be able to cost us
    // the run: the audit is already durable by this point, and a failure here
    // leaves `narrative` null with every number intact.
    try {
      const written = await this.narrative.write({
        domain: new URL(targetUrl).hostname,
        targetUrl,
        currentScore: score,
        previousScore,
        currentAt: audit.createdAt,
        previousAt,
        deltas,
        findings: findings.map((f) => ({
          type: f.type,
          status: f.status,
          severity: f.severity,
          recommendedFix: f.recommendedFix,
        })),
        inventory,
        // Keyed by check type so the narrator can read a check's own numbers
        // rather than inferring them from the derived deltas.
        details: Object.fromEntries(findings.map((f) => [f.type, f.detail])),
        previousNarrative,
      });
      if (written) {
        audit.narrative = written.text;
        audit.narrativeModel = written.model;
        // The narrative is billed separately from the fetcher, and it runs
        // after the row is written, so add its cost back into observability.
        if (audit.observability && written.costUsd > 0) {
          audit.observability.totalCostUsd =
            (audit.observability.totalCostUsd ?? 0) + written.costUsd;
        }
        await this.prisma.technicalAudit.update({
          where: { id: audit.id },
          data: {
            narrative: written.text,
            narrativeModel: written.model,
            narrativeAt: new Date(),
            observability: JSON.stringify(audit.observability ?? null),
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Narrative step failed: ${(err as Error).message}`);
    }

    const failCount = findings.filter((f) => f.status === 'fail').length;
    this.logger.log(
      `Technical audit complete for ${targetUrl}: score ${audit.score ?? 'n/a'}, ` +
        `${failCount} failures across ${findings.length} checks, ${pages.length} pages crawled`,
    );

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
      // One Lighthouse pass already produced all of this; keeping only the
      // three CWV numbers threw away the SEO and accessibility verdicts.
      categories: psiResult.categories,
      failedAudits: psiResult.failedAudits,
      fieldData: psiResult.fieldData,
      finalUrl: psiResult.finalUrl,
      lighthouseVersion: psiResult.lighthouseVersion,
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

  // ─── Findings for the three new checks ─────────────────────────

  /**
   * Sitemap finding. Presence is necessary but not sufficient — the failure
   * that actually matters is a sitemap nobody maintains, so a found-but-stale
   * sitemap fails just as a missing one does, with a different fix.
   */
  private sitemapFinding(a: SitemapAnalysis): AuditFinding {
    if (!a.found) {
      return {
        type: 'sitemap',
        status: 'fail',
        detail: a as unknown as Record<string, unknown>,
        severity: 'high',
        confidence: 'confirmed',
        recommendedFix:
          `No sitemap was found (tried: ${a.triedUrls.join(', ') || 'none'}). ` +
          'Publish /sitemap.xml with a <lastmod> on every URL and declare it in robots.txt ' +
          'with a "Sitemap:" line. Without one, crawlers discover pages only by following links, ' +
          'and orphaned pages are never found at all.',
      };
    }

    const problems: string[] = [];
    if (a.urlCount === 0) problems.push('the sitemap is empty');
    if (a.withLastmod === 0) problems.push('no URL declares a <lastmod>');
    if (a.staleDays !== null && a.staleDays > this.sitemapStaleDays) {
      problems.push(`the newest <lastmod> is ${a.staleDays} days old`);
    }
    if (!a.declaredInRobots) problems.push('it is not declared in robots.txt');
    if (a.offOriginCount > 0) problems.push(`${a.offOriginCount} URLs point off-origin`);
    if (a.duplicateCount > 0) problems.push(`${a.duplicateCount} URLs are duplicated`);

    // A missing <lastmod> or a stale one is the "is it maintained?" question
    // from the brief; the cosmetic problems alone are not worth a failure.
    const material =
      a.urlCount === 0 ||
      a.withLastmod === 0 ||
      (a.staleDays !== null && a.staleDays > this.sitemapStaleDays);

    return {
      type: 'sitemap',
      status: material ? 'fail' : 'pass',
      detail: a as unknown as Record<string, unknown>,
      severity: a.urlCount === 0 ? 'high' : material ? 'medium' : 'low',
      confidence: 'confirmed',
      recommendedFix: problems.length
        ? `Sitemap found at ${a.sitemapUrl} with ${a.urlCount} URLs, but ${problems.join('; ')}. ` +
          'Emit <lastmod> from your build so freshness is real rather than asserted, and ' +
          'declare the sitemap in robots.txt.'
        : `Sitemap is healthy: ${a.urlCount} URLs, ${a.withLastmod} with <lastmod>, ` +
          `most recent change ${a.staleDays} days ago.`,
    };
  }

  /** Agent-readiness finding from the is-agentic score. */
  private agentReadinessFinding(a: AgentReadinessAnalysis): AuditFinding {
    if (a.score === null) {
      return {
        type: 'agent-readiness',
        status: 'not-run',
        detail: a as unknown as Record<string, unknown>,
        severity: 'low',
        // The scan did not happen, so nothing here was observed.
        confidence: 'inferred',
        recommendedFix:
          `Agent-readiness could not be scored: ${a.error ?? 'unknown reason'}. ` +
          'Run `npx is-agentic <domain>` locally to confirm the scanner can reach the site.',
      };
    }

    const failed = a.issues.filter((i) => i.result === 'failed');
    const partial = a.issues.filter((i) => i.result === 'partial');

    return {
      type: 'agent-readiness',
      status: a.score >= 80 ? 'pass' : 'fail',
      detail: a as unknown as Record<string, unknown>,
      severity: a.score < 50 ? 'high' : a.score < 80 ? 'medium' : 'low',
      confidence: 'confirmed',
      recommendedFix:
        `is-agentic scores this site ${a.score}/100 (${a.scoreLabel ?? 'unlabelled'}) across ` +
        `${a.eligibleChecks ?? 0} eligible checks. ` +
        (failed.length || partial.length
          ? `${failed.length} failed and ${partial.length} partial: ` +
            [...failed, ...partial].slice(0, 5).map((i) => i.name).join(', ') +
            `. Full report: ${a.reportUrl ?? 'n/a'}`
          : `No outstanding issues. Full report: ${a.reportUrl ?? 'n/a'}`),
    };
  }

  /** Site-wide per-page finding. */
  private pageInventoryFinding(a: PageInventoryAnalysis): AuditFinding {
    const truncated = a.discovered > a.crawled;
    const top = Object.entries(a.issueCounts)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([code, n]) => `${n}× ${ISSUE_LABELS[code as keyof typeof ISSUE_LABELS] ?? code}`);

    const bad = a.averageScore !== null && a.averageScore < 70;

    return {
      type: 'page-inventory',
      status: a.errored === a.crawled && a.crawled > 0 ? 'error' : bad ? 'fail' : 'pass',
      detail: a as unknown as Record<string, unknown>,
      severity: bad ? 'medium' : 'low',
      confidence: 'confirmed',
      recommendedFix:
        `Crawled ${a.crawled} of ${a.discovered} sitemap URLs` +
        (truncated ? ` (budget ${a.budget}, newest-changed first)` : '') +
        `. Average page score ${a.averageScore ?? 'n/a'}/100. ` +
        (top.length ? `Most common: ${top.join(', ')}. ` : '') +
        (a.pagesWithoutJsonLd
          ? `${a.pagesWithoutJsonLd} pages carry no JSON-LD — that is the single highest-leverage fix, ` +
            'since it is what lets an assistant quote the page as a source.'
          : 'Every crawled page carries JSON-LD.') +
        // Stage-4 residue, reported as work items rather than left in
        // `issueCounts` for someone to notice. Each clause appears only when
        // there is something to say -- a clean site should not read as a list
        // of zeros.
        (a.imagesMissingAlt
          ? ` ${a.imagesMissingAlt} of ${a.imagesTotal} content images have no alt text` +
            (a.pagesWithMissingAlt ? ` (${a.pagesWithMissingAlt} pages affected)` : '') +
            '. Empty alt="" on a decorative image is correct and is not counted here.'
          : '') +
        (a.pagesWithDuplicateContent
          ? ` ${a.pagesWithDuplicateContent} pages serve body copy identical to another page — ` +
            'consolidate them or set a canonical, or they compete with each other.'
          : '') +
        (a.pagesThin ? ` ${a.pagesThin} pages are under the word-count floor.` : ''),
    };
  }

  // ─── Composite score ───────────────────────────────────────────

  /**
   * Roll the checks into one 0-100 number.
   *
   * The weights below are disclosed rather than tuned: they encode a claim
   * about what actually stops an AI assistant using a site, in order —
   * can it fetch the page at all, can it read it without JS, is there
   * structured data to quote, is the copy usable, is it fast.
   *
   * Components that did not run are dropped and the remainder is
   * renormalised. That is a deliberate departure from the "never renormalize"
   * rule elsewhere in the codebase: here a component can be genuinely absent
   * (no PSI key, no sitemap), and scoring an unrun check as zero would report
   * a configuration gap as a site defect.
   */
  private computeComposite(
    findings: AuditFinding[],
    inventory: PageInventoryAnalysis | null,
    readiness: AgentReadinessAnalysis | null,
  ): number | null {
    const weights = { access: 25, rendering: 15, structured: 20, content: 15, performance: 15, agent: 10 };
    const parts: Array<{ weight: number; value: number }> = [];
    const by = (t: string) => findings.find((f) => f.type === t);

    // access — robots + CDN, scored on what fraction of probed bots got through
    const cdn = by('cdn-inferred');
    const robots = by('robots');
    if (cdn || robots) {
      const d = cdn?.detail as { probes?: unknown[]; blockedBots?: unknown[] } | undefined;
      const probed = Array.isArray(d?.probes) ? d!.probes!.length : 0;
      const blocked = Array.isArray(d?.blockedBots) ? d!.blockedBots!.length : 0;
      const cdnScore = probed > 0 ? Math.round(((probed - blocked) / probed) * 100) : cdn?.status === 'pass' ? 100 : 50;
      const robotsScore = robots ? (robots.status === 'pass' ? 100 : 40) : cdnScore;
      parts.push({ weight: weights.access, value: Math.round((cdnScore + robotsScore) / 2) });
    }

    // rendering — the JS-dependency check, expressed as content retained
    const js = by('js-render');
    if (js && js.status !== 'error' && js.status !== 'not-run') {
      const loss = (js.detail as { contentLossPercent?: number })?.contentLossPercent;
      parts.push({
        weight: weights.rendering,
        value: typeof loss === 'number' ? Math.max(0, Math.round(100 - loss)) : js.status === 'pass' ? 100 : 50,
      });
    }

    // structured data — homepage schema, plus site-wide JSON-LD coverage
    const schema = by('schema');
    const structuredParts: number[] = [];
    if (schema && schema.status !== 'error') structuredParts.push(schema.status === 'pass' ? 100 : 40);
    if (inventory && inventory.crawled > 0) {
      structuredParts.push(Math.round(((inventory.crawled - inventory.pagesWithoutJsonLd) / inventory.crawled) * 100));
    }
    if (structuredParts.length) {
      parts.push({
        weight: weights.structured,
        value: Math.round(structuredParts.reduce((a, b) => a + b, 0) / structuredParts.length),
      });
    }

    // content — the per-page rubric average
    if (inventory?.averageScore !== null && inventory?.averageScore !== undefined) {
      parts.push({ weight: weights.content, value: inventory.averageScore });
    }

    // performance — Lighthouse performance category
    const cwv = by('cwv');
    const perf = (cwv?.detail as { performanceScore?: number })?.performanceScore;
    if (typeof perf === 'number') parts.push({ weight: weights.performance, value: perf });

    // agent readiness — is-agentic
    if (readiness?.score !== null && readiness?.score !== undefined) {
      parts.push({ weight: weights.agent, value: readiness.score });
    }

    if (!parts.length) return null;
    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    const weighted = parts.reduce((s, p) => s + p.value * p.weight, 0);
    return Math.max(0, Math.min(100, Math.round(weighted / totalWeight)));
  }

  // ─── Run-over-run comparison ───────────────────────────────────

  /** Load the project's most recent stored run and diff the new one against it. */
  private async diffAgainstPrevious(
    projectId: string,
    current: ComparableRun,
  ): Promise<{
    previousAuditId: string | null;
    previousScore: number | null;
    previousAt: string | null;
    previousNarrative: string | null;
    deltas: AuditDelta[];
  }> {
    const none = {
      previousAuditId: null,
      previousScore: null,
      previousAt: null,
      previousNarrative: null,
    };
    try {
      // Only diff against a run that actually completed. A failed/partial
      // run (score null, no findings) in the chain would report every metric
      // as "new" on the next run and pollute the trend.
      const prev = await this.prisma.technicalAudit.findFirst({
        where: { projectId, score: { not: null } },
        orderBy: { createdAt: 'desc' },
        include: { findings: true, pages: true },
      });
      if (!prev) return { ...none, deltas: computeDeltas(current, null) };
      return {
        previousAuditId: prev.id,
        previousScore: prev.score,
        previousAt: prev.createdAt.toISOString(),
        // The previous run's commentary becomes this run's memory.
        previousNarrative: prev.narrative,
        deltas: computeDeltas(current, this.toComparable(prev)),
      };
    } catch (err) {
      this.logger.warn(`Could not diff against previous audit: ${(err as Error).message}`);
      return { ...none, deltas: [] };
    }
  }

  /**
   * Rehydrate a stored run into the differ's shape. `detail` and `issues` come
   * back as JSON strings because SQLite has no JSON column; anything that
   * fails to parse degrades to an empty value rather than throwing, since a
   * single malformed row must not break the whole comparison.
   */
  private toComparable(row: {
    id: string;
    createdAt: Date;
    score: number | null;
    findings: Array<{ type: string; status: string; severity: string; detail: string }>;
    pages: Array<{ url: string; score: number | null; issues: string | null }>;
  }): ComparableRun {
    const parse = <T>(raw: string | null, fallback: T): T => {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };

    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      score: row.score,
      findings: row.findings.map((f) => ({
        type: f.type as AuditCheckType,
        status: f.status as AuditFinding['status'],
        severity: f.severity as AuditFinding['severity'],
        detail: parse<unknown>(f.detail, {}),
      })),
      pages: row.pages.map((pg) => ({
        url: pg.url,
        score: pg.score ?? 0,
        issues: parse<AuditPageResult['issues']>(pg.issues, []),
      })),
    };
  }

  /**
   * Full comparison between a run and the one before it, for the trend view.
   * Returns null when the audit does not belong to the project.
   */
  async getComparison(projectId: string, auditId: string) {
    const current = await this.prisma.technicalAudit.findFirst({
      where: { id: auditId, projectId },
      include: { findings: true, pages: true },
    });
    if (!current) return null;

    const previous = await this.prisma.technicalAudit.findFirst({
      where: { projectId, score: { not: null }, createdAt: { lt: current.createdAt } },
      orderBy: { createdAt: 'desc' },
      include: { findings: true, pages: true },
    });

    return buildComparison(this.toComparable(current), previous ? this.toComparable(previous) : null);
  }

  /**
   * The project's score history, oldest first — the series a sparkline needs.
   */
  async getTrend(projectId: string, limit = 30) {
    const rows = await this.prisma.technicalAudit.findMany({
      where: { projectId, score: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        createdAt: true,
        score: true,
        targetUrl: true,
        pagesCrawled: true,
        triggeredBy: true,
        findings: { select: { status: true } },
      },
    });

    return rows
      .map((r) => ({
        auditId: r.id,
        at: r.createdAt.toISOString(),
        score: r.score,
        targetUrl: r.targetUrl,
        pagesCrawled: r.pagesCrawled,
        triggeredBy: r.triggeredBy,
        failures: r.findings.filter((f) => f.status === 'fail').length,
      }))
      .reverse();
  }

}