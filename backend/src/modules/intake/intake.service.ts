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

    let company = req.company || null;
    let description = req.description || null;
    let category: string | null = null;
    let country: string | null = null;

    try {
      const schemaResult = await this.fetcher.fetchSchema('https://' + domain + '/', 'intake', runId);
      const schemas = schemaResult.schemas || [];
      const org = schemas.find((s: any) =>
        ['Organization', 'LocalBusiness', 'Person'].some((t) => String(s.type).includes(t)),
      ) as any;

      if (org) {
        company = company || String(org.fields['name'] || null);
        description = description || String(org.fields['description'] || '') || null;
        if (org.fields['@type']) category = String(org.fields['@type']);
        const addr = org.fields['address'] as any;
        const addrCountry = addr && typeof addr === 'object' ? addr['addressCountry'] : null;
        if (typeof addrCountry === 'string') country = addrCountry;
      }
    } catch {
      // Non-fatal
    }

    const metaDescription = $('meta[name="description"]').attr('content')
      || $('meta[property="og:description"]').attr('content')
      || '';
    if (!description && metaDescription) description = metaDescription;
    if (!category) {
      const h1 = $('h1').first().text().trim();
      if (h1) category = h1;
    }

    if (!country) {
      const parts = domain.split('.');
      const tld = parts.length > 2 ? parts.slice(-2).join('.') : parts[parts.length - 1];
      country = TLD_COUNTRY[tld] || TLD_COUNTRY[parts[parts.length - 1]] || null;
    }

    const competitors = this.extractCompetitors($, company);
    const ownEntities = this.extractOwnEntities($, company);

    let projectId: string;
    if (created) {
      const proj = await this.projects.create({
        name: company || domain,
        domain,
        category: category || 'General',
        clientName: (company || domain) || undefined,
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

  private extractCompetitors($: cheerio.CheerioAPI, company: string | null): Competitor[] {
    const seen = new Set<string>();
    const out: Competitor[] = [];
    const companyLower = (company || '').toLowerCase();

    $('a[href^="http"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      try {
        const u = new URL(href);
        if (u.hostname && !seen.has(u.hostname)) {
          seen.add(u.hostname);
          if (text && text.length < 60 && !(company && text.toLowerCase().includes(companyLower))) {
            out.push({ name: text || u.hostname, domain: u.hostname, source: 'homepage-copy' });
          }
        }
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