/**
 * AEO Site-Context Service — P03 staged website-understanding pipeline
 * (`platform_improvement_plan.md` §9.3/§9.4).
 *
 * Replaces the old one-shot "crawl 12 pages → one synthesis pass" build with a
 * **persisted, resumable** run through six stages:
 *
 *   1. Discover   — homepage/sitemap/nav crawl, page budget enforced.
 *   2. Inspect    — metadata (title/description/headings/language/page type/
 *                   duplication) from data already fetched in stage 1.
 *   3. Select     — deterministic relevance ranking PLUS coverage reservation
 *                   by purpose category, so eleven similar blog posts cannot
 *                   crowd out the one pricing page.
 *   4. Extract    — per-page (or small-batch) structured facts, each tagged
 *                   with its source URL, an excerpt and a content hash.
 *   5. Reconcile  — merge duplicate facts, resolve conflicts, keep services
 *                   separate from plans/steps/people.
 *   6. Validate   — every assertion is checked against its own cited page
 *                   text; unsupported assertions are dropped, not guessed.
 *
 * Stage 7 (human review) and stage 8 (refresh dependants) are NOT this
 * service — they are the existing `business-profile` candidate/rebuild flow.
 * This service's only job is to keep producing a `SiteContext` row that flow
 * can keep reading, now with per-field source citations (`fieldSources`).
 *
 * **Resumability** is the exit gate (P03, plan §20.2): every stage's output is
 * a Prisma row (`SiteContextRun` + `SiteContextRunPage` + `SiteContextFact`),
 * not an in-memory array. A crash mid-run is resumed with {@link resume},
 * which re-reads those rows, skips pages already fetched/extracted, and only
 * retries pages that actually failed — capped at `maxRetriesPerPage`.
 *
 * **Budgets** (page count, request count, characters sent to the LLM, and
 * elapsed wall time) are tracked and enforced independently on the run row.
 * Running out of wall-time budget PAUSES the run (throws
 * {@link SiteContextRunPausedException} carrying the run id) rather than
 * silently truncating or spinning forever — the caller (or a later
 * `resume()` with a raised budget) decides what happens next.
 *
 * @module aeo-context.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { AeoLlmService } from './aeo-llm.service';
import type { SiteContextData } from './aeo-audit.types';

/** Path fragments that usually carry offer/ICP language, best first. */
const HIGH_SIGNAL_PATHS = [
  '/services',
  '/solutions',
  '/what-we-do',
  '/products',
  '/pricing',
  '/industries',
  '/who-we-serve',
  '/about',
  '/case-studies',
  '/use-cases',
];

/** Same idea, but matched against sitemap URLs we actually found. */
const HIGH_SIGNAL_PATTERNS =
  /\/(services?|solutions?|products?|pricing|plans|industr(y|ies)|use-cases?|what-we-do|who-we-serve|capabilities|expertise|sectors?|about)(\/|$)/i;

/** Nav/footer noise that is never a service name. */
const NAV_NOISE =
  /^(home|about( us)?|contact( us)?|blog|news|careers?|jobs|login|log ?in|sign ?(in|up)|privacy|terms|cookies?|sitemap|faq|support|help|search|menu|close|back to top|all rights reserved|subscribe|newsletter|follow us|get started|book a (call|demo)|read more|learn more|our team|team|press|partners?)$/i;

/**
 * Single words that are pricing tiers, plan names or process-step labels rather
 * than offerings. "companies that do Starter" is not a query anyone types.
 */
const TIER_AND_STEP_WORDS =
  /^(starter|basic|standard|premium|pro|plus|growth|scale|enterprise|business|free|trial|custom|lite|advanced|essential|team|agency|diagnose|discover|build|operate|compound|deliver|launch|plan|design|measure|optimi[sz]e|onboard|scoping?|audit|strategy|execution|results?|process|approach|method|phase|step|one|two|three)$/i;

/** Page-type patterns for stage 2/3 classification. */
const CART_PATTERN = /\/(cart|checkout)(\/|$)/i;
const LOGIN_PATTERN = /\/(login|log-in|signin|sign-in|register|account|my-account|search)(\/|$)/i;
const POLICY_PATTERN = /\/(privacy|terms|cookie|cookies|legal|gdpr)(\/|$)/i;
const PRICING_PATTERN = /\/(pricing|plans)(\/|$)/i;
const ABOUT_PATTERN = /\/about/i;
const INDUSTRIES_PATTERN = /\/(industr(y|ies)|sectors?|who-we-serve)(\/|$)/i;
const LOCATION_PATTERN = /\/(locations?|near-me|cities|areas?-we-serve|service-areas?)(\/|$)/i;
const CASE_STUDY_PATTERN = /\/(case-stud(y|ies)|success-stor(y|ies)|customer-stor(y|ies)|testimonials?)(\/|$)/i;
const SERVICE_PATTERN = /\/(services?|solutions?|products?|what-we-do|capabilit|expertise)(\/|$)/i;
const BLOG_PATTERN = /\/(blog|news|articles?|insights?)(\/|$)/i;
/** Site-context-v2 §5 — additional classes the pre-v2 pipeline collapsed into "other". */
const LEADERSHIP_PATTERN = /\/(leadership|team|our-team|management|founders?)(\/|$)/i;
const SECURITY_PATTERN = /\/(security|compliance|trust|gdpr-compliance|soc2|iso-27001)(\/|$)/i;
const PRESS_PATTERN = /\/(press|newsroom|media-kit|investors?|investor-relations)(\/|$)/i;
const CAREERS_PATTERN = /\/(careers?|jobs|join-us|we're-hiring|hiring)(\/|$)/i;
const PARTNER_PATTERN = /\/(partners?|integrations?|marketplace|ecosystem)(\/|$)/i;

export type PageType =
  | 'homepage' | 'service' | 'about' | 'pricing' | 'industries' | 'location'
  | 'case-study' | 'blog' | 'login' | 'cart' | 'policy'
  | 'leadership' | 'security' | 'press' | 'careers' | 'partner' | 'other';

/** Purpose categories the select stage reserves coverage capacity for. `null` = never selected. */
export type PurposeCategory =
  | 'homepage' | 'service' | 'about' | 'pricing' | 'industries' | 'location' | 'case-study'
  | 'leadership' | 'security' | 'press' | 'careers' | 'partner' | 'other';

/** How many of the fetched pool the select stage will take per category, priority order first. */
const CATEGORY_TARGETS: Record<PurposeCategory, number> = {
  homepage: 1,
  service: 4,
  pricing: 1,
  about: 1,
  industries: 2,
  location: 1,
  'case-study': 2,
  leadership: 1,
  security: 1,
  press: 1,
  careers: 1,
  partner: 1,
  other: 1,
};
const CATEGORY_PRIORITY: PurposeCategory[] = [
  'homepage', 'service', 'pricing', 'about', 'industries', 'location', 'case-study',
  'leadership', 'security', 'partner', 'press', 'careers', 'other',
];

/** Cap on cached page content (keeps run rows bounded on a large page). */
const MAX_CACHED_HTML = 80_000;
const MAX_CACHED_TEXT = 30_000;
/** Cap on characters of page text handed to any one LLM extraction batch call. */
const MAX_BATCH_CHARS = 8_000;

/** Business-fact fields a `SiteContextFact` row can carry (site-context-v2 §11, expanded from the pre-v2 10). */
type FactField =
  | 'services' | 'icp' | 'valueProps' | 'painPoints' | 'outcomes' | 'markets' | 'category' | 'vertical' | 'description' | 'brand'
  | 'legalName' | 'alternateName' | 'foundedYear' | 'headquarters' | 'officeLocation' | 'languages'
  | 'pricingModel' | 'differentiator' | 'leadership' | 'certification' | 'award' | 'partner' | 'technology'
  | 'businessModel' | 'contact';

/** How a fact was arrived at (§13) — never trust the model's self-reported confidence alone. */
type FactType = 'explicit' | 'strong_inference' | 'weak_inference' | 'conflicted';

const CATEGORY_FIELDS: Record<string, FactField[]> = {
  identity: ['brand', 'legalName', 'alternateName', 'foundedYear', 'category', 'vertical'],
  descriptions: ['description'],
  offerings: ['services', 'pricingModel'],
  positioning: ['valueProps', 'differentiator', 'painPoints', 'outcomes'],
  customers: ['icp'],
  geography: ['markets', 'headquarters', 'officeLocation', 'languages'],
  organization: ['leadership'],
  credibility: ['certification', 'award'],
  go_to_market: ['businessModel', 'partner', 'contact'],
  technology: ['technology'],
};

/** One extraction-stage fact before it is persisted. */
interface DraftFact {
  field: FactField;
  value: string;
  sourceUrl: string;
  excerpt: string | null;
  contentHash: string | null;
  factType?: FactType;
}

/** JSON-LD fields worth keeping (site-context-v2 §9) — everything else on the block is dropped. */
const JSON_LD_FIELDS = [
  'name', 'legalName', 'alternateName', 'description', 'url', 'logo', 'sameAs', 'address', 'areaServed',
  'contactPoint', 'founder', 'foundingDate', 'parentOrganization', 'subOrganization', 'brand', 'makesOffer',
  'offers', 'knowsAbout', 'award', 'slogan', 'telephone', 'email',
] as const;

/** One JSON-LD entity kept as evidence (§9) — the raw block, not inferred truth. */
export interface JsonLdEntity {
  type: string;
  fields: Partial<Record<(typeof JSON_LD_FIELDS)[number], unknown>>;
}

/** Schema.org types worth extracting identity/geography/organization facts from. */
const RELEVANT_JSON_LD_TYPES = new Set([
  'Organization', 'Corporation', 'LocalBusiness', 'ProfessionalService', 'Brand', 'WebSite',
  'Product', 'Service', 'Offer', 'AggregateOffer', 'SoftwareApplication', 'Person', 'Place',
  'PostalAddress', 'ContactPoint', 'FAQPage', 'Review', 'AggregateRating',
]);

/** Thrown when a run's elapsed-time budget is exhausted before it reaches `completed`. Carries the run id so the caller can `resume()` it. */
export class SiteContextRunPausedException extends Error {
  constructor(public readonly runId: string, public readonly reachedStage: string) {
    super(
      `Site context run ${runId} paused (elapsed-time budget spent) after stage "${reachedStage}". ` +
        `Nothing successful was lost — resume with AeoContextService.resume("${runId}").`,
    );
  }
}

type RunRow = {
  id: string;
  projectId: string;
  domain: string;
  status: string;
  stage: string | null;
  error: string | null;
  maxPages: number;
  maxRequests: number;
  maxChars: number;
  maxElapsedMs: number;
  maxRetriesPerPage: number;
  pagesSpent: number;
  requestsSpent: number;
  charsSpent: number;
  elapsedMs: number;
  refine: boolean;
  coveragePlan: string;
  notes: string;
  startedAt: Date | null;
  finishedAt: Date | null;
};

type PageRow = {
  id: string;
  runId: string;
  url: string;
  discoverySource: string;
  fetched: boolean;
  statusCode: number | null;
  fetchedAt: Date | null;
  html: string | null;
  text: string | null;
  title: string | null;
  description: string | null;
  headings: string;
  language: string | null;
  pageType: string | null;
  contentHash: string | null;
  duplicateOfUrl: string | null;
  jsonLd: string;
  selected: boolean;
  selectionReason: string | null;
  purposeCategory: string | null;
  extractStatus: string;
  extractError: string | null;
  retryCount: number;
};

export interface BuildOpts {
  maxPages?: number;
  refine?: boolean;
  maxRequests?: number;
  maxChars?: number;
  maxElapsedMs?: number;
}

@Injectable()
export class AeoContextService {
  private readonly logger = new Logger(AeoContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fetcher: FetcherService,
    private readonly llm: AeoLlmService,
  ) {}

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Start a fresh staged run and drive it to completion (or a budget pause).
   * Same return shape as the pre-P03 service so `AeoAuditService` and the
   * controller need no changes: `{ ...SiteContextData, id }`.
   *
   * @throws SiteContextRunPausedException when the elapsed-time budget runs
   *   out before the run reaches `validate`. Call {@link resume} to continue.
   */
  async build(projectId: string, opts: BuildOpts = {}): Promise<SiteContextData & { id: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const domain = this.normalizeDomain(project.domain);
    const run = await this.prisma.siteContextRun.create({
      data: {
        projectId,
        domain,
        maxPages: opts.maxPages ?? Number(this.config.get<string>('AEO_CONTEXT_MAX_PAGES', '12')),
        maxRequests: opts.maxRequests ?? Number(this.config.get<string>('AEO_CONTEXT_MAX_REQUESTS', '40')),
        maxChars: opts.maxChars ?? Number(this.config.get<string>('AEO_CONTEXT_MAX_CHARS', '24000')),
        maxElapsedMs: opts.maxElapsedMs ?? Number(this.config.get<string>('AEO_CONTEXT_MAX_ELAPSED_MS', '300000')),
        refine: opts.refine !== false,
      },
    });
    return this.drive(run.id);
  }

  /**
   * Resume a run from its last completed stage. Pages already fetched are not
   * re-fetched; pages whose extraction already succeeded are not re-extracted;
   * only pending/failed-under-the-retry-cap pages are retried.
   *
   * @param opts.maxElapsedMs Optionally raise the elapsed-time budget before
   *   continuing — the run keeps its already-spent `elapsedMs`, so this is
   *   additive headroom, not a reset.
   */
  async resume(runId: string, opts: { maxElapsedMs?: number } = {}): Promise<SiteContextData & { id: string }> {
    const run = await this.requireRun(runId);
    if (run.status === 'completed') {
      const ctx = await this.prisma.siteContext.findUnique({ where: { runId } });
      if (ctx) return this.rowToData(ctx);
    }
    if (opts.maxElapsedMs !== undefined) {
      await this.prisma.siteContextRun.update({ where: { id: runId }, data: { maxElapsedMs: opts.maxElapsedMs } });
    }
    return this.drive(runId);
  }

  /** Latest stored context for a project, or null when none has been built. */
  async latest(projectId: string): Promise<(SiteContextData & { id: string; createdAt: Date }) | null> {
    const row = await this.prisma.siteContext.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? this.rowToData(row) : null;
  }

  /** Read one context row by id. @throws NotFoundException when missing. */
  async get(id: string): Promise<SiteContextData & { id: string; createdAt: Date }> {
    const row = await this.prisma.siteContext.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Site context not found: ' + id);
    return this.rowToData(row);
  }

  /** Staff-facing run inspection: status/stage/budgets/coverage plus every page/fact row. */
  async getRun(runId: string) {
    const run = await this.requireRun(runId);
    const pages = await this.prisma.siteContextRunPage.findMany({ where: { runId }, orderBy: { url: 'asc' } });
    const facts = await this.prisma.siteContextFact.findMany({ where: { runId }, orderBy: { field: 'asc' } });
    const ctx = run.status === 'completed' ? await this.prisma.siteContext.findUnique({ where: { runId } }) : null;
    return {
      run: this.runSummary(run),
      pages: pages.map((p) => this.pageSummary(p)),
      facts: facts.map((f) => ({
        id: f.id, field: f.field, value: f.value, sourceUrl: f.sourceUrl,
        excerpt: f.excerpt, validated: f.validated, validationNote: f.validationNote,
        observedAt: f.observedAt.toISOString(),
      })),
      contextId: ctx?.id ?? null,
    };
  }

  /** Staff-facing run history for a project, newest first. */
  async listRuns(projectId: string) {
    const runs = await this.prisma.siteContextRun.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 });
    return runs.map((r) => this.runSummary(r));
  }

  // ─── Orchestration ──────────────────────────────────────────────────────

  private async requireRun(runId: string): Promise<RunRow> {
    const run = await this.prisma.siteContextRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException('Site context run not found: ' + runId);
    return run;
  }

  private runSummary(run: RunRow) {
    return {
      id: run.id, projectId: run.projectId, domain: run.domain,
      status: run.status, stage: run.stage, error: run.error,
      budgets: { maxPages: run.maxPages, maxRequests: run.maxRequests, maxChars: run.maxChars, maxElapsedMs: run.maxElapsedMs, maxRetriesPerPage: run.maxRetriesPerPage },
      spent: { pages: run.pagesSpent, requests: run.requestsSpent, chars: run.charsSpent, elapsedMs: run.elapsedMs },
      coveragePlan: this.parseUnknown(run.coveragePlan),
      notes: this.parseStringArray(run.notes).filter((n) => !n.startsWith('__cost__:')),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  private pageSummary(p: PageRow) {
    return {
      id: p.id, url: p.url, discoverySource: p.discoverySource, fetched: p.fetched, statusCode: p.statusCode,
      title: p.title, description: p.description, pageType: p.pageType, language: p.language,
      duplicateOfUrl: p.duplicateOfUrl, selected: p.selected, selectionReason: p.selectionReason,
      purposeCategory: p.purposeCategory, extractStatus: p.extractStatus, extractError: p.extractError, retryCount: p.retryCount,
    };
  }

  /** Drive a run through every stage it has not completed yet, checkpointing the elapsed budget between stages. */
  private async drive(runId: string): Promise<SiteContextData & { id: string }> {
    let run = await this.requireRun(runId);
    const wallStart = Date.now();

    if (!run.startedAt) {
      run = await this.prisma.siteContextRun.update({ where: { id: runId }, data: { startedAt: new Date(), status: 'discovering' } });
    }

    const checkpoint = async (stageJustCompleted: string, nextStatus: string): Promise<boolean> => {
      const elapsedMs = run.elapsedMs + (Date.now() - wallStart);
      run = await this.prisma.siteContextRun.update({
        where: { id: runId },
        data: { stage: stageJustCompleted, status: nextStatus, elapsedMs },
      });
      if (elapsedMs >= run.maxElapsedMs && nextStatus !== 'completed') {
        throw new SiteContextRunPausedException(runId, stageJustCompleted);
      }
      return true;
    };

    try {
      const completed = (s: string): boolean => {
        const order = ['discover', 'inspect', 'select', 'extract', 'reconcile', 'validate', 'consolidate'];
        return run.stage !== null && order.indexOf(run.stage) >= order.indexOf(s);
      };

      if (!completed('discover')) {
        await this.stageDiscover(run);
        await checkpoint('discover', 'inspecting');
      }
      if (!completed('inspect')) {
        await this.stageInspect(run);
        await checkpoint('inspect', 'selecting');
      }
      if (!completed('select')) {
        await this.stageSelect(run);
        await checkpoint('select', 'extracting');
      }
      if (!completed('extract')) {
        await this.stageExtract(run);
        await checkpoint('extract', 'reconciling');
      }
      if (!completed('reconcile')) {
        await this.stageReconcile(run);
        await checkpoint('reconcile', 'validating');
      }
      if (!completed('validate')) {
        await this.stageValidate(run);
        await checkpoint('validate', 'consolidating');
      }
      if (!completed('consolidate')) {
        await this.stageConsolidate(run);
        await checkpoint('consolidate', 'completed');
      }

      const project = await this.prisma.project.findUnique({ where: { id: run.projectId } });
      const result = await this.compile(run, project!);
      await this.prisma.siteContextRun.update({ where: { id: runId }, data: { finishedAt: new Date() } });
      return result;
    } catch (err) {
      if (err instanceof SiteContextRunPausedException) throw err;
      const message = (err as Error).message;
      await this.prisma.siteContextRun.update({ where: { id: runId }, data: { status: 'failed', error: message.slice(0, 1000) } });
      throw err;
    }
  }

  // ─── Stage 1: Discover ──────────────────────────────────────────────────

  private async stageDiscover(run: RunRow): Promise<void> {
    const origin = 'https://' + run.domain;
    const existing = await this.prisma.siteContextRunPage.findMany({ where: { runId: run.id } });
    const seen = new Set(existing.map((p) => this.urlKey(p.url)));
    const fingerprints = new Set(existing.filter((p) => p.contentHash).map((p) => p.contentHash!));
    let pagesSpent = run.pagesSpent;
    let requestsSpent = run.requestsSpent;
    const budgetLeft = (): boolean => pagesSpent < run.maxPages && requestsSpent < run.maxRequests;

    const visit = async (url: string, source: string): Promise<void> => {
      const key = this.urlKey(url);
      if (seen.has(key) || !budgetLeft()) return;
      seen.add(key);
      requestsSpent++;
      try {
        const res = await this.fetcher.render({ url, jsDisabled: false, timeout: 30000 }, 'aeo-context', run.id);
        if (!res.html) return;
        const fp = this.fingerprint(res.text || res.html);
        if (fingerprints.has(fp)) {
          this.logger.debug('Context discover skipped ' + url + ': same content as a page already read');
          return;
        }
        fingerprints.add(fp);
        pagesSpent++;
        await this.prisma.siteContextRunPage.create({
          data: {
            runId: run.id, url, discoverySource: source, fetched: true, statusCode: 200, fetchedAt: new Date(),
            html: this.truncate(res.html, MAX_CACHED_HTML), text: this.truncate(res.text || '', MAX_CACHED_TEXT),
            title: res.title || null, contentHash: fp,
          },
        });
      } catch (err) {
        this.logger.debug('Context discover fetch failed ' + url + ': ' + (err as Error).message);
      }
    };

    if (!seen.has(this.urlKey(origin + '/'))) await visit(origin + '/', 'homepage');

    if (budgetLeft()) {
      const requestCounter = { n: requestsSpent };
      const fromSitemap = await this.sitemapCandidates(origin, run.id, requestCounter, run.maxRequests);
      requestsSpent = requestCounter.n;
      for (const url of fromSitemap) {
        if (!budgetLeft()) break;
        await visit(url, 'sitemap');
      }
    }

    if (budgetLeft()) {
      const homeRow = existing.find((p) => this.urlKey(p.url) === this.urlKey(origin + '/'));
      const homeHtml = homeRow?.html ?? (await this.prisma.siteContextRunPage.findFirst({ where: { runId: run.id, url: origin + '/' } }))?.html;
      const navLinks = homeHtml ? this.internalNavLinks(homeHtml, origin) : [];
      const guesses = [...HIGH_SIGNAL_PATHS.map((p) => origin + p), ...navLinks];
      for (const url of guesses) {
        if (!budgetLeft()) break;
        await visit(url, 'guess');
      }
    }

    await this.prisma.siteContextRun.update({ where: { id: run.id }, data: { pagesSpent, requestsSpent } });
    run.pagesSpent = pagesSpent;
    run.requestsSpent = requestsSpent;

    const total = await this.prisma.siteContextRunPage.count({ where: { runId: run.id, fetched: true } });
    if (total === 0) {
      await this.addNote(run.id, `Discovery found no reachable pages on ${run.domain} — context will be metadata-only.`);
    } else if (total < run.maxPages && requestsSpent >= run.maxRequests) {
      await this.addNote(run.id, `Discovery stopped at the request budget (${run.maxRequests}) with only ${total} of up to ${run.maxPages} pages fetched — discovery is incomplete.`);
    }
  }

  /** Site-context-v2 §3 — sitemap paths tried when `robots.txt` names none. */
  private static readonly FALLBACK_SITEMAP_PATHS = [
    '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap/sitemap.xml',
  ];

  /**
   * Pull high-signal URLs out of the sitemap (§3: robots.txt `Sitemap:` directives first,
   * then common fallback paths; index-aware, one level deep), counting requests against
   * the shared budget.
   */
  private async sitemapCandidates(origin: string, runId: string, counter: { n: number }, maxRequests: number): Promise<string[]> {
    const urls: string[] = [];
    const readRaw = async (url: string): Promise<string | null> => {
      if (counter.n >= maxRequests) return null;
      counter.n++;
      try {
        const res = await this.fetcher.fetch({ url, timeout: 20000 }, 'aeo-context', runId);
        return res.status === 200 && res.body ? res.body : null;
      } catch {
        return null;
      }
    };
    const readSitemap = async (url: string): Promise<string[]> => {
      const body = await readRaw(url);
      return body ? [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]) : [];
    };

    // §3.1 — robots.txt Sitemap: directives take priority over guessed paths.
    const robotsBody = await readRaw(origin + '/robots.txt');
    const fromRobots = robotsBody
      ? [...robotsBody.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1].trim())
      : [];

    // §3.2 — common fallback paths, tried only when robots.txt named nothing.
    const sitemapEntryPoints = fromRobots.length > 0 ? fromRobots : AeoContextService.FALLBACK_SITEMAP_PATHS.map((p) => origin + p);

    const top: string[] = [];
    for (const entry of sitemapEntryPoints) {
      if (counter.n >= maxRequests) break;
      top.push(...(await readSitemap(entry)));
      if (top.length > 0) break; // first entry point that yields anything wins — avoid re-reading every fallback path
    }
    const nested = top.filter((u) => /\.xml(\.gz)?$/i.test(u)).slice(0, 3);
    const flat = top.filter((u) => !/\.xml(\.gz)?$/i.test(u));
    for (const child of nested) {
      if (counter.n >= maxRequests) break;
      flat.push(...(await readSitemap(child)).filter((u) => !/\.xml(\.gz)?$/i.test(u)));
    }

    for (const u of flat) {
      if (!u.startsWith(origin)) continue; // own host only
      if (HIGH_SIGNAL_PATTERNS.test(u)) urls.push(u);
    }
    urls.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
    return urls.slice(0, 20);
  }

  /** Same-origin nav/header links from the homepage, deduped. */
  private internalNavLinks(html: string, origin: string): string[] {
    const $ = cheerio.load(html);
    const out: string[] = [];
    const seen = new Set<string>();
    $('nav a[href], header a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      let abs: string;
      try {
        abs = new URL(href, origin).toString();
      } catch {
        return;
      }
      if (!abs.startsWith(origin) || seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    });
    return out.slice(0, 15);
  }

  /**
   * Parse every `application/ld+json` block on a page (§9): expand `@graph`
   * arrays, keep only schema.org types worth extracting from, and retain only
   * the fields listed in {@link JSON_LD_FIELDS}. Malformed blocks are skipped,
   * never thrown — one bad script tag on a page must not fail the whole run.
   */
  private extractJsonLd($: cheerio.CheerioAPI): JsonLdEntity[] {
    const out: JsonLdEntity[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text();
      if (!raw || raw.trim().length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return; // malformed JSON-LD — evidence, not a page failure
      }
      const nodes: unknown[] = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { '@graph'?: unknown })['@graph'])
          ? ((parsed as { '@graph': unknown[] })['@graph'])
          : [parsed];

      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const obj = node as Record<string, unknown>;
        const typeRaw = obj['@type'];
        const types = Array.isArray(typeRaw) ? typeRaw : typeRaw ? [typeRaw] : [];
        const type = types.find((t): t is string => typeof t === 'string' && RELEVANT_JSON_LD_TYPES.has(t));
        if (!type) continue;
        const fields: JsonLdEntity['fields'] = {};
        for (const key of JSON_LD_FIELDS) {
          if (obj[key] !== undefined) fields[key] = obj[key];
        }
        if (Object.keys(fields).length > 0) out.push({ type, fields });
      }
    });
    return out.slice(0, 30);
  }

  // ─── Stage 2: Inspect metadata ──────────────────────────────────────────

  /** Metadata from data already fetched in stage 1 — no re-fetch. */
  private async stageInspect(run: RunRow): Promise<void> {
    const pages = await this.prisma.siteContextRunPage.findMany({ where: { runId: run.id, fetched: true } });
    const origin = 'https://' + run.domain;
    for (const page of pages) {
      if (page.pageType !== null) continue; // already inspected on a prior attempt
      const isHome = this.urlKey(page.url) === this.urlKey(origin + '/');
      const headings: string[] = [];
      let description: string | null = null;
      let language: string | null = null;
      let title: string | null = page.title;
      let jsonLd: JsonLdEntity[] = [];

      if (page.html) {
        const $ = cheerio.load(page.html);
        description =
          ($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '')?.trim() || null;
        $('h1, h2, h3').each((_, el) => {
          const t = $(el).text().trim().replace(/\s+/g, ' ');
          if (t && headings.length < 20) headings.push(t);
        });
        language = $('html').attr('lang')?.slice(0, 5) || null;
        title = title || $('title').text().trim() || null;
        jsonLd = this.extractJsonLd($);
      }
      const pageType = this.classifyPageType(page.url, isHome);

      await this.prisma.siteContextRunPage.update({
        where: { id: page.id },
        data: { title, description, headings: JSON.stringify(headings), language, pageType, jsonLd: JSON.stringify(jsonLd) },
      });
    }
    const unknown = pages.filter((p) => !p.html).length;
    if (unknown > 0) {
      // §9.3: metadata unknown is not automatic exclusion — the select stage
      // still considers these pages, just without title/description/heading signal.
      await this.addNote(run.id, `${unknown} discovered page(s) had no cached HTML to inspect (fetch failed) — treated as unknown metadata, not excluded.`);
    }
  }

  private classifyPageType(url: string, isHome: boolean): PageType {
    if (isHome) return 'homepage';
    if (CART_PATTERN.test(url)) return 'cart';
    if (LOGIN_PATTERN.test(url)) return 'login';
    if (POLICY_PATTERN.test(url)) return 'policy';
    if (PRICING_PATTERN.test(url)) return 'pricing';
    if (ABOUT_PATTERN.test(url)) return 'about';
    if (INDUSTRIES_PATTERN.test(url)) return 'industries';
    if (LOCATION_PATTERN.test(url)) return 'location';
    if (CASE_STUDY_PATTERN.test(url)) return 'case-study';
    if (SERVICE_PATTERN.test(url)) return 'service';
    if (LEADERSHIP_PATTERN.test(url)) return 'leadership';
    if (SECURITY_PATTERN.test(url)) return 'security';
    if (PRESS_PATTERN.test(url)) return 'press';
    if (CAREERS_PATTERN.test(url)) return 'careers';
    if (PARTNER_PATTERN.test(url)) return 'partner';
    if (BLOG_PATTERN.test(url)) return 'blog';
    return 'other';
  }

  // ─── Stage 3: Select ────────────────────────────────────────────────────

  /**
   * Coverage-based selection (§9.4): rank within each purpose category, then
   * fill categories in priority order up to their reserved target — never
   * just "top N by score" across the whole pool, which is what would let
   * eleven similar blog posts crowd out the one pricing page. Login/cart/
   * account/search, policy-only and blog/news pages are never selected.
   */
  private async stageSelect(run: RunRow): Promise<void> {
    const pages = await this.prisma.siteContextRunPage.findMany({ where: { runId: run.id, fetched: true } });
    if (pages.some((p) => p.selected || p.selectionReason)) return; // already selected on a prior attempt

    const byCategory = new Map<PurposeCategory, PageRow[]>();
    const excluded: PageRow[] = [];
    for (const page of pages) {
      const purpose = this.purposeOf(page.pageType as PageType | null);
      if (purpose === null) {
        excluded.push(page);
        continue;
      }
      const list = byCategory.get(purpose) ?? [];
      list.push(page);
      byCategory.set(purpose, list);
    }

    // Within a category, shallower/shorter URLs first — "/services" beats
    // "/services/a/b/c" for offer language, and is less likely a deep near-duplicate.
    const rank = (a: PageRow, b: PageRow): number =>
      a.url.split('/').length - b.url.split('/').length || a.url.length - b.url.length;

    const coveragePlan: Record<string, { target: number; filled: number }> = {};
    const selectedIds = new Set<string>();

    for (const category of CATEGORY_PRIORITY) {
      const candidates = (byCategory.get(category) ?? []).sort(rank);
      const target = CATEGORY_TARGETS[category];
      const take = candidates.slice(0, target);
      coveragePlan[category] = { target, filled: take.length };
      for (const p of take) selectedIds.add(p.id);
    }

    for (const page of pages) {
      const purpose = this.purposeOf(page.pageType as PageType | null);
      const selected = selectedIds.has(page.id);
      const reason = selected
        ? `Selected: ${purpose} page, coverage slot filled`
        : purpose === null
          ? `Excluded: ${page.pageType ?? 'unclassified'} page — not a primary business-fact source`
          : `Excluded: coverage target for "${purpose}" pages already filled by a higher-ranked page`;
      await this.prisma.siteContextRunPage.update({
        where: { id: page.id },
        data: { selected, selectionReason: reason, purposeCategory: purpose },
      });
    }

    const filledCategories = Object.values(coveragePlan).filter((c) => c.filled > 0).length;
    if (filledCategories <= 1) {
      await this.addNote(
        run.id,
        `Coverage quality flag: only ${filledCategories} purpose categor${filledCategories === 1 ? 'y is' : 'ies are'} represented in the selected pages — this business's true offer surface may not be captured.`,
      );
    }

    await this.prisma.siteContextRun.update({ where: { id: run.id }, data: { coveragePlan: JSON.stringify(coveragePlan) } });
  }

  private purposeOf(pageType: PageType | null): PurposeCategory | null {
    if (pageType === null) return null;
    if (pageType === 'blog' || pageType === 'login' || pageType === 'cart' || pageType === 'policy') return null;
    return pageType as PurposeCategory;
  }

  // ─── Stage 4: Extract ───────────────────────────────────────────────────

  /**
   * Deterministic per-page facts always run (cheap, no model). An optional
   * batched LLM pass (bounded by the char budget, retried only on failure, up
   * to `maxRetriesPerPage` attempts per page) adds ICP/pains/outcomes/markets/
   * category/vertical, each fact tagged with the exact page it came from.
   */
  private async stageExtract(run: RunRow): Promise<void> {
    const selected = await this.prisma.siteContextRunPage.findMany({ where: { runId: run.id, selected: true } });

    // Deterministic pass — always attempted, idempotent, never "fails".
    for (const page of selected) {
      if (page.extractStatus !== 'pending') continue;
      if (!page.html) continue;
      const facts = [...this.extractPageFactsDeterministic(page), ...this.extractJsonLdFacts(page)];
      for (const f of facts) await this.persistFact(run.id, f);
    }

    if (!run.refine || !this.llm.isAvailable()) {
      await this.prisma.siteContextRunPage.updateMany({
        where: { runId: run.id, selected: true, extractStatus: 'pending' },
        data: { extractStatus: 'success' },
      });
      return;
    }

    // LLM batched pass — only pages not already succeeded/permanently skipped.
    let charsSpent = run.charsSpent;
    const retryable = await this.prisma.siteContextRunPage.findMany({
      where: { runId: run.id, selected: true, extractStatus: { in: ['pending', 'failed'] } },
      orderBy: { url: 'asc' },
    });

    let cursor = 0;
    while (cursor < retryable.length) {
      if (charsSpent >= run.maxChars) {
        await this.addNote(run.id, `Extraction stopped at the character budget (${run.maxChars}) — ${retryable.length - cursor} selected page(s) still pending.`);
        break;
      }
      const batch: PageRow[] = [];
      let batchChars = 0;
      while (cursor < retryable.length && batch.length < 4) {
        const p = retryable[cursor];
        const text = (p.text || '').slice(0, MAX_BATCH_CHARS);
        if (batch.length > 0 && batchChars + text.length > MAX_BATCH_CHARS) break;
        batch.push(p);
        batchChars += text.length;
        cursor++;
      }
      if (batch.length === 0) break;

      try {
        const { facts, model, costUsd } = await this.extractBatchLlm(run, batch);
        charsSpent += batchChars;
        for (const f of facts) await this.persistFact(run.id, f);
        await this.prisma.siteContextRunPage.updateMany({
          where: { id: { in: batch.map((p) => p.id) } },
          data: { extractStatus: 'success', extractError: null },
        });
        await this.addNote(run.id, `__cost__:${costUsd}:${model}`);
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        for (const p of batch) {
          const nextRetry = p.retryCount + 1;
          const exhausted = nextRetry > run.maxRetriesPerPage;
          await this.prisma.siteContextRunPage.update({
            where: { id: p.id },
            data: { extractStatus: exhausted ? 'skipped' : 'failed', extractError: message, retryCount: nextRetry },
          });
        }
        this.logger.warn(`Context extract batch failed (${batch.map((p) => p.url).join(', ')}): ${message}`);
      }
    }

    await this.prisma.siteContextRun.update({ where: { id: run.id }, data: { charsSpent } });
    run.charsSpent = charsSpent;
  }

  /**
   * JSON-LD entities parsed in stage 2 → identity/geography/organization facts
   * (§9's "structured data is evidence, not guaranteed truth" — these are marked
   * `explicit` because they are directly stated by the site's own markup, but
   * still go through stage 6 validation like every other fact).
   */
  private extractJsonLdFacts(page: PageRow): DraftFact[] {
    let entities: JsonLdEntity[];
    try {
      entities = JSON.parse(page.jsonLd || '[]') as JsonLdEntity[];
    } catch {
      return [];
    }
    const out: DraftFact[] = [];
    // `excerpt` here is a substring that appears LITERALLY in the page's raw HTML
    // (the JSON-LD script tag itself), not a paraphrase — so stage 6's verbatim
    // check works the same way it does for a text-extracted fact. It is
    // deliberately NOT `JSON.stringify(raw)`, which would never match html text
    // because of quoting/escaping differences.
    const push = (field: FactField, value: string, excerptText: string): void => {
      const trimmed = value.trim();
      const excerpt = excerptText.trim();
      if (!trimmed || trimmed.length > 300 || !excerpt) return;
      out.push({ field, value: trimmed, sourceUrl: page.url, contentHash: page.contentHash, factType: 'explicit', excerpt: excerpt.slice(0, 280) });
    };
    const asStrings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];

    for (const entity of entities) {
      const f = entity.fields;
      if (typeof f.legalName === 'string') push('legalName', f.legalName, f.legalName);
      for (const alt of asStrings(f.alternateName)) push('alternateName', alt, alt);
      if (typeof f.name === 'string' && entity.type !== 'Person' && entity.type !== 'Place') push('brand', f.name, f.name);
      if (typeof f.foundingDate === 'string') {
        const year = f.foundingDate.match(/\d{4}/)?.[0];
        if (year) push('foundedYear', year, f.foundingDate);
      }
      if (f.address) {
        const addr = f.address as Record<string, unknown> | string;
        if (typeof addr === 'string') {
          push('headquarters', addr, addr);
        } else {
          const parts = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.addressCountry]
            .filter((x): x is string => typeof x === 'string');
          const formatted = parts.join(', ');
          // Validate against one literal part (e.g. the city), not the joined
          // string — the join is our own formatting and would never appear
          // verbatim in the source markup.
          if (formatted && parts[0]) push('headquarters', formatted, parts[0]);
        }
      }
      if (typeof f.telephone === 'string') push('contact', f.telephone, f.telephone);
      if (typeof f.email === 'string') push('contact', f.email, f.email);
      for (const award of asStrings(f.award)) push('award', award, award);
      if (f.founder) {
        const founders = Array.isArray(f.founder) ? f.founder : [f.founder];
        for (const founder of founders) {
          const name = typeof founder === 'string' ? founder : (founder as Record<string, unknown> | undefined)?.name;
          if (typeof name === 'string') push('leadership', name + ' (founder)', name);
        }
      }
    }
    return out.slice(0, 20);
  }

  /** Headings/hero copy on one page → candidate services/value props, each cited to that page. */
  private extractPageFactsDeterministic(page: PageRow): DraftFact[] {
    if (!page.html) return [];
    const $ = cheerio.load(page.html);
    const out: DraftFact[] = [];
    const seen = new Set<string>();

    const inPersonBlock = (node: ReturnType<typeof $>): boolean =>
      node.closest(
        '[class*="team"],[class*="person"],[class*="people"],[class*="author"],[class*="bio"],' +
          '[class*="staff"],[class*="member"],[class*="founder"],[class*="testimonial"],[class*="quote"],' +
          '[class*="logo"],footer,nav',
      ).length > 0;

    const add = (field: FactField, text: string): void => {
      const key = field + ':' + text.toLowerCase();
      if (seen.has(key) || out.length >= 40) return;
      seen.add(key);
      out.push({ field, value: text, sourceUrl: page.url, excerpt: text, contentHash: page.contentHash });
    };

    $('h2, h3').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (this.isCandidatePhrase(text) && !inPersonBlock($(el))) add('services', text);
    });
    $('[class*="card"] h4, [class*="service"] h4, [class*="tile"] h4, li > strong').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (this.isCandidatePhrase(text) && !inPersonBlock($(el))) add('services', text);
    });
    $('h1, [class*="hero"] p').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text.length > 15 && text.length < 160) add('valueProps', text);
    });

    return out;
  }

  /** One constrained-JSON call per small page batch, each returned fact tagged with its source page. */
  private async extractBatchLlm(run: RunRow, batch: PageRow[]): Promise<{ facts: DraftFact[]; model: string; costUsd: number }> {
    const urls = batch.map((p) => p.url);
    let corpus = '';
    for (const page of batch) {
      corpus += '\n\n--- ' + page.url + ' ---\n' + (page.title ? page.title + '\n' : '') + (page.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BATCH_CHARS);
    }

    const result = await this.llm.json(
      {
        purpose: 'site context extraction (batch)',
        maxTokens: 1800,
        system:
          'You read company web pages and extract factual assertions about the company itself — never about its ' +
          'customers, partners or people it merely mentions. Rules:\n' +
          '- Use ONLY what the page text states. Never complete a missing detail from general/outside knowledge.\n' +
          '- Every fact MUST cite the exact page URL it came from (sourcePage, must be one of the URLs given) and a short verbatim excerpt (<=200 chars, copied text, not a paraphrase) that supports it.\n' +
          '- factType is one of: "explicit" (directly stated), "strong_inference" (clearly implied by multiple ' +
          'signals on the page but not stated outright), "weak_inference" (plausible but thin support — prefer ' +
          'omitting the fact instead of using this).\n' +
          '- Before writing a fact, check the sentence for negation ("we do NOT offer X", "unlike other providers ' +
          'we don\'t...") — never emit a fact whose sentence is negated.\n' +
          '- field is one of: services, icp, valueProps, painPoints, outcomes, markets, category, vertical, ' +
          'description, legalName, alternateName, foundedYear, headquarters, officeLocation, languages, ' +
          'pricingModel, differentiator, leadership, certification, award, partner, technology, businessModel, contact.\n' +
          '- services: concrete offerings a buyer can pay for, 2-6 words, in the site\'s own words. Exclude pricing tiers, process steps, company values and people\'s names.\n' +
          '- icp: who buys — role, company type, or segment.\n' +
          '- markets: geographic markets the company SERVES, as ISO-3166 alpha-2 country codes.\n' +
          '- painPoints: a problem the BUYER has before working with this company — not a problem the company itself faces.\n' +
          '- outcomes: a result the company promises the buyer, stated as an outcome, not a feature list restated.\n' +
          '- category: a short (2-5 word) descriptor of what kind of business this is (e.g. "b2b logistics software").\n' +
          '- vertical: the industry the company sells INTO, if the page names one (e.g. "healthcare", "construction").\n' +
          '- pricingModel: how the company charges (e.g. "subscription", "per-project quote", "usage-based") — only if the page actually states or clearly shows a pricing structure.\n' +
          '- differentiator: a stated reason to choose this company over alternatives — must be comparative or exclusivity language, not a plain feature.\n' +
          '- leadership: a named person with their role, only when the page states both.\n' +
          '- businessModel: how the company sells (e.g. "self-serve SaaS", "field service with local technicians", "B2B agency retainer").\n' +
          '- Return [] for a page/field with no support. An empty result is correct — do not force a value.\n' +
          'Respond with ONLY JSON: {"facts":[{"field":string,"value":string,"sourcePage":string,"excerpt":string,"factType":string}]}',
        user: 'Pages (' + urls.join(', ') + ') follow.\n' + corpus,
      },
      (raw) => this.validateBatchFacts(raw, urls),
    );

    const facts: DraftFact[] = result.data.map((f) => ({
      field: f.field, value: f.value, sourceUrl: f.sourcePage, excerpt: f.excerpt, factType: f.factType,
      contentHash: batch.find((p) => p.url === f.sourcePage)?.contentHash ?? null,
    }));
    return { facts, model: result.model, costUsd: result.costUsd };
  }

  private static readonly LLM_EXTRACTABLE_FIELDS: FactField[] = [
    'services', 'icp', 'valueProps', 'painPoints', 'outcomes', 'markets', 'category', 'vertical', 'description',
    'legalName', 'alternateName', 'foundedYear', 'headquarters', 'officeLocation', 'languages', 'pricingModel',
    'differentiator', 'leadership', 'certification', 'award', 'partner', 'technology', 'businessModel', 'contact',
  ];

  private validateBatchFacts(
    raw: unknown,
    allowedUrls: string[],
  ): Array<{ field: FactField; value: string; sourcePage: string; excerpt: string; factType: FactType }> {
    const obj = (raw ?? {}) as { facts?: unknown };
    if (!Array.isArray(obj.facts)) return [];
    const validFields = new Set(AeoContextService.LLM_EXTRACTABLE_FIELDS);
    const validFactTypes: FactType[] = ['explicit', 'strong_inference', 'weak_inference'];
    const urlSet = new Set(allowedUrls);
    const out: Array<{ field: FactField; value: string; sourcePage: string; excerpt: string; factType: FactType }> = [];
    for (const entry of obj.facts) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const field = typeof e.field === 'string' ? e.field : '';
      const value = typeof e.value === 'string' ? e.value.trim() : '';
      const sourcePage = typeof e.sourcePage === 'string' ? e.sourcePage.trim() : '';
      const excerpt = typeof e.excerpt === 'string' ? e.excerpt.trim() : '';
      const factTypeRaw = typeof e.factType === 'string' ? e.factType : 'weak_inference';
      const factType = validFactTypes.includes(factTypeRaw as FactType) ? (factTypeRaw as FactType) : 'weak_inference';
      if (!validFields.has(field as FactField)) continue;
      if (value.length === 0 || value.length > 300) continue;
      if (!urlSet.has(sourcePage)) continue; // hallucinated source page — dropped, never trusted
      if (excerpt.length === 0) continue;
      if (field === 'markets' && !/^[A-Za-z]{2}$/.test(value)) continue;
      out.push({
        field: field as FactField, value: field === 'markets' ? value.toUpperCase() : value,
        sourcePage, excerpt: excerpt.slice(0, 300), factType,
      });
    }
    return out.slice(0, 60);
  }

  private async persistFact(runId: string, f: DraftFact): Promise<void> {
    await this.prisma.siteContextFact.create({
      data: {
        runId, field: f.field, value: f.value, sourceUrl: f.sourceUrl, excerpt: f.excerpt, contentHash: f.contentHash,
        factType: f.factType ?? 'explicit',
      },
    });
  }

  /**
   * Is this heading plausibly an offer name rather than nav chrome or a
   * marketing sentence? (Same filter as the pre-P03 deterministic layer —
   * still the highest-yield discriminator between a service name and noise.)
   */
  private isCandidatePhrase(text: string): boolean {
    if (text.length < 3 || text.length > 70) return false;
    if (NAV_NOISE.test(text)) return false;
    if (/^\d+[%+]?$/.test(text)) return false;
    if (/[?!]$/.test(text)) return false;
    if (/[.]$/.test(text)) return false;
    if (!/[a-z]/i.test(text)) return false;

    const words = text.split(/\s+/);
    if (words.length > 6) return false;
    if (words.length < 2) return false;
    if (words.every((w) => TIER_AND_STEP_WORDS.test(w))) return false;
    if (/^(and|but|or|so|because|if|when|we|they|you|it|our|your|their|this|that|these|those|every|a|an|the)\b/i.test(text)) return false;
    if (/\b(is|are|was|were|has|have|had|does|do|did|can|will|would|should|could|make|makes|owns?|started|created|solved?)\b/i.test(text)) return false;
    return true;
  }

  // ─── Stage 5: Reconcile ─────────────────────────────────────────────────

  /** Page-authority weight for confidence scoring (§13) — identity/organization claims on these pages are more trustworthy than a blog post's. */
  private static readonly HIGH_AUTHORITY_PURPOSES = new Set<string>(['homepage', 'about', 'pricing', 'leadership', 'security']);

  /**
   * Merge duplicate facts, apply the same tier/nav filter to LLM-derived
   * services, log unresolved singular-field conflicts, and compute each
   * fact's confidence (§13) from factType + citing-page authority +
   * cross-source agreement — never the LLM's bare self-report.
   */
  private async stageReconcile(run: RunRow): Promise<void> {
    const facts = await this.prisma.siteContextFact.findMany({ where: { runId: run.id } });
    const pages = await this.prisma.siteContextRunPage.findMany({ where: { runId: run.id } });
    const purposeByUrl = new Map(pages.map((p) => [p.url, p.purposeCategory]));

    const singular: FactField[] = ['category', 'vertical', 'description', 'brand', 'legalName', 'foundedYear'];
    for (const field of singular) {
      const values = new Set(facts.filter((f) => f.field === field).map((f) => f.value.trim().toLowerCase()));
      if (values.size > 1) {
        await this.addNote(run.id, `Unresolved conflict on "${field}": ${values.size} different values found across selected pages — the most-cited one wins, the rest are dropped.`);
        for (const f of facts.filter((x) => x.field === field)) {
          await this.prisma.siteContextFact.update({ where: { id: f.id }, data: { factType: 'conflicted' } });
        }
      }
    }
    // Services that are actually tier/step words even when the LLM proposed them.
    for (const f of facts) {
      if (f.field !== 'services') continue;
      const words = f.value.trim().split(/\s+/);
      if (NAV_NOISE.test(f.value) || (words.length > 0 && words.every((w) => TIER_AND_STEP_WORDS.test(w)))) {
        await this.prisma.siteContextFact.update({
          where: { id: f.id },
          data: { validated: false, validationNote: 'Reconcile: reads as a pricing tier/process step/nav label, not an offering.' },
        });
      }
    }

    // Confidence (§13): base by factType, boosted by citing-page authority and
    // by how many independent pages/sources support the same field+value.
    const crossSourceCount = new Map<string, number>();
    for (const f of facts) {
      const key = f.field + ':' + f.value.trim().toLowerCase();
      crossSourceCount.set(key, (crossSourceCount.get(key) ?? 0) + 1);
    }
    for (const f of facts) {
      const key = f.field + ':' + f.value.trim().toLowerCase();
      const authority = AeoContextService.HIGH_AUTHORITY_PURPOSES.has(purposeByUrl.get(f.sourceUrl) ?? '') ? 2 : 1;
      const confidence = this.computeConfidence(this.asFactType(f.factType), authority, crossSourceCount.get(key) ?? 1);
      await this.prisma.siteContextFact.update({ where: { id: f.id }, data: { confidence } });
    }
  }

  /** §13's weighting — factType is the dominant signal; authority and corroboration only adjust within its band. */
  private computeConfidence(factType: FactType, sourceAuthority: 1 | 2, crossSourceCount: number): number {
    const base = factType === 'explicit' ? 0.75 : factType === 'strong_inference' ? 0.55 : factType === 'conflicted' ? 0.3 : 0.35;
    const authorityBoost = sourceAuthority === 2 ? 0.1 : 0;
    const corroborationBoost = Math.min(crossSourceCount - 1, 2) * 0.05;
    return Math.max(0, Math.min(1, base + authorityBoost + corroborationBoost));
  }

  private asFactType(raw: string): FactType {
    return raw === 'explicit' || raw === 'strong_inference' || raw === 'weak_inference' || raw === 'conflicted' ? raw : 'weak_inference';
  }

  // ─── Stage 6: Validate ──────────────────────────────────────────────────

  /** Every assertion must be supported by its own cited page's text — never a different page's. */
  private async stageValidate(run: RunRow): Promise<void> {
    const facts = await this.prisma.siteContextFact.findMany({ where: { runId: run.id } });
    const pages = await this.prisma.siteContextRunPage.findMany({ where: { runId: run.id } });
    // Both text and html: a text-extracted fact's excerpt lives in the visible
    // text; a JSON-LD-extracted fact's excerpt lives only in the raw script
    // tag, which `text` (visible-text-only) never contains.
    const textByUrl = new Map(pages.map((p) => [p.url, this.normalizeText((p.text || '') + ' ' + (p.html || ''))]));

    let dropped = 0;
    for (const f of facts) {
      if (f.validationNote?.startsWith('Reconcile:')) continue; // already excluded in stage 5
      const pageText = textByUrl.get(f.sourceUrl);
      if (!pageText) {
        await this.prisma.siteContextFact.update({ where: { id: f.id }, data: { validated: false, validationNote: 'No cached text for the cited page.' } });
        dropped++;
        continue;
      }
      const needle = this.normalizeText(f.excerpt || f.value);
      const supported = needle.length > 0 && pageText.includes(needle);
      await this.prisma.siteContextFact.update({
        where: { id: f.id },
        data: { validated: supported, validationNote: supported ? null : 'Excerpt not found verbatim in the cited page\'s text.' },
      });
      if (!supported) dropped++;
    }
    if (dropped > 0) await this.addNote(run.id, `Validation dropped ${dropped} unsupported assertion(s) — they will not appear in the candidate profile.`);
  }

  private normalizeText(s: string): string {
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // ─── Stage 7: Consolidate ───────────────────────────────────────────────

  /**
   * Category-level consolidation (§18): one bounded LLM call covering every
   * category that has validated facts, asked to merge genuine duplicates,
   * keep distinct offerings separate, surface conflicts, and list missing
   * fields — never asked to invent a value the facts don't support.
   *
   * Adaptation from the source spec's "one call per category": batched into
   * a single call here to keep a run's LLM call count bounded (this module
   * already makes up to ceil(selectedPages/4) calls in stageExtract); the
   * output schema still keeps every category's summary separate.
   *
   * A category with zero validated facts costs no LLM call — its summary row
   * is written deterministically with an empty fact list and every field of
   * that category in `missingFields`.
   */
  private async stageConsolidate(run: RunRow): Promise<void> {
    const existing = await this.prisma.siteContextCategorySummary.findMany({ where: { runId: run.id } });
    if (existing.length > 0) return; // already consolidated on a prior attempt

    const validFacts = await this.prisma.siteContextFact.findMany({ where: { runId: run.id, validated: true } });
    const byCategory = new Map<string, typeof validFacts>();
    for (const [category, fields] of Object.entries(CATEGORY_FIELDS)) {
      byCategory.set(category, validFacts.filter((f) => fields.includes(f.field as FactField)));
    }

    const nonEmpty = [...byCategory.entries()].filter(([, facts]) => facts.length > 0);
    // `run.refine === false` means "this run must never call an LLM" (same
    // contract stageExtract honors) — never overridden by a category having
    // facts to consolidate.
    if (nonEmpty.length === 0 || !run.refine || !this.llm.isAvailable()) {
      for (const [category, fields] of Object.entries(CATEGORY_FIELDS)) {
        await this.prisma.siteContextCategorySummary.create({
          data: { runId: run.id, category, missingFields: JSON.stringify(fields), confidence: 0 },
        });
      }
      return;
    }

    const payload = nonEmpty.map(([category, facts]) => ({
      category,
      facts: facts.map((f) => ({ field: f.field, value: f.value, factType: f.factType, confidence: f.confidence })),
    }));

    try {
      const result = await this.llm.json(
        {
          purpose: 'category-level consolidation',
          maxTokens: 2200,
          system:
            'You consolidate already-extracted, already-cited facts about one company into a short per-category ' +
            'summary. You do not have the source pages — only the facts below. Rules:\n' +
            '- Never invent a fact not present in the input.\n' +
            '- Merge genuine duplicates (same claim, different wording) into one canonical fact; keep distinct ' +
            'offerings/claims separate even if similar.\n' +
            '- A conflict is two facts in the same category that cannot both be true (not just two different ' +
            'offerings). List conflicts explicitly; do not silently pick one.\n' +
            '- missingFields: which of the category\'s expected fields (given per category below) have zero facts.\n' +
            '- confidence: your assessment of how complete and mutually consistent this category is (0-1), based on ' +
            'the input facts\' own confidence and factType — not a guess independent of them.\n' +
            'Respond with ONLY JSON: {"categories":[{"category":string,"summary":string,"facts":string[],' +
            '"conflicts":string[],"missingFields":string[],"confidence":number}]}',
          user:
            'Categories and their expected fields:\n' +
            Object.entries(CATEGORY_FIELDS).map(([c, f]) => `${c}: ${f.join(', ')}`).join('\n') +
            '\n\nExtracted facts by category:\n' + JSON.stringify(payload),
        },
        (raw) => this.validateConsolidation(raw),
      );

      const seen = new Set<string>();
      for (const c of result.data) {
        seen.add(c.category);
        await this.prisma.siteContextCategorySummary.create({
          data: {
            runId: run.id, category: c.category, summary: c.summary,
            facts: JSON.stringify(c.facts), conflicts: JSON.stringify(c.conflicts),
            missingFields: JSON.stringify(c.missingFields), confidence: c.confidence,
          },
        });
      }
      for (const category of Object.keys(CATEGORY_FIELDS)) {
        if (seen.has(category)) continue;
        const fields = CATEGORY_FIELDS[category];
        const facts = byCategory.get(category) ?? [];
        await this.prisma.siteContextCategorySummary.create({
          data: {
            runId: run.id, category,
            facts: JSON.stringify(facts.map((f) => f.value)),
            missingFields: JSON.stringify(facts.length > 0 ? [] : fields),
            confidence: facts.length > 0 ? 0.5 : 0,
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Category consolidation failed for run ${run.id}: ${(err as Error).message} — falling back to deterministic per-category summaries.`);
      for (const [category, fields] of Object.entries(CATEGORY_FIELDS)) {
        const facts = byCategory.get(category) ?? [];
        await this.prisma.siteContextCategorySummary.create({
          data: {
            runId: run.id, category,
            facts: JSON.stringify([...new Set(facts.map((f) => f.value))]),
            missingFields: JSON.stringify(facts.length > 0 ? [] : fields),
            confidence: facts.length > 0 ? 0.5 : 0,
          },
        });
      }
    }
  }

  private validateConsolidation(raw: unknown): Array<{
    category: string; summary: string | null; facts: string[]; conflicts: string[]; missingFields: string[]; confidence: number;
  }> {
    const obj = (raw ?? {}) as { categories?: unknown };
    if (!Array.isArray(obj.categories)) return [];
    const validCategories = new Set(Object.keys(CATEGORY_FIELDS));
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 30) : [];
    const out: Array<{ category: string; summary: string | null; facts: string[]; conflicts: string[]; missingFields: string[]; confidence: number }> = [];
    for (const entry of obj.categories) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const category = typeof e.category === 'string' ? e.category : '';
      if (!validCategories.has(category)) continue;
      const confidenceRaw = typeof e.confidence === 'number' ? e.confidence : 0;
      out.push({
        category,
        summary: typeof e.summary === 'string' ? e.summary.trim().slice(0, 500) : null,
        facts: strArr(e.facts),
        conflicts: strArr(e.conflicts),
        missingFields: strArr(e.missingFields).filter((f) => (CATEGORY_FIELDS[category] as string[]).includes(f)),
        confidence: Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0,
      });
    }
    return out;
  }

  // ─── Compile final SiteContext ──────────────────────────────────────────

  private async compile(run: RunRow, project: { name: string; domain: string; category: string | null; competitors: string | null }): Promise<SiteContextData & { id: string }> {
    const validFacts = await this.prisma.siteContextFact.findMany({ where: { runId: run.id, validated: true } });
    const pages = await this.prisma.siteContextRunPage.findMany({ where: { runId: run.id } });
    const selectedPages = pages.filter((p) => p.selected);
    const homepage = pages.find((p) => p.purposeCategory === 'homepage') ?? pages[0];

    const byField = (field: FactField, cap: number): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const f of validFacts.filter((x) => x.field === field)) {
        const key = f.value.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(f.value.trim());
        if (out.length >= cap) break;
      }
      return out;
    };
    const singular = (field: FactField): string | null => {
      const counts = new Map<string, { value: string; n: number }>();
      for (const f of validFacts.filter((x) => x.field === field)) {
        const key = f.value.trim().toLowerCase();
        const entry = counts.get(key) ?? { value: f.value.trim(), n: 0 };
        entry.n++;
        counts.set(key, entry);
      }
      let best: { value: string; n: number } | null = null;
      for (const c of counts.values()) if (!best || c.n > best.n) best = c;
      return best?.value ?? null;
    };

    const markets = byField('markets', 5).filter((m) => /^[A-Z]{2}$/.test(m));
    const services = byField('services', 25);
    const icp = byField('icp', 10);
    const valueProps = byField('valueProps', 10);
    const painPoints = byField('painPoints', 12);
    const outcomes = byField('outcomes', 12);

    const description = singular('description') ?? (homepage?.description ?? null);
    const category = singular('category') ?? project.category;
    const vertical = singular('vertical');
    const geo = markets[0] ?? this.geoFromDomain(run.domain);

    const expandedFields: FactField[] = [
      'legalName', 'alternateName', 'foundedYear', 'headquarters', 'officeLocation', 'languages',
      'pricingModel', 'differentiator', 'leadership', 'certification', 'award', 'partner', 'technology',
      'businessModel', 'contact',
    ];
    const facts: Record<string, string[]> = {};
    for (const field of expandedFields) {
      const values = byField(field, 10);
      if (values.length > 0) facts[field] = values;
    }

    const { identityType, identityConfidence } = this.resolveIdentity(validFacts, project);
    const socialProfiles = await this.confirmedSocialProfiles(run.projectId);
    const { completeness, overallCompleteness } = await this.scoreCompleteness(run.id, socialProfiles.length > 0);

    const notes = this.parseStringArray(run.notes);
    const costEntries = notes.filter((n) => n.startsWith('__cost__:'));
    const costUsd = costEntries.reduce((sum, n) => sum + (Number(n.split(':')[1]) || 0), 0);
    const llmModel = costEntries.length > 0 ? costEntries[costEntries.length - 1].split(':')[2] ?? null : null;
    // A successful LLM batch call is the only thing that ever writes a
    // __cost__ note (see stageExtract) — more reliable than inferring from
    // fact shape, since a model's excerpt could coincidentally equal its value.
    const usedLlm = costEntries.length > 0;

    const fieldSources: Record<string, Array<{ url: string; excerpt: string; observedAt: string }>> = {};
    const citeCap = 5;
    for (const field of ['services', 'icp', 'valueProps', 'painPoints', 'outcomes', 'markets', 'category', 'vertical', 'description'] as FactField[]) {
      const cites = validFacts
        .filter((f) => f.field === field)
        .slice(0, citeCap)
        .map((f) => ({ url: f.sourceUrl, excerpt: (f.excerpt || f.value).slice(0, 300), observedAt: f.observedAt.toISOString() }));
      if (cites.length > 0) fieldSources[field] = cites;
    }

    const data: SiteContextData = {
      domain: run.domain,
      brand: project.name,
      category,
      vertical,
      description,
      geo,
      markets,
      services,
      icp,
      valueProps,
      painPoints,
      outcomes,
      competitors: this.parseCompetitors(project.competitors),
      pagesFetched: pages.filter((p) => p.fetched).length,
      pageUrls: selectedPages.map((p) => p.url),
      extraction: usedLlm ? 'llm-synthesized' : 'deterministic',
      llmModel,
      costUsd,
      identityType,
      identityConfidence,
      completeness,
      overallCompleteness,
      socialProfiles,
      facts,
    };

    const row = await this.prisma.siteContext.create({
      data: {
        projectId: run.projectId, domain: data.domain, brand: data.brand, category: data.category,
        vertical: data.vertical, description: data.description, geo: data.geo,
        markets: JSON.stringify(data.markets), services: JSON.stringify(data.services), icp: JSON.stringify(data.icp),
        valueProps: JSON.stringify(data.valueProps), painPoints: JSON.stringify(data.painPoints), outcomes: JSON.stringify(data.outcomes),
        competitors: JSON.stringify(data.competitors), pagesFetched: data.pagesFetched, pageUrls: JSON.stringify(data.pageUrls),
        extraction: data.extraction, llmModel: data.llmModel, costUsd: data.costUsd,
        runId: run.id, fieldSources: JSON.stringify(fieldSources), facts: JSON.stringify(facts),
        identityType, identityConfidence, completeness: JSON.stringify(completeness),
        overallCompleteness, socialProfiles: JSON.stringify(socialProfiles),
      },
    });

    this.logger.log(
      `Staged context built for ${run.domain}: ${data.services.length} services, ${data.icp.length} ICP segments, ` +
        `${selectedPages.length}/${data.pagesFetched} pages selected (${data.extraction}), run ${run.id}`,
    );

    return { ...data, id: row.id };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async addNote(runId: string, note: string): Promise<void> {
    const run = await this.prisma.siteContextRun.findUnique({ where: { id: runId }, select: { notes: true } });
    const notes = this.parseStringArray(run?.notes);
    notes.push(note);
    await this.prisma.siteContextRun.update({ where: { id: runId }, data: { notes: JSON.stringify(notes) } });
  }

  private parseUnknown(raw: string | null | undefined): unknown {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private parseStringArray(raw: string | null | undefined): string[] {
    const v = this.parseUnknown(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  }

  private urlKey(url: string): string {
    return url.replace(/\/$/, '').toLowerCase();
  }

  private truncate(s: string, max: number): string {
    return s.length > max ? s.slice(0, max) : s;
  }

  /** Row → typed data, parsing the JSON string columns. */
  private rowToData(row: {
    id: string; createdAt: Date; domain: string; brand: string; category: string | null; vertical: string | null;
    description: string | null; geo: string | null; markets: string; services: string; icp: string; valueProps: string;
    painPoints: string; outcomes: string; competitors: string; pagesFetched: number; pageUrls: string;
    extraction: string; llmModel: string | null; costUsd: number;
    identityType?: string | null; identityConfidence?: number | null; completeness?: string | null;
    overallCompleteness?: number | null; socialProfiles?: string | null; facts?: string | null;
  }): SiteContextData & { id: string; createdAt: Date } {
    const arr = (v: string): string[] => this.parseStringArray(v);
    const facts: Record<string, string[]> = {};
    if (row.facts) {
      try {
        const parsed = JSON.parse(row.facts) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) if (Array.isArray(v)) facts[k] = v.filter((x): x is string => typeof x === 'string');
      } catch {
        // leave facts empty — pre-v2 rows never had this column
      }
    }
    let completeness: Record<string, number> = {};
    if (row.completeness) {
      try {
        const parsed = JSON.parse(row.completeness) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number') completeness[k] = v;
      } catch {
        completeness = {};
      }
    }
    let socialProfiles: Array<{ platform: string; url: string; state: string }> = [];
    if (row.socialProfiles) {
      try {
        const parsed = JSON.parse(row.socialProfiles) as unknown;
        if (Array.isArray(parsed)) socialProfiles = parsed as typeof socialProfiles;
      } catch {
        socialProfiles = [];
      }
    }
    return {
      id: row.id, createdAt: row.createdAt, domain: row.domain, brand: row.brand, category: row.category,
      vertical: row.vertical, description: row.description, geo: row.geo, markets: arr(row.markets),
      services: arr(row.services), icp: arr(row.icp), valueProps: arr(row.valueProps), painPoints: arr(row.painPoints),
      outcomes: arr(row.outcomes), competitors: this.parseCompetitors(row.competitors), pagesFetched: row.pagesFetched,
      pageUrls: arr(row.pageUrls), extraction: row.extraction === 'llm-synthesized' ? 'llm-synthesized' : 'deterministic',
      llmModel: row.llmModel, costUsd: row.costUsd,
      identityType: (row.identityType as SiteContextData['identityType']) ?? undefined,
      identityConfidence: row.identityConfidence ?? undefined,
      completeness, overallCompleteness: row.overallCompleteness ?? undefined, socialProfiles, facts,
    };
  }

  /** Parse `Project.competitors` / `SiteContext.competitors` JSON defensively. */
  private parseCompetitors(raw: string | null | undefined): Array<{ name: string; domain: string | null }> {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const out: Array<{ name: string; domain: string | null }> = [];
      for (const entry of parsed) {
        if (typeof entry === 'string') out.push({ name: entry, domain: null });
        else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
          out.push({ name: (entry as { name: string }).name, domain: ((entry as { domain?: unknown }).domain as string | undefined) ?? null });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Site-context-v2 §2 — a deliberately conservative heuristic, not a
   * classifier: with only one site's own facts to go on (no cross-domain
   * corroboration), Phase 1 can reliably flag "this domain says it belongs to
   * a different legal entity than the one holding the Cailyx project" and
   * nothing finer. Franchise/regional-site detection needs multi-location
   * evidence this pipeline doesn't gather yet — left `unknown` rather than guessed.
   */
  private resolveIdentity(
    validFacts: Array<{ field: string; value: string }>,
    project: { name: string },
  ): { identityType: SiteContextData['identityType']; identityConfidence: number } {
    const legalName = validFacts.find((f) => f.field === 'legalName')?.value;
    const orgBrand = validFacts.find((f) => f.field === 'brand')?.value;
    const hasParentOrgSignal = validFacts.some((f) => f.field === 'legalName' || f.field === 'alternateName');

    if (!legalName && !orgBrand) {
      return { identityType: 'unknown', identityConfidence: 0.2 };
    }
    const projectKey = project.name.trim().toLowerCase();
    const orgKey = (legalName ?? orgBrand ?? '').trim().toLowerCase();
    const shareWord = projectKey.split(/\s+/).some((w) => w.length > 2 && orgKey.includes(w));
    if (!shareWord && hasParentOrgSignal) {
      // The site's own declared identity shares no word with the project's
      // name on record — plausibly a product microsite or subsidiary, but
      // Phase 1 has no way to tell which without a parent-org field, which
      // schema.org's `parentOrganization`/`subOrganization` would carry had
      // the site published one. Flagged, not guessed further.
      return { identityType: 'subsidiary', identityConfidence: 0.5 };
    }
    return { identityType: 'company', identityConfidence: legalName ? 0.8 : 0.6 };
  }

  /**
   * Confirmed digital-presence accounts for this project (§14-16's output),
   * read directly — never re-derived — so this module never duplicates
   * discovery/verification work `digital-presence` already owns.
   */
  private async confirmedSocialProfiles(projectId: string): Promise<Array<{ platform: string; url: string; state: string }>> {
    const accounts = await this.prisma.presenceAccount.findMany({
      where: { projectId, state: 'confirmed', entity: 'company' },
      select: { platform: true, url: true, state: true },
    });
    return accounts;
  }

  /**
   * Weighted completeness (§22): per-category from `SiteContextCategorySummary`
   * (1 - missingFields/totalFields for that category), plus a fixed-weight
   * digital-presence line since that data doesn't come from a category
   * summary. Confidence and completeness are reported separately — this is
   * completeness only, not a judgement on whether the populated facts are trustworthy.
   */
  private async scoreCompleteness(runId: string, hasSocialProfiles: boolean): Promise<{ completeness: Record<string, number>; overallCompleteness: number }> {
    const WEIGHTS: Record<string, number> = {
      identity: 0.15, descriptions: 0.05, offerings: 0.15, positioning: 0.1, customers: 0.15,
      geography: 0.1, organization: 0.05, credibility: 0.1, go_to_market: 0.05, technology: 0.05,
    };
    const summaries = await this.prisma.siteContextCategorySummary.findMany({ where: { runId } });
    const completeness: Record<string, number> = {};
    for (const [category, fields] of Object.entries(CATEGORY_FIELDS)) {
      const row = summaries.find((s) => s.category === category);
      const missing = row ? this.parseStringArray(row.missingFields).length : fields.length;
      completeness[category] = fields.length > 0 ? Math.max(0, 1 - missing / fields.length) : 0;
    }
    completeness.digital_presence = hasSocialProfiles ? 1 : 0;

    let overall = 0;
    for (const [category, weight] of Object.entries(WEIGHTS)) overall += (completeness[category] ?? 0) * weight;
    overall += completeness.digital_presence * 0.05;
    return { completeness, overallCompleteness: Number(overall.toFixed(3)) };
  }

  /**
   * Country from ccTLD, as an ISO-3166 alpha-2 code — a weak but free geo
   * signal; the `markets[]` extraction (real copy, not a domain suffix) wins
   * when it says something.
   */
  private geoFromDomain(domain: string): string | null {
    const map: Record<string, string> = {
      ie: 'IE', uk: 'GB', de: 'DE', fr: 'FR', in: 'IN',
      us: 'US', ca: 'CA', au: 'AU', nz: 'NZ',
      es: 'ES', it: 'IT', nl: 'NL', ch: 'CH', ae: 'AE',
    };
    const parts = domain.split('.');
    return map[parts[parts.length - 1]] ?? null;
  }

  private normalizeDomain(domain: string): string {
    return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  }

  /**
   * Cheap content fingerprint used to spot a catch-all route serving the same
   * document under many paths.
   */
  private fingerprint(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim().slice(0, 4000);
    let hash = 5381;
    for (let i = 0; i < normalized.length; i++) {
      hash = (Math.imul(hash, 33) ^ normalized.charCodeAt(i)) >>> 0;
    }
    return String(hash) + ':' + normalized.length;
  }
}
