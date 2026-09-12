/**
 * Tech Stack Service — deterministic technology-fingerprinting over a single
 * fetched page (decision D3, `docs/analysis/wave-6-audit-pipeline.md`).
 *
 * Runs synchronously: this is pure text/header matching against data
 * `FetcherService` already returns, no headless render, so a run is typically
 * sub-second and does not need the background pipeline queue.
 *
 * @module tech-stack.service
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { PrismaService } from '../database/prisma.service';
import { FetcherService } from '../fetcher/fetcher.service';
import { TECH_SIGNATURES, type TechCategory } from './tech-stack.signatures';

export interface TechStackFindingResult {
  category: TechCategory;
  name: string;
  confidence: number;
  evidence: string[];
}

export interface TechStackScanResult {
  id: string;
  projectId: string;
  domain: string;
  status: 'completed' | 'failed';
  error: string | null;
  createdAt: Date;
  findings: TechStackFindingResult[];
}

/** Evidence snippets are truncated so a giant inline script never bloats the row. */
const EVIDENCE_MAX_LEN = 200;

@Injectable()
export class TechStackService {
  private readonly logger = new Logger(TechStackService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fetcher: FetcherService,
  ) {}

  /**
   * Resolve which domain to scan: an explicit override, else the project's
   * own domain. Throws if the project does not exist.
   */
  private async resolveDomain(projectId: string, domainOverride?: string): Promise<string> {
    if (domainOverride) return domainOverride.trim();

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { domain: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project.domain.trim();
  }

  /**
   * Fetch the domain's homepage, match it against every signature, and
   * persist the result. A fetch failure (blocked, DNS, timeout, non-2xx) is
   * stored as `status: 'failed'` with `error` set, not thrown — an
   * unreachable/blocked site is a reportable outcome, the same discipline
   * `AeoSurfaceRun` and `digital-presence` use for their own failure paths.
   */
  async scanDomain(projectId: string, domainOverride?: string): Promise<TechStackScanResult> {
    const domain = await this.resolveDomain(projectId, domainOverride);
    const url = /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;

    let findings: TechStackFindingResult[] = [];
    let error: string | null = null;

    try {
      const res = await this.fetcher.fetch({ url, cacheTtlSeconds: 3600 }, 'tech-stack');
      if (res.status === 0 || res.status >= 400) {
        error = `Fetch failed: HTTP ${res.status} ${res.statusText}`.trim();
      } else {
        findings = this.detect(res.headers, res.body);
      }
    } catch (err) {
      error = (err as Error).message;
    }

    const status: 'completed' | 'failed' = error ? 'failed' : 'completed';
    if (error) {
      this.logger.warn(`Tech-stack scan failed for ${domain}: ${error}`);
    }

    const scan = await this.prisma.techStackScan.create({
      data: {
        projectId,
        domain,
        status,
        error,
        findings: {
          create: findings.map((f) => ({
            category: f.category,
            name: f.name,
            confidence: f.confidence,
            evidence: JSON.stringify(f.evidence),
          })),
        },
      },
      include: { findings: true },
    });

    return this.toResult(scan);
  }

  /** Latest stored scan for the resolved domain, or null if none exists yet. */
  async getLatest(projectId: string, domainOverride?: string): Promise<TechStackScanResult | null> {
    const domain = await this.resolveDomain(projectId, domainOverride);

    const scan = await this.prisma.techStackScan.findFirst({
      where: { projectId, domain },
      orderBy: { createdAt: 'desc' },
      include: { findings: true },
    });
    return scan ? this.toResult(scan) : null;
  }

  /**
   * Run every signature against the four extracted signals. `headers` is
   * tested against every header VALUE (not one named key) since the vendor
   * that sets an identifying header — `server`, `via`, `x-powered-by`,
   * `cf-ray`, `x-amz-cf-id` — varies by CDN.
   */
  private detect(headers: Record<string, string>, html: string): TechStackFindingResult[] {
    const $ = cheerio.load(html);
    const headerValues = Object.values(headers);
    const scriptSrcs = $('script[src]')
      .map((_, el) => $(el).attr('src') || '')
      .get()
      .join('\n');
    const generator = $('meta[name="generator"]').attr('content') || '';

    const found: TechStackFindingResult[] = [];

    for (const sig of TECH_SIGNATURES) {
      const evidence: string[] = [];

      if (sig.headers) {
        for (const re of sig.headers) {
          const match = headerValues.find((v) => re.test(v));
          if (match) evidence.push(match.slice(0, EVIDENCE_MAX_LEN));
        }
      }
      if (sig.scriptSrc) {
        const match = scriptSrcs.match(sig.scriptSrc);
        if (match) evidence.push(match[0].slice(0, EVIDENCE_MAX_LEN));
      }
      if (sig.generator && generator) {
        const match = generator.match(sig.generator);
        if (match) evidence.push(generator.slice(0, EVIDENCE_MAX_LEN));
      }
      if (sig.html) {
        const match = html.match(sig.html);
        if (match) evidence.push(match[0].slice(0, EVIDENCE_MAX_LEN));
      }

      if (evidence.length > 0) {
        found.push({ category: sig.category, name: sig.name, confidence: 1, evidence });
      }
    }

    return found;
  }

  private toResult(scan: {
    id: string;
    projectId: string;
    domain: string;
    status: string;
    error: string | null;
    createdAt: Date;
    findings: { category: string; name: string; confidence: number; evidence: string }[];
  }): TechStackScanResult {
    return {
      id: scan.id,
      projectId: scan.projectId,
      domain: scan.domain,
      status: scan.status as 'completed' | 'failed',
      error: scan.error,
      createdAt: scan.createdAt,
      findings: scan.findings.map((f) => ({
        category: f.category as TechCategory,
        name: f.name,
        confidence: f.confidence,
        evidence: JSON.parse(f.evidence) as string[],
      })),
    };
  }
}
