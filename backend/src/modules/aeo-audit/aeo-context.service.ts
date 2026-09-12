/**
 * AEO Site-Context Service — reads what the client actually does off their own site.
 *
 * `intake` already enriches a domain from its homepage (brand, category,
 * description, country, competitors). That is too thin to build a prompt matrix
 * from: a matrix needs the **services sold**, **who buys them**, the **pains**
 * buyers arrive with and the **outcomes** they want. So this walks a handful of
 * the site's own high-signal pages and extracts those.
 *
 * Two layers, in order (D2, `docs/analysis/aeo-audit.md`):
 *   1. **Deterministic** — `FetcherService` + cheerio over homepage +
 *      sitemap-guided page picks. Always runs. Auditable, free, no key needed.
 *   2. **LLM synthesis** — one constrained-JSON pass that *organises what layer
 *      one already fetched* into services / ICP / pains / outcomes. Optional:
 *      with no LLM provider configured the deterministic extraction stands on its
 *      own and `extraction` is recorded as `deterministic`, so provenance is honest.
 *
 * The LLM is never given free rein to invent: its input is page text that was
 * really fetched, and its instruction is to return `[]` rather than guess.
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

/** Cap on characters of page text handed to the synthesis pass. */
const MAX_SYNTHESIS_CHARS = 24_000;

/** Shape the synthesis model must return. */
interface SynthesisResult {
  category: string | null;
  vertical: string | null;
  services: string[];
  icp: string[];
  valueProps: string[];
  painPoints: string[];
  outcomes: string[];
  /** Service areas the copy names, ranked, ISO-3166 alpha-2 codes (wave-6 D8). */
  markets: string[];
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

  /**
   * Build and persist a fresh {@link SiteContextData} for a project.
   *
   * @param projectId Project to build context for.
   * @param opts.maxPages Page ceiling (default `AEO_CONTEXT_MAX_PAGES`, 12).
   * @param opts.refine Run the LLM synthesis pass (default true; silently
   *   downgrades to deterministic-only when no API key is configured).
   * @returns The persisted context row id plus the extracted data.
   * @throws NotFoundException when the project does not exist.
   */
  async build(
    projectId: string,
    opts: { maxPages?: number; refine?: boolean } = {},
  ): Promise<SiteContextData & { id: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const maxPages = opts.maxPages ?? Number(this.config.get<string>('AEO_CONTEXT_MAX_PAGES', '12'));
    const domain = this.normalizeDomain(project.domain);
    const runId = 'aeo_ctx_' + Date.now();

    const pages = await this.crawl(domain, maxPages, runId);
    if (pages.length === 0) {
      this.logger.warn('No pages fetched for ' + domain + ' — context will be metadata-only');
    }

    // Layer 1 — deterministic.
    let data = this.extractDeterministic(project, domain, pages);

    // Layer 2 — optional synthesis over the same fetched text.
    if (opts.refine !== false && this.llm.isAvailable()) {
      try {
        const synth = await this.synthesize(data, pages);
        data = {
          ...data,
          category: synth.result.category ?? data.category,
          vertical: synth.result.vertical ?? data.vertical,
          services: this.preferSynthesis(synth.result.services, data.services),
          icp: this.preferSynthesis(synth.result.icp, data.icp),
          valueProps: this.preferSynthesis(synth.result.valueProps, data.valueProps),
          painPoints: this.preferSynthesis(synth.result.painPoints, data.painPoints),
          outcomes: this.preferSynthesis(synth.result.outcomes, data.outcomes),
          markets: this.preferSynthesis(synth.result.markets, data.markets),
          extraction: 'llm-synthesized',
          llmModel: synth.model,
          costUsd: synth.costUsd,
        };
      } catch (err) {
        // A failed synthesis must not lose the deterministic result.
        this.logger.warn('Context synthesis failed, keeping deterministic extraction: ' + (err as Error).message);
      }
    }

    const row = await this.prisma.siteContext.create({
      data: {
        projectId,
        domain: data.domain,
        brand: data.brand,
        category: data.category,
        vertical: data.vertical,
        description: data.description,
        geo: data.geo,
        markets: JSON.stringify(data.markets),
        services: JSON.stringify(data.services),
        icp: JSON.stringify(data.icp),
        valueProps: JSON.stringify(data.valueProps),
        painPoints: JSON.stringify(data.painPoints),
        outcomes: JSON.stringify(data.outcomes),
        competitors: JSON.stringify(data.competitors),
        pagesFetched: data.pagesFetched,
        pageUrls: JSON.stringify(data.pageUrls),
        extraction: data.extraction,
        llmModel: data.llmModel,
        costUsd: data.costUsd,
      },
    });

    this.logger.log(
      'Context built for ' + domain + ': ' + data.services.length + ' services, ' +
        data.icp.length + ' ICP segments, ' + data.pagesFetched + ' pages (' + data.extraction + ')',
    );

    return { ...data, id: row.id };
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

  // ─── Crawl ──────────────────────────────────────────────────────────────

  /**
   * Homepage first, then sitemap-guided high-signal pages, then guessed paths.
   * Client's own host only — never follows off-site links.
   */
  private async crawl(
    domain: string,
    maxPages: number,
    runId: string,
  ): Promise<Array<{ url: string; html: string; text: string; title: string }>> {
    const origin = 'https://' + domain;
    const out: Array<{ url: string; html: string; text: string; title: string }> = [];
    const seen = new Set<string>();
    // Content fingerprints of pages already kept. Single-page apps and catch-all
    // routers answer /services, /pricing and /about with the identical document;
    // counting those as separate pages would inflate `pagesFetched` and weight
    // the same headings several times over.
    const fingerprints = new Set<string>();

    const visit = async (url: string): Promise<void> => {
      const key = url.replace(/\/$/, '').toLowerCase();
      if (seen.has(key) || out.length >= maxPages) return;
      seen.add(key);
      try {
        const res = await this.fetcher.render({ url, jsDisabled: false, timeout: 30000 }, 'aeo-context', runId);
        if (!res.html) return;
        const fingerprint = this.fingerprint(res.text || res.html);
        if (fingerprints.has(fingerprint)) {
          this.logger.debug('Context skipped ' + url + ': same content as a page already read');
          return;
        }
        fingerprints.add(fingerprint);
        out.push({ url, html: res.html, text: res.text || '', title: res.title || '' });
      } catch (err) {
        this.logger.debug('Context fetch skipped ' + url + ': ' + (err as Error).message);
      }
    };

    await visit(origin + '/');

    // Prefer real URLs from the sitemap over guessed paths.
    const fromSitemap = await this.sitemapCandidates(origin, runId);
    for (const url of fromSitemap) {
      if (out.length >= maxPages) break;
      await visit(url);
    }

    // Fall back to conventional paths, plus anything the homepage nav links to.
    if (out.length < maxPages) {
      const navLinks = out[0] ? this.internalNavLinks(out[0].html, origin) : [];
      const guesses = [...HIGH_SIGNAL_PATHS.map((p) => origin + p), ...navLinks];
      for (const url of guesses) {
        if (out.length >= maxPages) break;
        await visit(url);
      }
    }

    return out;
  }

  /** Pull high-signal URLs out of the sitemap (index-aware, one level deep). */
  private async sitemapCandidates(origin: string, runId: string): Promise<string[]> {
    const urls: string[] = [];
    const readSitemap = async (url: string): Promise<string[]> => {
      try {
        const res = await this.fetcher.fetch({ url, timeout: 20000 }, 'aeo-context', runId);
        if (res.status !== 200 || !res.body) return [];
        return [...res.body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
      } catch {
        return [];
      }
    };

    const top = await readSitemap(origin + '/sitemap.xml');
    const nested = top.filter((u) => /\.xml(\.gz)?$/i.test(u)).slice(0, 3);
    const flat = top.filter((u) => !/\.xml(\.gz)?$/i.test(u));
    for (const child of nested) {
      flat.push(...(await readSitemap(child)).filter((u) => !/\.xml(\.gz)?$/i.test(u)));
    }

    for (const u of flat) {
      if (!u.startsWith(origin)) continue; // own host only
      if (HIGH_SIGNAL_PATTERNS.test(u)) urls.push(u);
    }
    // Shallow pages first — /services beats /services/a/b/c for offer language.
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
      if (HIGH_SIGNAL_PATTERNS.test(abs)) out.push(abs);
    });
    return out.slice(0, 10);
  }

  // ─── Layer 1: deterministic extraction ─────────────────────────────────

  /**
   * Structure whatever was fetched without any model in the loop: headings and
   * card titles become candidate services, `<title>`/meta become the descriptor,
   * and the project's stored competitors carry through.
   */
  private extractDeterministic(
    project: { name: string; domain: string; category: string | null; competitors: string | null },
    domain: string,
    pages: Array<{ url: string; html: string; text: string; title: string }>,
  ): SiteContextData {
    const home = pages[0];
    const $home = home ? cheerio.load(home.html) : null;

    const description =
      ($home?.('meta[name="description"]').attr('content') ||
        $home?.('meta[property="og:description"]').attr('content') ||
        '')?.trim() || null;

    const services = new Set<string>();
    const valueProps = new Set<string>();

    for (const page of pages) {
      const $ = cheerio.load(page.html);
      const offerPage = HIGH_SIGNAL_PATTERNS.test(page.url) || page === home;

      // Headings inside team / author / testimonial blocks are people's names
      // and quotes, not offerings — dropping them here is far more reliable than
      // trying to recognise a personal name by its shape further downstream.
      const inPersonBlock = (node: ReturnType<typeof $>): boolean =>
        node.closest(
          '[class*="team"],[class*="person"],[class*="people"],[class*="author"],[class*="bio"],' +
            '[class*="staff"],[class*="member"],[class*="founder"],[class*="testimonial"],[class*="quote"],' +
            '[class*="logo"],footer,nav',
        ).length > 0;

      $('h2, h3').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (!this.isCandidatePhrase(text) || inPersonBlock($(el))) return;
        if (offerPage && services.size < 40) services.add(text);
      });
      // Card/tile titles are where service names usually live on modern sites.
      $('[class*="card"] h4, [class*="service"] h4, [class*="tile"] h4, li > strong').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (this.isCandidatePhrase(text) && !inPersonBlock($(el)) && services.size < 40) services.add(text);
      });
      $('h1, [class*="hero"] p').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text.length > 15 && text.length < 160 && valueProps.size < 10) valueProps.add(text);
      });
    }

    const geoGuess = this.geoFromDomain(domain);

    return {
      domain,
      brand: project.name,
      category: project.category,
      vertical: null, // only the synthesis pass can tell "sells into X" from "is an X"
      description,
      geo: geoGuess,
      markets: [], // needs synthesis — nothing deterministic identifies a service area
      services: [...services].slice(0, 25),
      icp: [], // needs synthesis — nothing deterministic identifies a buyer segment
      valueProps: [...valueProps].slice(0, 8),
      painPoints: [],
      outcomes: [],
      competitors: this.parseCompetitors(project.competitors),
      pagesFetched: pages.length,
      pageUrls: pages.map((p) => p.url),
      extraction: 'deterministic',
      llmModel: null,
      costUsd: 0,
    };
  }

  /**
   * Is this heading plausibly an offer name rather than nav chrome or a
   * marketing sentence?
   *
   * Service names are short noun phrases ("Revenue Operations", "Fractional
   * CMO"). Hero copy is sentences ("But buyers no longer search. They ask.").
   * Feeding the latter into the matrix would produce prompts no buyer would
   * ever type, so sentence-shaped headings are rejected here.
   */
  private isCandidatePhrase(text: string): boolean {
    if (text.length < 3 || text.length > 70) return false;
    if (NAV_NOISE.test(text)) return false;
    if (/^\d+[%+]?$/.test(text)) return false; // stat tiles
    if (/[?!]$/.test(text)) return false; // FAQ questions, exclamations
    if (/[.]$/.test(text)) return false; // full sentences end in a period
    if (!/[a-z]/i.test(text)) return false;

    const words = text.split(/\s+/);
    if (words.length > 6) return false; // offers are named, not narrated

    // A bare word is almost always a plan tier or a process step, not an
    // offering. Real service names are compounds: "Revenue Operations",
    // "Fixed-fee Sprints". This is the single highest-yield filter here.
    if (words.length < 2) return false;
    if (words.every((w) => TIER_AND_STEP_WORDS.test(w))) return false;

    // Leading conjunction/pronoun/article = a clause, not a name.
    if (/^(and|but|or|so|because|if|when|we|they|you|it|our|your|their|this|that|these|those|every|a|an|the)\b/i.test(text)) {
      return false;
    }
    // A finite verb mid-phrase means it is a sentence fragment, not a label.
    if (/\b(is|are|was|were|has|have|had|does|do|did|can|will|would|should|could|make|makes|owns?|started|created|solved?)\b/i.test(text)) {
      return false;
    }
    return true;
  }

  // ─── Layer 2: constrained synthesis ────────────────────────────────────

  /**
   * One constrained-JSON pass that organises the fetched page text into the
   * fields the matrix needs. Grounded: the model sees only real page text and is
   * told to return an empty array rather than guess.
   */
  private async synthesize(
    base: SiteContextData,
    pages: Array<{ url: string; text: string; title: string }>,
  ): Promise<{ result: SynthesisResult; model: string; costUsd: number }> {
    let corpus = '';
    for (const page of pages) {
      const chunk =
        '\n\n--- ' + page.url + ' ---\n' +
        (page.title ? page.title + '\n' : '') +
        page.text.replace(/\s+/g, ' ').trim();
      if (corpus.length + chunk.length > MAX_SYNTHESIS_CHARS) break;
      corpus += chunk;
    }

    const result = await this.llm.json(
      {
        purpose: 'site context synthesis',
        maxTokens: 2000,
        system:
          'You read a company website and describe, factually, what the company sells and who buys it. ' +
          'You are building the inputs for a search-visibility audit, so accuracy matters more than completeness.\n' +
          'Rules:\n' +
          '- Use ONLY what the page text states. Never infer a service, client type or market that is not there.\n' +
          '- If a field is not supported by the text, return an empty array (or null). An empty array is a correct answer.\n' +
          "- services: the concrete offerings a buyer can pay for, in the site's own words, 2-6 words each. " +
          'Exclude pricing tiers ("Starter", "Enterprise"), process steps ("Diagnose", "Build"), ' +
          "company values (\"One accountable owner\") and people's names — none of those are things a buyer searches for.\n" +
          '- icp: who buys — role, company type, or segment (e.g. "mid-market logistics operators").\n' +
          '- vertical: the industry the company sells INTO, null if it sells across industries.\n' +
          '- category: what the company IS, 2-5 words, lowercase (e.g. "b2b logistics software").\n' +
          '- painPoints: problems the copy says buyers have, phrased as the buyer would say them.\n' +
          '- outcomes: results buyers get, phrased as the buyer would want them.\n' +
          '- markets: geographic markets the company SERVES (not where it is headquartered, unless the copy ' +
          'also says it serves that market), as ISO-3166 alpha-2 country codes, ranked by how prominently the ' +
          'site names each. Empty array if the site does not name specific markets it serves.\n' +
          'Respond with ONLY JSON matching: ' +
          '{"category":string|null,"vertical":string|null,"services":string[],"icp":string[],' +
          '"valueProps":string[],"painPoints":string[],"outcomes":string[],"markets":string[]}',
        user:
          'Company: ' + base.brand + ' (' + base.domain + ')\n' +
          'Headings already extracted (may be noisy): ' +
          (base.services.slice(0, 20).join(' | ') || 'none') + '\n' +
          '\nPage text follows.\n' + corpus,
      },
      (raw) => this.validateSynthesis(raw),
    );

    return { result: result.data, model: result.model, costUsd: result.costUsd };
  }

  /** Coerce the model's JSON into {@link SynthesisResult}; drop anything odd. */
  private validateSynthesis(raw: unknown): SynthesisResult {
    const obj = (raw ?? {}) as Record<string, unknown>;
    const strArr = (v: unknown, cap: number): string[] =>
      Array.isArray(v)
        ? v
            .filter((x): x is string => typeof x === 'string')
            .map((s) => s.trim())
            .filter((s) => s.length > 1 && s.length <= 120)
            .slice(0, cap)
        : [];
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 && v.trim().toLowerCase() !== 'null' ? v.trim() : null;
    // Markets must be real ISO-3166 alpha-2 codes, not free text — a
    // hallucinated "France" would silently become an invalid Cloro `country`
    // param three layers downstream, so it's dropped here instead, ranked,
    // deduped, capped at 5 (D8: a ranked suggestion, not a full list).
    const codeArr = (v: unknown, cap: number): string[] => {
      if (!Array.isArray(v)) return [];
      const seen = new Set<string>();
      const out: string[] = [];
      for (const x of v) {
        if (typeof x !== 'string') continue;
        const code = x.trim().toUpperCase();
        if (!/^[A-Z]{2}$/.test(code) || seen.has(code)) continue;
        seen.add(code);
        out.push(code);
        if (out.length >= cap) break;
      }
      return out;
    };

    return {
      category: str(obj.category),
      vertical: str(obj.vertical),
      services: strArr(obj.services, 25),
      icp: strArr(obj.icp, 10),
      valueProps: strArr(obj.valueProps, 10),
      painPoints: strArr(obj.painPoints, 12),
      outcomes: strArr(obj.outcomes, 12),
      markets: codeArr(obj.markets, 5),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Row → typed data, parsing the JSON string columns. */
  private rowToData(row: {
    id: string;
    createdAt: Date;
    domain: string;
    brand: string;
    category: string | null;
    vertical: string | null;
    description: string | null;
    geo: string | null;
    markets: string;
    services: string;
    icp: string;
    valueProps: string;
    painPoints: string;
    outcomes: string;
    competitors: string;
    pagesFetched: number;
    pageUrls: string;
    extraction: string;
    llmModel: string | null;
    costUsd: number;
  }): SiteContextData & { id: string; createdAt: Date } {
    const arr = (v: string): string[] => {
      try {
        const p: unknown = JSON.parse(v);
        return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    };
    return {
      id: row.id,
      createdAt: row.createdAt,
      domain: row.domain,
      brand: row.brand,
      category: row.category,
      vertical: row.vertical,
      description: row.description,
      geo: row.geo,
      markets: arr(row.markets),
      services: arr(row.services),
      icp: arr(row.icp),
      valueProps: arr(row.valueProps),
      painPoints: arr(row.painPoints),
      outcomes: arr(row.outcomes),
      competitors: this.parseCompetitors(row.competitors),
      pagesFetched: row.pagesFetched,
      pageUrls: arr(row.pageUrls),
      extraction: row.extraction === 'llm-synthesized' ? 'llm-synthesized' : 'deterministic',
      llmModel: row.llmModel,
      costUsd: row.costUsd,
    };
  }

  /**
   * A successful synthesis **replaces** the deterministic list for that field;
   * the deterministic list is only used for a field the model left empty.
   *
   * Unioning the two was wrong: the deterministic layer is heading-based and
   * cannot tell an offering from a company value or a founder's name, and the
   * synthesis prompt explicitly asks the model to drop exactly those. Merging
   * put them straight back — a real audit produced `services` containing
   * "One accountable owner" and a person's name alongside the genuine offerings,
   * and every junk entry becomes prompts like "companies that do <person>".
   * The model's filtered list is the answer; the raw headings were only ever a
   * seed for it.
   */
  private preferSynthesis(synthesized: string[], deterministic: string[]): string[] {
    const source = synthesized.length > 0 ? synthesized : deterministic;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of source) {
      const key = v.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(v.trim());
    }
    return out;
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
          out.push({
            name: (entry as { name: string }).name,
            domain: ((entry as { domain?: unknown }).domain as string | undefined) ?? null,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Country from ccTLD, as an ISO-3166 alpha-2 code — a weak but free geo
   * signal; the `markets[]` synthesis (real copy, not a domain suffix) wins
   * when it says something, per wave-6 D8's precedence.
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
   * document under many paths. Normalised whitespace, first 4k characters —
   * enough to separate genuinely different pages without hashing whole documents.
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
