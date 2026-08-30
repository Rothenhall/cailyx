/**
 * Intake Service — Subject onboarding + auto-enrichment (PRD §6.1).
 *
 * Accepts a subject via: public form, operator console, bulk CSV, or API.
 * Enrichment steps (PRD FR-1.5):
 *   1. Fetch homepage with browser client, JS disabled (simulates AI crawler)
 *   2. Extract JSON-LD Organization/Person schema for company + descriptor
 *   3. Extract positioning copy via cheerio
 *   4. Extract named competitors from copy + outbound links
 *   5. Detect country from TLD and/or schema.address
 *   6. Create/attach Project via ProjectsService so downstream modules have a real entity
 *
 * Depends on: FetcherModule, ProjectsModule, DatabaseModule
 *
 * @module intake.service
 */

import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { FetcherService } from '../fetcher/fetcher.service';
import { ProjectsService } from '../projects/projects.service';
import { PrismaService } from '../database/prisma.service';
import type { IntakeRequest, EnrichmentResult, Competitor, BulkResult } from './intake.types';

const TLD_COUNTRY: Record<string, string> = {
  ie: 'Ireland', uk: 'United Kingdom', 'co.uk': 'United Kingdom', de: 'Germany',
  fr: 'France', in: 'India', us: 'United States', ca: 'Canada', au: 'Australia',
  nz: 'New Zealand', 'co.in': 'India', 'co.za': 'South Africa', es: 'Spain',
  it: 'Italy', nl: 'Netherlands', 'com.au': 'Australia', 'co.jp': 'Japan', ch: 'Switzerland',
};

/** hosts that a "Book a call" / "Docs" / social link points at — never a competitor */
const NON_COMPETITOR_HOSTS = new Set([
  'docs.google.com', 'drive.google.com', 'forms.gle', 'calendly.com', 'cal.com',
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'youtu.be', 'github.com', 'medium.com', 'substack.com',
  'notion.so', 'notion.site', 'typeform.com', 'hubspot.com', 'wa.me',
  'apps.apple.com', 'play.google.com', 'discord.gg', 'discord.com', 't.me',
]);
/** anchor text that is a call-to-action / nav label, not a brand name */
const GENERIC_ANCHOR =
  /^(let'?s talk|talk to (us|sales)|book (a )?(call|demo)|get (started|in touch)|contact( us)?|sign ?(in|up)|log ?in|request (a )?demo|learn more|read more|see more|our (work|team|blog)|careers?|privacy|terms|cookie|subscribe|download|home|about( us)?|pricing|support|help|faq|documentation|docs|api)\b/i;

const STRIP_TRAILING_PUNCT = /[.\s]+$/;
/** derive a short category / descriptor phrase, avoiding raw marketing headlines */
function deriveCategory(opts: {
  schemaType: string | null;
  title: string;
  brand: string | null;
  metaDescription: string;
}): string | null {
  const { schemaType, title, brand, metaDescription } = opts;
  const GENERIC_TYPES = new Set(['organization', 'website', 'webpage', 'thing', 'corporation', 'localbusiness']);
  if (schemaType) {
    const specific = schemaType
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter((t) => t && !GENERIC_TYPES.has(t.toLowerCase()));
    if (specific.length) {
      return specific
        .map((t) => t.replace(/([a-z])([A-Z])/g, '$1 $2'))
        .join(' / ')
        .toLowerCase();
    }
  }
  // "Brand | Descriptor" or "Descriptor — Brand" — take the non-brand segment
  const segs = title
    .split(/\s*[|–—·]\s*|\s+[-]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length >= 2 && brand) {
    const bl = brand.toLowerCase();
    const descriptor = segs.find(
      (s) => !s.toLowerCase().includes(bl) && s.split(/\s+/).length <= 6 && !STRIP_TRAILING_PUNCT.test(s),
    );
    if (descriptor) return descriptor.toLowerCase();
  }
  // first clause of the meta description, capped at ~9 words
  if (metaDescription) {
    const clause = metaDescription.split(/[.;—]|\s-\s/)[0].trim();
    const words = clause.split(/\s+/);
    if (words.length >= 2 && words.length <= 12) return clause.toLowerCase();
  }
  return null;
}

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly fetcher: FetcherService,
    private readonly projects: ProjectsService,
    private readonly prisma: PrismaService,
  ) {}

  async intakeSubject(req: IntakeRequest): Promise<EnrichmentResult & { projectId: string; created: boolean }> {
    const domain = this.normalizeDomain(req.domain);
    this.logger.log('Intake for: ' + domain + ' (source: ' + (req.source || 'api') + ')');

    const runId = 'intake_' + Date.now();
    const existing = await this.prisma.project.findUnique({ where: { domain } });
    const created = !existing;

    const homepage = await this.fetcher.render(
      { url: 'https://' + domain + '/', jsDisabled: false, timeout: 30000 },
      'intake',
      runId,
    );

    const html = homepage.html || '';
    const $ = cheerio.load(html);

    const clean = (v: unknown): string | null => {
      if (v == null) return null;
      const s = String(v).trim();
      return s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'undefined' ? s : null;
    };

    let company = clean(req.company);
    let description = clean(req.description);
    let schemaType: string | null = null;
    let country: string | null = null;

    try {
      const schemaResult = await this.fetcher.fetchSchema('https://' + domain + '/', 'intake', runId);
      const schemas = schemaResult.schemas || [];
      const org = schemas.find((s: any) =>
        ['Organization', 'LocalBusiness', 'Person'].some((t) => String(s.type).includes(t)),
      ) as any;

      if (org) {
        company = company || clean(org.fields['name']);
        description = description || clean(org.fields['description']);
        if (org.fields['@type']) schemaType = String(org.fields['@type']);
        const addr = org.fields['address'] as any;
        const addrCountry = addr && typeof addr === 'object' ? addr['addressCountry'] : null;
        if (typeof addrCountry === 'string') country = addrCountry;
      }
    } catch {
      // Non-fatal
    }

    // brand name: schema/req → og:site_name → the shorter title segment → domain
    const pageTitle = ($('title').first().text() || '').trim();
    const ogSite = clean($('meta[property="og:site_name"]').attr('content'));
    if (!company && ogSite) company = ogSite;
    if (!company && pageTitle) {
      const segs = pageTitle.split(/\s*[|–—·]\s*|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
      if (segs.length >= 2) company = segs.slice().sort((a, b) => a.length - b.length)[0];
    }

    const metaDescription = $('meta[name="description"]').attr('content')
      || $('meta[property="og:description"]').attr('content')
      || '';
    if (!description && metaDescription) description = metaDescription;

    const category = deriveCategory({ schemaType, title: pageTitle, brand: company, metaDescription });

    if (!country) {
      const parts = domain.split('.');
      const tld = parts.length > 2 ? parts.slice(-2).join('.') : parts[parts.length - 1];
      country = TLD_COUNTRY[tld] || TLD_COUNTRY[parts[parts.length - 1]] || null;
    }

    const competitors = this.extractCompetitors($, company, domain);
    const ownEntities = this.extractOwnEntities($, company);

    // last-resort brand: "day1tech.com" → "Day1tech"
    const brand = company || domain.split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

    let projectId: string;
    if (created) {
      const proj = await this.projects.create({
        name: brand,
        domain,
        category: category || undefined,
        clientName: brand,
        notes: req.notes || undefined,
        status: 'diagnostic',
      });
      projectId = proj.id;
    } else {
      projectId = existing!.id;
    }

    // Persist extracted competitors on the project — share-of-voice (PRD FR-7)
    // and measurement compare the subject against these named players.
    if (competitors.length > 0) {
      await this.projects.updateCompetitors(projectId, competitors);
    }

    return {
      domain,
      company,
      category,
      description,
      country,
      competitors,
      ownEntities,
      pagesFetched: html ? 1 : 0,
      enrichmentSource: html ? 'homepage' : 'search',
      projectId,
      created,
    };
  }

  private extractCompetitors($: cheerio.CheerioAPI, company: string | null, subjectDomain?: string): Competitor[] {
    const seen = new Set<string>();
    const out: Competitor[] = [];
    const companyLower = (company || '').toLowerCase();
    const rootOf = (h: string) => h.replace(/^www\./, '').split('.').slice(-2).join('.');
    const subjectRoot = subjectDomain ? rootOf(subjectDomain) : '';

    $('a[href^="http"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      try {
        const u = new URL(href);
        const host = u.hostname.replace(/^www\./, '');
        if (!host || seen.has(host)) return;
        seen.add(host);
        if (rootOf(host) === subjectRoot) return; // own subdomain / asset host
        if (NON_COMPETITOR_HOSTS.has(host) || NON_COMPETITOR_HOSTS.has(rootOf(host))) return;
        if (!text || text.length < 2 || text.length > 40) return;
        if (GENERIC_ANCHOR.test(text)) return; // "Let's talk", "Careers", …
        if (/\s(us|now|today|more|here)$/i.test(text)) return; // verb-phrase CTAs
        if (company && text.toLowerCase().includes(companyLower)) return;
        out.push({ name: text, domain: host, source: 'homepage-copy' });
      } catch { /* skip bad href */ }
    });

    return out.slice(0, 20);
  }

  private extractOwnEntities($: cheerio.CheerioAPI, company: string | null): string[] {
    const entities = new Set<string>();
    const companyLower = (company || '').toLowerCase();
    $('nav a, h2, h3').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 2 && text.length < 80 && (company ? !text.toLowerCase().includes(companyLower) : true) && !/^(home|about|contact|blog|login|sign)/i.test(text)) {
        entities.add(text);
      }
    });
    return Array.from(entities).slice(0, 15);
  }

  async intakeBulk(items: Array<{ domain: string; company?: string }>, source: string = 'bulk-csv'): Promise<BulkResult> {
    const result: BulkResult = { submitted: items.length, created: 0, skipped: [], enriched: [] };

    for (const item of items) {
      try {
        const enriched = await this.intakeSubject({ ...item, source: 'bulk-csv' as const });
        if (enriched.created) result.created++;
        result.enriched.push({
          domain: enriched.domain,
          company: enriched.company,
          category: enriched.category,
          description: enriched.description,
          country: enriched.country,
          competitors: enriched.competitors,
          ownEntities: enriched.ownEntities,
          pagesFetched: enriched.pagesFetched,
          enrichmentSource: enriched.enrichmentSource,
        });
      } catch (err) {
        result.skipped.push({ domain: item.domain, reason: (err as Error).message.substring(0, 80) });
      }
    }

    return result;
  }

  private normalizeDomain(domain: string): string {
    return domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
  }

  async count(): Promise<{ count: number }> {
    const count = await this.prisma.project.count();
    return { count };
  }
}