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
import { DataForSeoSerpService } from '../serp-intelligence/dataforseo-serp.service';
import { PresenceService } from '../digital-presence/presence.service';
import { EXPECTED_PLATFORMS } from '../digital-presence/presence.types';
import { PipelineQueueService } from '../jobs/pipeline-queue.service';
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

/** Same idea, but matched against sitemap URLs we actually found. Broad on
 *  purpose — this only ranks candidates, it no longer excludes anything, so
 *  it can afford to cover consumer/e-commerce sites too, not just B2B/SaaS. */
const HIGH_SIGNAL_PATTERNS =
  /\/(services?|solutions?|products?|pricing|plans|industr(y|ies)|use-cases?|what-we-do|who-we-serve|capabilities|expertise|sectors?|about|faq|how-it-works|reviews?|testimonials?)(\/|$)/i;

/** Nav/footer noise that is never a service name. */
const NAV_NOISE =
  /^(home|about( us)?|contact( us)?|blog|news|careers?|jobs|login|log ?in|sign ?(in|up)|privacy|terms|cookies?|sitemap|faq|support|help|search|menu|close|back to top|all rights reserved|subscribe|newsletter|follow us|get started|book a (call|demo)|read more|learn more|our team|team|press|partners?)$/i;

/**
 * Single words that are pricing tiers, plan names or process-step labels rather
 * than offerings. "companies that do Starter" is not a query anyone types.
 */
const TIER_AND_STEP_WORDS =
  /^(starter|basic|standard|premium|pro|plus|growth|scale|enterprise|business|free|trial|custom|lite|advanced|essential|team|agency|diagnose|discover|build|operate|compound|deliver|launch|plan|design|measure|optimi[sz]e|onboard|scoping?|audit|strategy|execution|results?|process|approach|method|phase|step|one|two|three)$/i;

/**
 * E-commerce/catalog browse-and-merchandising section headers — "Shop by
 * Category", "Trending Brands", "New Arrivals" are how a storefront organizes
 * its own catalog, never a thing a buyer asks "who provides X" about. Without
 * this, every consumer/retail site's nav chrome gets read as a services list.
 */
const MERCHANDISING_NOISE =
  /^(shop by|browse (by|all)|explore (by|all)|trending|popular|featured|curated|new arrivals?|newly added|best[- ]?sellers?|top[- ]?(picks|rated|sellers?)|recommended( for you)?|see all|view all|all (brands?|products?|categories))\b/i;

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

/** Pages whose content is about the company internally — recruiting, investor
 *  relations, channel partners — never what it sells. Blindly grabbing headings
 *  off a careers page ("Paid Opportunities", "Marketing Intern") produced fake
 *  "services"; these page types are excluded from the deterministic heading
 *  grab below and flagged to the LLM pass as off-limits for customer-facing fields. */
const ORG_ONLY_PAGE_TYPES = new Set<PageType>(['careers', 'press', 'partner', 'leadership']);

/** Page types where a heading is actually likely to name a paid offering. */
const SERVICE_HEADING_PAGE_TYPES = new Set<PageType>(['homepage', 'service', 'pricing', 'industries', 'case-study']);

/** Page types where an H1/hero line is actually likely to be a marketing tagline,
 *  not just the page's navigational title ("FAQ", "About Us", "Careers"). */
const VALUE_PROP_HEADING_PAGE_TYPES = new Set<PageType>(['homepage', 'service', 'pricing']);

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
  externalEnrichment: boolean;
  socialDiscovery: boolean;
  gapResearch: boolean;
  searchesUsed: number;
  searchCostUsd: number;
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
  /**
   * Phase 2, spec §17 — search for a bounded set of high-value fields (HQ,
   * founding year, leadership, certifications, awards) when first-party
   * extraction found none. Off by default: this spends real DataForSEO
   * search credits, so it is only ever on when the caller explicitly asks.
   */
  externalEnrichment?: boolean;
  /**
   * Phase 2, spec §15–16 — when a platform this brand should plausibly have
   * has no confirmed `PresenceAccount`, trigger the digital-presence
   * module's own existing SERP-fallback discovery (`PresenceService.discover
   * (projectId, searchWeb: true)`) for it, rather than reimplementing search-
   * based social discovery here. Off by default — same real-spend gate as
   * `externalEnrichment`.
   */
  socialDiscovery?: boolean;
  /**
   * Phase 2, spec §19 — after consolidation, run one bounded search pass over
   * *only* the fields consolidation's own `missingFields` flagged, then
   * refresh the category summaries that changed. Never a general "find
   * everything" pass — the field list, search count and page count are all
   * capped, per the spec's own "give the research agent... a stopping
   * condition" rule. Off by default — real DataForSEO spend.
   */
  gapResearch?: boolean;
}

@Injectable()
export class AeoContextService {
  private readonly logger = new Logger(AeoContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fetcher: FetcherService,
    private readonly llm: AeoLlmService,
    private readonly dataForSeoSerp: DataForSeoSerpService,
    private readonly presence: PresenceService,
    private readonly pipelineQueue: PipelineQueueService,
  ) {
    // `build()` runs a real crawl + several LLM/search stages and can
    // legitimately take 20-30+ minutes end to end (this module's own §9.4
    // budgets pause it every 5 minutes of elapsed work so no single HTTP
    // request blocks that long) — so a plain synchronous call needs an
    // external resume() call every few minutes to ever finish. Queuing it
    // (same pattern `technical-audit` already uses) moves that "keep calling
    // resume()" loop into a background worker, which isn't bound by an HTTP
    // timeout and CAN just loop until genuinely done — see `buildUntilDone`.
    this.pipelineQueue.registerHandler('site-context-build', (data: { projectId: string; opts: BuildOpts }) =>
      this.buildUntilDone(data.projectId, data.opts),
    );
  }

  private static readonly BUILD_LOOP_CEILING_MS = 45 * 60 * 1000;

  /**
   * Drives `build()` to completion in the background: a
   * `SiteContextRunPausedException` just means "call resume() again," not a
   * failure, so this loops on it (no backoff — it's a self-imposed budget,
   * not a transient error) until the run finishes or the wall-clock ceiling
   * is hit. A genuine error still propagates immediately.
   */
  async buildUntilDone(projectId: string, opts: BuildOpts = {}): Promise<SiteContextData & { id: string }> {
    const deadline = Date.now() + AeoContextService.BUILD_LOOP_CEILING_MS;
    try {
      return await this.build(projectId, opts);
    } catch (err) {
      if (!(err instanceof SiteContextRunPausedException)) throw err;
      let runId = err.runId;
      for (;;) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Site context build for project ${projectId} still not complete after ${AeoContextService.BUILD_LOOP_CEILING_MS / 60000} ` +
              `minutes of self-resuming (last pause: run ${runId}) — giving up rather than looping forever.`,
          );
        }
        try {
          return await this.resume(runId);
        } catch (resumeErr) {
          if (!(resumeErr instanceof SiteContextRunPausedException)) throw resumeErr;
          runId = resumeErr.runId;
          this.logger.log(`Site context build ${runId}: paused after "${resumeErr.reachedStage}", self-resuming immediately.`);
        }
      }
    }
  }

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

    // A run that paused on its elapsed-time budget never reaches `completed`
    // or `failed` — it just stops mid-stage with its progress (pages already
    // fetched/extracted) intact. A caller re-invoking build() shortly after a
    // pause (e.g. AeoAuditService.resume() retrying) would otherwise discard
    // that progress and re-crawl from scratch every time. Pick up that run
    // instead, as long as it's recent enough to still be the same request —
    // an old abandoned run from a prior day is not silently resumed here.
    const resumable = await this.prisma.siteContextRun.findFirst({
      where: {
        projectId,
        status: { notIn: ['completed', 'failed'] },
        startedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (resumable) return this.resume(resumable.id, { maxElapsedMs: opts.maxElapsedMs });

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
        externalEnrichment: opts.externalEnrichment === true,
        socialDiscovery: opts.socialDiscovery === true,
        gapResearch: opts.gapResearch === true,
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
        const order = ['discover', 'inspect', 'select', 'extract', 'reconcile', 'validate', 'social-discovery', 'external-enrich', 'consolidate', 'gap-research', 'verify'];
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
        await checkpoint('validate', 'discovering-social');
      }
      if (!completed('social-discovery')) {
        await this.stageSocialDiscovery(run);
        await checkpoint('social-discovery', 'enriching-external');
      }
      if (!completed('external-enrich')) {
        await this.stageExternalEnrichment(run);
        await checkpoint('external-enrich', 'consolidating');
      }
      if (!completed('consolidate')) {
        await this.stageConsolidate(run);
        await checkpoint('consolidate', 'researching-gaps');
      }
      if (!completed('gap-research')) {
        await this.stageGapResearch(run);
        await checkpoint('gap-research', 'verifying');
      }
      if (!completed('verify')) {
        await this.stageVerify(run);
        await checkpoint('verify', 'completed');
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
        // The headless-browser render path has no real HTTP status on its result type,
        // so a plain fetch first is what actually tells a live page from a dead link —
        // including soft-404s that return 200 with an "not found"-shaped body.
        const statusCheck = await this.fetcher.fetch({ url, timeout: 15000 }, 'aeo-context-check', run.id).catch(() => null);
        if (statusCheck && (statusCheck.status < 200 || statusCheck.status >= 400)) {
          this.logger.debug(`Context discover skipped ${url}: HTTP ${statusCheck.status}`);
          return;
        }

        const res = await this.fetcher.render({ url, jsDisabled: false, timeout: 30000 }, 'aeo-context', run.id);
        if (!res.html) return;
        if (this.looksLike404(res.title, res.text)) {
          this.logger.debug(`Context discover skipped ${url}: looks like a 404/error page ("${res.title}")`);
          return;
        }
        const fp = this.fingerprint(res.text || res.html);
        if (fingerprints.has(fp)) {
          this.logger.debug('Context discover skipped ' + url + ': same content as a page already read');
          return;
        }
        fingerprints.add(fp);
        pagesSpent++;
        await this.prisma.siteContextRunPage.create({
          data: {
            runId: run.id, url, discoverySource: source, fetched: true, statusCode: statusCheck?.status ?? 200, fetchedAt: new Date(),
            html: this.truncate(res.html, MAX_CACHED_HTML), text: this.truncate(res.text || '', MAX_CACHED_TEXT),
            title: res.title || null, contentHash: fp,
          },
        });
      } catch (err) {
        this.logger.warn('Context discover fetch failed ' + url + ' (source: ' + source + '): ' + (err as Error).message);
      }
    };

    let homeHtml: string | null = null;
    if (!seen.has(this.urlKey(origin + '/'))) {
      await visit(origin + '/', 'homepage');
      const homeRow = await this.prisma.siteContextRunPage.findFirst({ where: { runId: run.id, url: origin + '/' } });
      homeHtml = homeRow?.html ?? null;
      if (!homeHtml) {
        await this.addNote(run.id, `Homepage fetch failed for ${origin}/ — nav-link discovery and homepage content are unavailable this run.`);
      }
    } else {
      homeHtml = existing.find((p) => this.urlKey(p.url) === this.urlKey(origin + '/'))?.html ?? null;
    }

    // §1 — sitemap + robots.txt is the source of truth for real URLs on the site.
    let fromSitemap: string[] = [];
    if (budgetLeft()) {
      const requestCounter = { n: requestsSpent };
      fromSitemap = await this.sitemapCandidates(origin, run.id, requestCounter, run.maxRequests);
      requestsSpent = requestCounter.n;
      for (const url of fromSitemap) {
        if (!budgetLeft()) break;
        await visit(url, 'sitemap');
      }
    }

    // §2 — only when the site has no usable sitemap do we fall back to whatever
    // links the homepage itself points at (nav/header first, then anywhere on
    // the page). A fixed guessed-path list is the last resort of all, and only
    // fires when even the homepage gave us nothing to follow.
    if (budgetLeft() && fromSitemap.length === 0) {
      const navLinks = homeHtml ? this.internalNavLinks(homeHtml, origin) : [];
      const bodyLinks = homeHtml ? this.allInternalLinks(homeHtml, origin) : [];
      const homeLinks = navLinks.length > 0 ? navLinks : bodyLinks;
      const fallback = homeLinks.length > 0 ? homeLinks : HIGH_SIGNAL_PATHS.map((p) => origin + p);
      const source = homeLinks.length > 0 ? 'homepage-links' : 'guess';
      for (const url of fallback) {
        if (!budgetLeft()) break;
        await visit(url, source);
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

  /** Cheap heuristic for a soft-404 (HTTP 200 with an error-page body) or a rendered error page. */
  private looksLike404(title: string, text: string): boolean {
    const t = (title || '').trim();
    if (/^\s*404\b/i.test(t) || /\bnot found\b/i.test(t)) return true;
    const body = (text || '').trim();
    return body.length > 0 && body.length < 120 && /\bnot found\b/i.test(body);
  }

  /** Site-context-v2 §3 — sitemap paths tried when `robots.txt` names none. */
  private static readonly FALLBACK_SITEMAP_PATHS = [
    '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml', '/sitemap/sitemap.xml',
  ];

  /**
   * Pull URLs out of the sitemap (§3: robots.txt `Sitemap:` directives first, then common
   * fallback paths). Index-aware to a bounded depth — a sitemap index can point at many
   * child sitemaps, and a child can itself be another index, so the whole tree is walked
   * (capped at MAX_SITEMAP_FILES/MAX_SITEMAP_DEPTH) rather than just the first few files —
   * counting every read against the shared request budget.
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

    // A sitemap index can point at any number of child sitemaps (large sites
    // often split by type: pages, products, blog, ...), and a child can itself
    // be another index. Walk the whole tree within the request budget instead
    // of only reading the first few — otherwise most of the site's real URLs
    // never even get considered.
    const isSitemapFile = (u: string) => /\.xml(\.gz)?$/i.test(u);
    const MAX_SITEMAP_FILES = 50;
    const MAX_SITEMAP_DEPTH = 4;
    const flat: string[] = top.filter((u) => !isSitemapFile(u));
    let frontier = top.filter(isSitemapFile);
    let filesRead = 0;
    for (let depth = 0; depth < MAX_SITEMAP_DEPTH && frontier.length > 0 && filesRead < MAX_SITEMAP_FILES; depth++) {
      const nextFrontier: string[] = [];
      for (const child of frontier) {
        if (counter.n >= maxRequests || filesRead >= MAX_SITEMAP_FILES) break;
        filesRead++;
        const entries = await readSitemap(child);
        flat.push(...entries.filter((u) => !isSitemapFile(u)));
        nextFrontier.push(...entries.filter(isSitemapFile));
      }
      frontier = nextFrontier;
    }

    const sameOrigin = flat.filter((u) => u.startsWith(origin)); // own host only

    // A real sitemap can be almost entirely one repeating pattern (a product
    // catalog, a blog archive) — keeping every URL would crowd the page
    // budget with near-duplicates and starve everything else. Group by path
    // template (parent path, so /brand/<slug> and /brand/<slug2> collapse to
    // the same group) and keep only a few samples per group.
    const SAMPLES_PER_TEMPLATE = 2;
    const byTemplate = new Map<string, string[]>();
    for (const u of sameOrigin) {
      const path = u.slice(origin.length).split(/[?#]/)[0];
      const segments = path.split('/').filter(Boolean);
      const template = segments.length >= 2 ? segments.slice(0, -1).join('/') : path;
      const group = byTemplate.get(template) ?? [];
      if (group.length < SAMPLES_PER_TEMPLATE) group.push(u);
      byTemplate.set(template, group);
    }
    for (const group of byTemplate.values()) urls.push(...group);

    // High-signal keyword matches (about, pricing, faq, ...) lead; everything
    // else — the site's real structure, whatever shape that takes — fills the
    // rest of the budget rather than being discarded outright.
    urls.sort((a, b) => {
      const aSignal = HIGH_SIGNAL_PATTERNS.test(a) ? 0 : 1;
      const bSignal = HIGH_SIGNAL_PATTERNS.test(b) ? 0 : 1;
      if (aSignal !== bSignal) return aSignal - bSignal;
      return a.split('/').length - b.split('/').length || a.length - b.length;
    });
    return urls.slice(0, 20);
  }

  /** Same-origin nav/header links from the homepage, deduped. */
  private internalNavLinks(html: string, origin: string): string[] {
    return this.internalLinksFrom(html, origin, 'nav a[href], header a[href]', 15);
  }

  /** Every same-origin link anywhere on the homepage — last-resort fallback when there's no sitemap. */
  private allInternalLinks(html: string, origin: string): string[] {
    return this.internalLinksFrom(html, origin, 'a[href]', 40);
  }

  private internalLinksFrom(html: string, origin: string, selector: string, limit: number): string[] {
    const $ = cheerio.load(html);
    const out: string[] = [];
    const seen = new Set<string>();
    $(selector).each((_, el) => {
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
    return out.slice(0, limit);
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

    const pageType = page.pageType as PageType | null;
    if (SERVICE_HEADING_PAGE_TYPES.has(pageType as PageType)) {
      $('h2, h3').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (this.isCandidatePhrase(text) && !inPersonBlock($(el))) add('services', text);
      });
      $('[class*="card"] h4, [class*="service"] h4, [class*="tile"] h4, li > strong').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (this.isCandidatePhrase(text) && !inPersonBlock($(el))) add('services', text);
      });
    }
    if (VALUE_PROP_HEADING_PAGE_TYPES.has(pageType as PageType)) {
      $('h1, [class*="hero"] p').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text.length > 15 && text.length < 160) add('valueProps', text);
      });
    }

    return out;
  }

  /** One constrained-JSON call per small page batch, each returned fact tagged with its source page. */
  private async extractBatchLlm(run: RunRow, batch: PageRow[]): Promise<{ facts: DraftFact[]; model: string; costUsd: number }> {
    const urls = batch.map((p) => p.url);
    let corpus = '';
    for (const page of batch) {
      const pageType = page.pageType as PageType | null;
      const tag = pageType && ORG_ONLY_PAGE_TYPES.has(pageType)
        ? ` [page type: ${pageType} — internal/organizational page, NOT a source for services/valueProps/businessModel/category/description]`
        : '';
      corpus += '\n\n--- ' + page.url + tag + ' ---\n' + (page.title ? page.title + '\n' : '') + (page.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BATCH_CHARS);
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
          '- A page marked "[page type: ... — internal/organizational page, ...]" is about the company\'s own hiring, ' +
          'investors or partners — e.g. a careers page\'s "paid internship" or "join our team" copy is written for ' +
          'job applicants, not customers. Never extract services/valueProps/businessModel/category/description from ' +
          'such a page; it may still supply organizational facts (legalName, headquarters, foundedYear, leadership, contact).\n' +
          '- field is one of: services, icp, valueProps, painPoints, outcomes, markets, category, vertical, ' +
          'description, legalName, alternateName, foundedYear, headquarters, officeLocation, languages, ' +
          'pricingModel, differentiator, leadership, certification, award, partner, technology, businessModel, contact.\n' +
          '- services: concrete offerings a buyer can pay for, 2-6 words, in the site\'s own words. Exclude pricing tiers, process steps, company values, people\'s names, and a storefront\'s own catalog/browse chrome ("Shop by Category", "Trending Brands", "New Arrivals", "Best Sellers") — those organize an existing catalog, they are not themselves a thing sold.\n' +
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
    if (MERCHANDISING_NOISE.test(text)) return false;
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

  // ─── Stage 7a: Social discovery (Phase 2, spec §15–16) ──────────────────

  /**
   * Social-discovery fallback + verification (site-context-v2 Phase 2, spec
   * §15–16) — opt-in (`run.socialDiscovery`), since it spends real DataForSEO
   * search credits.
   *
   * Deliberately does NOT reimplement search-based social discovery or
   * candidate verification here: `digital-presence/presence.serp.service.ts`
   * (`PresenceSerpService`, driving `PresenceService.discover(projectId,
   * searchWeb: true)`) already IS spec §15 — it searches only the platforms a
   * project's own site crawl didn't already find, using the same DataForSEO
   * provider, with the same "queries spent only on what's actually missing"
   * discipline this stage would otherwise duplicate. And every candidate it
   * finds already lands as `PresenceAccount(state: 'candidate')`, requiring
   * explicit confirmation before it counts — spec §16's "a missing profile is
   * better than a false profile" rule, already enforced.
   *
   * So this stage's only job is to trigger that existing discovery when this
   * run has platform gaps, and wait (bounded) for it to finish — Phase 1's
   * `compile()` already re-reads `confirmedSocialProfiles()` fresh at the end
   * of the run, so anything this newly confirms is picked up with no further
   * merge code needed here.
   */
  private async stageSocialDiscovery(run: RunRow): Promise<void> {
    if (!run.socialDiscovery) return;

    const confirmed = await this.confirmedSocialProfiles(run.projectId);
    const confirmedPlatforms = new Set(confirmed.map((c) => c.platform));
    const missing = EXPECTED_PLATFORMS.filter((p) => !confirmedPlatforms.has(p));
    if (missing.length === 0) {
      await this.addNote(run.id, 'Social discovery: every expected platform already has a confirmed account — nothing to search for.');
      return;
    }

    let discoveryRunId: string;
    try {
      const started = await this.presence.discover(run.projectId, true);
      discoveryRunId = started.id;
    } catch (err) {
      this.logger.warn(`Social discovery: failed to start for run ${run.id}: ${(err as Error).message}`);
      return;
    }

    // Bounded wait, not the SiteContextRun's own pause/resume mechanism —
    // that budget is for THIS run's own work, not for a different module's
    // async job. If discovery is still running when the cap is hit, this
    // stage just moves on without it; whatever it confirms later is picked
    // up by a future run's `compile()`, not retroactively by this one.
    const maxWaitMs = 90_000;
    const pollIntervalMs = 5_000;
    const waitStarted = Date.now();
    let finalStatus = 'crawling';
    let serpQueries = 0;
    let serpCostUsd = 0;
    while (Date.now() - waitStarted < maxWaitMs) {
      await this.sleep(pollIntervalMs);
      const status = await this.presence.getRun(run.projectId, discoveryRunId).catch(() => null);
      if (!status) break;
      finalStatus = status.status;
      serpQueries = status.serpQueries;
      serpCostUsd = status.serpCostUsd;
      if (status.status === 'completed' || status.status === 'failed') break;
    }

    await this.prisma.siteContextRun.update({
      where: { id: run.id },
      data: { searchesUsed: { increment: serpQueries }, searchCostUsd: { increment: serpCostUsd } },
    });

    await this.addNote(
      run.id,
      finalStatus === 'completed'
        ? `Social discovery: ran for ${missing.length} missing platform(s), ${serpQueries} search(es), $${serpCostUsd.toFixed(4)} — see the project's presence inventory for candidates awaiting confirmation.`
        : `Social discovery: did not finish within ${maxWaitMs}ms (last status "${finalStatus}") — it continues in the background; re-run site context later to pick up anything it confirms.`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Stage 7b: External enrichment (Phase 2, spec §17) ──────────────────

  /** Bounded set of fields worth an external search when first-party extraction found none. */
  private static readonly EXTERNAL_ENRICHMENT_FIELDS: FactField[] = ['headquarters', 'foundedYear', 'leadership', 'certification', 'award'];
  private static readonly EXTERNAL_MAX_SEARCHES = 2;
  private static readonly EXTERNAL_MAX_RESULTS_PER_SEARCH = 3;

  /**
   * Targeted external company enrichment (site-context-v2 Phase 2, spec §17)
   * — opt-in (`run.externalEnrichment`), since it spends real DataForSEO
   * search credits. Only searches for fields first-party extraction found
   * nothing for; never re-searches a field already covered. Facts are kept
   * as `source: 'external'` and, per the spec's own "keep external facts
   * separate from first-party claims until consolidation" rule, are never
   * trusted on the LLM's word alone: each one is only stored if its cited
   * excerpt is found verbatim in the fetched external page's own text — the
   * same discipline `stageValidate` applies to first-party facts, just
   * applied here since these pages aren't in the run's own `pages` table.
   */
  private async stageExternalEnrichment(run: RunRow): Promise<void> {
    if (!run.externalEnrichment || !run.refine || !this.llm.isAvailable()) return;

    const haveField = new Set((await this.prisma.siteContextFact.findMany({ where: { runId: run.id, validated: true }, select: { field: true } })).map((f) => f.field));
    const missing = AeoContextService.EXTERNAL_ENRICHMENT_FIELDS.filter((f) => !haveField.has(f));
    if (missing.length === 0) return;

    const project = await this.prisma.project.findUnique({ where: { id: run.projectId } });
    const brand = project?.name || run.domain;
    const queries = [`"${brand}" company headquarters founded`, `"${brand}" founder OR leadership OR "about us"`].slice(
      0,
      AeoContextService.EXTERNAL_MAX_SEARCHES,
    );

    await this.runBoundedSearchExtraction(run, {
      label: 'External enrichment',
      brand,
      targetFields: missing,
      queries,
      maxResultsPerSearch: AeoContextService.EXTERNAL_MAX_RESULTS_PER_SEARCH,
    });
  }

  /**
   * Shared engine behind `stageExternalEnrichment` (spec §17) and
   * `stageGapResearch` (spec §19) — both are "run N bounded searches, fetch
   * what they return, extract only the target fields via one LLM call, keep
   * only a fact whose excerpt is found verbatim in the page that supposedly
   * supports it." What differs between the two callers is only which fields
   * they're after and which queries they run to find them — spec §19's own
   * constraint list ("exact fields to resolve... maximum searches... a
   * stopping condition") is exactly this method's parameters.
   */
  private async runBoundedSearchExtraction(
    run: RunRow,
    opts: { label: string; brand: string; targetFields: FactField[]; queries: string[]; maxResultsPerSearch: number },
  ): Promise<{ stored: number }> {
    const { label, brand, targetFields, queries, maxResultsPerSearch } = opts;
    let searchesUsed = 0;
    let searchCostUsd = 0;
    const fetchedByUrl = new Map<string, string>();
    const corpusParts: string[] = [];

    for (const query of queries) {
      const lookup = await this.dataForSeoSerp.search(query);
      searchesUsed++;
      searchCostUsd += lookup.costUsd;
      if (lookup.skipped) {
        await this.addNote(run.id, `${label}: search skipped — ${lookup.skipped}`);
        continue;
      }
      for (const link of lookup.links.slice(0, maxResultsPerSearch)) {
        if (fetchedByUrl.has(link.url)) continue;
        try {
          const page = await this.fetcher.render({ url: link.url, jsDisabled: false, timeout: 20000 }, 'aeo-context-external', run.id);
          const text = (page.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BATCH_CHARS);
          if (text) {
            fetchedByUrl.set(link.url, text);
            corpusParts.push(`\n\n--- ${link.url} ---\n${page.title ? page.title + '\n' : ''}${text}`);
          }
        } catch (err) {
          this.logger.warn(`${label}: fetch failed for ${link.url}: ${(err as Error).message}`);
        }
      }
    }

    await this.prisma.siteContextRun.update({
      where: { id: run.id },
      data: { searchesUsed: { increment: searchesUsed }, searchCostUsd: { increment: searchCostUsd } },
    });

    if (corpusParts.length === 0) {
      await this.addNote(run.id, `${label}: no fetchable external pages found.`);
      return { stored: 0 };
    }

    try {
      const result = await this.llm.json(
        {
          purpose: label.toLowerCase(),
          maxTokens: 1200,
          system:
            `You read pages found via web search about a company — NOT its own site — and extract only facts about "${brand}" ` +
            'itself, never about a different company the page also mentions in passing. Only extract these fields, and ' +
            'only if clearly stated: ' + targetFields.join(', ') + '.\n' +
            '- Every fact MUST cite the exact page URL it came from (sourcePage, must be one of the URLs given) and a ' +
            'short verbatim excerpt (<=200 chars, copied text, not a paraphrase) that supports it.\n' +
            '- Return [] for anything not clearly and directly stated — never infer or guess for an external source.\n' +
            'Respond with ONLY JSON: {"facts":[{"field":string,"value":string,"sourcePage":string,"excerpt":string}]}',
          user: `Pages found via web search, about "${brand}":` + corpusParts.join(''),
        },
        (raw) => this.validateExternalFacts(raw, [...fetchedByUrl.keys()], targetFields),
      );

      let stored = 0;
      for (const f of result.data) {
        const pageText = fetchedByUrl.get(f.sourceUrl);
        const needle = this.normalizeText(f.excerpt || f.value);
        const supported = !!pageText && needle.length > 0 && this.normalizeText(pageText).includes(needle);
        if (!supported) continue; // no benefit of the doubt for an external source — verbatim or dropped
        await this.prisma.siteContextFact.create({
          data: {
            runId: run.id,
            field: f.field,
            value: f.value,
            sourceUrl: f.sourceUrl,
            excerpt: f.excerpt,
            factType: 'explicit',
            confidence: 0.6, // capped below a first-party explicit fact's 0.7 default — single external source, not the subject's own site
            validated: true,
            source: 'external',
          },
        });
        stored++;
      }
      await this.addNote(
        run.id,
        `${label}: ${stored} fact(s) added from ${fetchedByUrl.size} external page(s), ${searchesUsed} search(es), $${searchCostUsd.toFixed(4)}.`,
      );
      await this.addNote(run.id, `__cost__:${result.costUsd}:${result.model}`);
      return { stored };
    } catch (err) {
      this.logger.warn(`${label}: extraction failed for run ${run.id}: ${(err as Error).message}`);
      return { stored: 0 };
    }
  }

  private validateExternalFacts(raw: unknown, allowedUrls: string[], allowedFields: FactField[]): DraftFact[] {
    const obj = (raw ?? {}) as { facts?: unknown };
    if (!Array.isArray(obj.facts)) return [];
    const urlSet = new Set(allowedUrls);
    const fieldSet = new Set(allowedFields);
    const out: DraftFact[] = [];
    for (const entry of obj.facts) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const field = typeof e.field === 'string' ? (e.field as FactField) : null;
      const sourceUrl = typeof e.sourcePage === 'string' ? e.sourcePage : '';
      const value = typeof e.value === 'string' ? e.value.trim().slice(0, 300) : '';
      if (!field || !fieldSet.has(field) || !urlSet.has(sourceUrl) || !value) continue;
      out.push({
        field,
        value,
        sourceUrl,
        excerpt: typeof e.excerpt === 'string' ? e.excerpt.trim().slice(0, 200) : null,
        contentHash: null,
      });
    }
    return out.slice(0, 20);
  }

  // ─── Stage 7c: Gap research (Phase 2, spec §19) ─────────────────────────

  private static readonly GAP_RESEARCH_MAX_FIELDS = 5;
  private static readonly GAP_RESEARCH_MAX_SEARCHES = 2;
  private static readonly GAP_RESEARCH_MAX_RESULTS_PER_SEARCH = 3;

  /**
   * Bounded research agent for gaps only (site-context-v2 Phase 2, spec §19)
   * — opt-in (`run.gapResearch`), since it spends real DataForSEO search
   * credits. Runs after consolidation so it has consolidation's own
   * `missingFields` per category to work from — never a "find everything
   * about the company" pass, exactly the fields consolidation itself flagged
   * as unaddressed, capped at `GAP_RESEARCH_MAX_FIELDS`.
   *
   * Reuses the same bounded search→fetch→extract→verbatim-validate engine as
   * `stageExternalEnrichment` (`runBoundedSearchExtraction`) — the two stages
   * differ only in which fields they target and why. If any fact gets added,
   * the category summaries are stale (they were built without it), so this
   * stage clears and re-runs consolidation once more to reflect what gap
   * research just filled in — the spec's own ordering (§18 consolidation →
   * §19 gap research → §20 *final* synthesis) expects the synthesis a
   * consumer sees to already account for whatever gap research found.
   */
  private async stageGapResearch(run: RunRow): Promise<void> {
    if (!run.gapResearch || !run.refine || !this.llm.isAvailable()) return;

    const summaries = await this.prisma.siteContextCategorySummary.findMany({ where: { runId: run.id } });
    const gapFields = new Set<FactField>();
    for (const s of summaries) {
      try {
        for (const f of JSON.parse(s.missingFields) as string[]) gapFields.add(f as FactField);
      } catch {
        // malformed JSON on a row this module itself wrote would be a bug elsewhere — skip, don't crash gap research over it
      }
    }
    const targetFields = [...gapFields].slice(0, AeoContextService.GAP_RESEARCH_MAX_FIELDS);
    if (targetFields.length === 0) {
      await this.addNote(run.id, 'Gap research: no missing fields to research — consolidation found no gaps.');
      return;
    }

    const project = await this.prisma.project.findUnique({ where: { id: run.projectId } });
    const brand = project?.name || run.domain;
    const queries = [`"${brand}" ${targetFields.slice(0, 3).join(' ')}`, `"${brand}" ${targetFields.slice(3).join(' ')}`]
      .filter((q) => q.trim() !== `"${brand}"`)
      .slice(0, AeoContextService.GAP_RESEARCH_MAX_SEARCHES);

    const { stored } = await this.runBoundedSearchExtraction(run, {
      label: 'Gap research',
      brand,
      targetFields,
      queries,
      maxResultsPerSearch: AeoContextService.GAP_RESEARCH_MAX_RESULTS_PER_SEARCH,
    });

    if (stored > 0) {
      await this.prisma.siteContextCategorySummary.deleteMany({ where: { runId: run.id } });
      await this.stageConsolidate(run);
      await this.addNote(run.id, `Gap research: category summaries refreshed to include ${stored} newly filled field(s).`);
    }
  }

  // ─── Stage 8: Verify (Phase 2, spec §21) ────────────────────────────────

  /**
   * Independent verification pass (site-context-v2 Phase 2, spec §21) — a
   * second, separate LLM call over what `stageConsolidate` already produced,
   * checking the synthesized category summaries against the evidence facts
   * they were built from rather than re-checking raw per-page extraction
   * (that's `stageValidate`'s job, one stage earlier, and it already does a
   * *deterministic* verbatim-excerpt check — stronger than an LLM self-check
   * for what it covers, so this stage exists to catch what a excerpt-match
   * can't: a claim that's technically quoted correctly but describes a
   * customer/partner rather than the subject, mixes current and historical
   * facts, or was embellished during consolidation's own merge/summarize
   * pass).
   *
   * Per the spec's own allowance ("if only one model is available, use a
   * separate call with a verifier-specific instruction and treat it as a
   * secondary review rather than fully independent verification") this runs
   * as a second OpenRouter call, not a second vendor — same gate as
   * `stageConsolidate` (`run.refine` + `this.llm.isAvailable()`), and a
   * no-op when either is false. Unsupported claims are dropped from the
   * category's `facts` list and its `confidence` is penalized; nothing here
   * ever adds a claim, only removes or downgrades one.
   */
  private async stageVerify(run: RunRow): Promise<void> {
    const summaries = await this.prisma.siteContextCategorySummary.findMany({ where: { runId: run.id } });
    const nonEmpty = summaries.filter((s) => {
      try {
        return (JSON.parse(s.facts) as unknown[]).length > 0;
      } catch {
        return false;
      }
    });
    if (nonEmpty.length === 0 || !run.refine || !this.llm.isAvailable()) return;

    const validFacts = await this.prisma.siteContextFact.findMany({ where: { runId: run.id, validated: true } });
    const evidenceByCategory = new Map<string, typeof validFacts>();
    for (const [category, fields] of Object.entries(CATEGORY_FIELDS)) {
      evidenceByCategory.set(category, validFacts.filter((f) => fields.includes(f.field as FactField)));
    }

    const payload = nonEmpty.map((s) => ({
      category: s.category,
      claims: JSON.parse(s.facts) as string[],
      summary: s.summary,
      evidence: (evidenceByCategory.get(s.category) ?? []).map((f) => ({ field: f.field, value: f.value, excerpt: f.excerpt, factType: f.factType })),
    }));

    try {
      const result = await this.llm.json(
        {
          purpose: 'independent claim verification',
          maxTokens: 2000,
          system:
            'You are an independent verifier reviewing another pass\'s output, not the original extractor — read ' +
            'skeptically. For each category, you get its synthesized `claims`/`summary` and the raw `evidence` facts ' +
            '(with excerpts) they were supposedly built from. Check every claim against the evidence and flag:\n' +
            '- A claim with no evidence fact that actually supports it (fabricated or over-generalized during synthesis).\n' +
            '- A claim that is really about a customer, partner, or competitor named in the evidence, not the subject company.\n' +
            '- A claim that blends a current fact with a historical one, or a first-party claim with a third-party one, ' +
            'as if they were the same statement.\n' +
            'Never add a new claim. Return only claims/summaries you keep — omit ones you drop. confidencePenalty is 0 ' +
            'when nothing is wrong, up to 1 when the summary is mostly unsupported.\n' +
            'Respond with ONLY JSON: {"categories":[{"category":string,"claims":string[],"summary":string|null,' +
            '"issues":string[],"confidencePenalty":number}]}',
          user: 'Categories to verify:\n' + JSON.stringify(payload),
        },
        (raw) => this.validateVerification(raw),
      );

      for (const c of result.data) {
        const original = summaries.find((s) => s.category === c.category);
        if (!original) continue;
        const issueNotes = c.issues.map((i) => `Verification: ${i}`);
        const existingConflicts = (() => {
          try {
            return JSON.parse(original.conflicts) as string[];
          } catch {
            return [];
          }
        })();
        await this.prisma.siteContextCategorySummary.update({
          where: { id: original.id },
          data: {
            facts: JSON.stringify(c.claims),
            summary: c.summary ?? original.summary,
            confidence: Math.max(0, original.confidence - c.confidencePenalty),
            conflicts: JSON.stringify([...existingConflicts, ...issueNotes]),
          },
        });
      }
      await this.addNote(run.id, `__cost__:${result.costUsd}:${result.model}`);
    } catch (err) {
      this.logger.warn(`Independent verification failed for run ${run.id}: ${(err as Error).message} — category summaries kept as consolidated, unverified.`);
    }
  }

  private validateVerification(raw: unknown): Array<{
    category: string; claims: string[]; summary: string | null; issues: string[]; confidencePenalty: number;
  }> {
    const obj = (raw ?? {}) as { categories?: unknown };
    if (!Array.isArray(obj.categories)) return [];
    const validCategories = new Set(Object.keys(CATEGORY_FIELDS));
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 30) : [];
    const out: Array<{ category: string; claims: string[]; summary: string | null; issues: string[]; confidencePenalty: number }> = [];
    for (const entry of obj.categories) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const category = typeof e.category === 'string' ? e.category : '';
      if (!validCategories.has(category)) continue;
      const penaltyRaw = typeof e.confidencePenalty === 'number' ? e.confidencePenalty : 0;
      out.push({
        category,
        claims: strArr(e.claims),
        summary: typeof e.summary === 'string' ? e.summary.trim().slice(0, 500) : null,
        issues: strArr(e.issues),
        confidencePenalty: Number.isFinite(penaltyRaw) ? Math.max(0, Math.min(1, penaltyRaw)) : 0,
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
