/**
 * Authority Service — discover legitimate mention/link opportunities (Agent #6).
 *
 * Discovery methods (combinable):
 *   - `serp`      — pull "best <category>" / listicle SERPs (via the gated
 *                   serp-intelligence provider) and keep the ranking domains
 *                   that aren't the client or a direct competitor.
 *   - `citations` — domains that AI answers already cite in this project's
 *                   journeys / measurement runs.
 *   - `llm`       — ask Claude for publications/communities/podcasts in the
 *                   category (gated on ANTHROPIC_API_KEY).
 *
 * Promotion turns a chosen candidate into a `mention-tracking` MentionTarget —
 * a to-do for a human. Nothing here contacts anyone or creates accounts.
 *
 * @module authority.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../database/prisma.service';
import { SerpIntelligenceService } from '../serp-intelligence/serp-intelligence.service';
import { MentionTrackingService } from '../mention-tracking/mention-tracking.service';
import { parseCompetitors, hostOf } from '../../common/utils/subject-match';
import { candidatesFromCitations, candidatesFromSerp, classify, mergeCandidates } from './authority.discovery';
import { AUTHORITY_LIMITS, CANDIDATE_TO_TARGET_TYPE } from './authority.types';
import type { AuthorityCandidateType, AuthorityMethod, RunScanInput, WorkingCandidate } from './authority.types';
import type { ExcludeSet } from './authority.discovery';

@Injectable()
export class AuthorityService {
  private readonly logger = new Logger(AuthorityService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly serp: SerpIntelligenceService,
    private readonly mentions: MentionTrackingService,
  ) {}

  async run(projectId: string, input: RunScanInput) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const method: AuthorityMethod = input.method ?? 'combined';
    const useLlm = input.useLlm === true || method === 'llm';
    if (useLlm && !this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY not configured — authority LLM discovery unavailable (use method=serp or citations)',
      );
    }

    const category = (input.category?.trim() || project.category?.trim() || 'this category').slice(0, 120);
    const listicleQueries = this.resolveQueries(input.listicleQueries, category);
    const ex: ExcludeSet = {
      subjectHost: (project.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase(),
      competitorHosts: parseCompetitors(project.competitors)
        .map((c) => (c.domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase())
        .filter(Boolean),
    };

    const scan = await this.prisma.authorityScan.create({
      data: {
        projectId,
        category,
        method,
        status: 'running',
        listicleQueries: JSON.stringify(listicleQueries),
      },
    });

    try {
      const lists: WorkingCandidate[][] = [];
      let cost = 0;
      let anyFailure = false;
      let model: string | null = null;

      if (method === 'serp' || method === 'combined') {
        for (const kw of listicleQueries) {
          try {
            const resp = await this.serp.serpForDiscovery(kw, {
              locationName: 'United States',
              languageCode: 'en',
              device: 'desktop',
            });
            cost += resp.costUsd;
            lists.push(candidatesFromSerp(kw, resp.items, category, ex));
          } catch (err) {
            anyFailure = true;
            this.logger.warn(`authority serp "${kw}" failed: ${(err as Error).message}`);
          }
        }
      }

      if (method === 'citations' || method === 'combined') {
        lists.push(await this.citationCandidates(projectId, category, ex));
      }

      if (useLlm) {
        const llm = await this.llmCandidates(category, ex);
        lists.push(llm.candidates);
        model = llm.model;
      }

      const merged = mergeCandidates(lists);

      for (const c of merged) {
        await this.prisma.authorityCandidate.create({
          data: {
            scanId: scan.id,
            projectId,
            domain: c.domain,
            url: c.url,
            title: c.title,
            type: c.type,
            discoveredVia: c.discoveredVia.slice(0, 300),
            rank: c.rank,
            relevance: c.relevance,
            rationale: c.rationale.slice(0, 400),
          },
        });
      }

      const status = merged.length === 0 && anyFailure ? 'failed' : anyFailure ? 'partial' : 'complete';
      const finished = await this.prisma.authorityScan.update({
        where: { id: scan.id },
        data: {
          status,
          candidateCount: merged.length,
          costUsd: Number(cost.toFixed(6)),
          model,
          note: anyFailure ? 'one or more discovery sources failed' : null,
          finishedAt: new Date(),
        },
      });
      this.logger.log(`authority scan ${scan.id} ${status}: ${merged.length} candidates ($${cost.toFixed(4)})`);
      return this.get(finished.id);
    } catch (err) {
      await this.prisma.authorityScan.update({
        where: { id: scan.id },
        data: { status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date() },
      });
      throw err;
    }
  }

  async list(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return this.prisma.authorityScan.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  async get(scanId: string) {
    const scan = await this.prisma.authorityScan.findUnique({
      where: { id: scanId },
      include: { candidates: { orderBy: [{ relevance: 'desc' }, { domain: 'asc' }] } },
    });
    if (!scan) throw new NotFoundException('Authority scan not found: ' + scanId);
    return scan;
  }

  async updateCandidate(scanId: string, candidateId: string, status: string) {
    await this.getOr404(scanId);
    const c = await this.prisma.authorityCandidate.findUnique({ where: { id: candidateId } });
    if (!c || c.scanId !== scanId) throw new NotFoundException('Candidate not found: ' + candidateId);
    return this.prisma.authorityCandidate.update({ where: { id: candidateId }, data: { status } });
  }

  /** Promote a candidate into the mention-tracking outreach ledger. */
  async promote(scanId: string, candidateId: string) {
    const scan = await this.getOr404(scanId);
    const c = await this.prisma.authorityCandidate.findUnique({ where: { id: candidateId } });
    if (!c || c.scanId !== scanId) throw new NotFoundException('Candidate not found: ' + candidateId);
    if (c.status === 'promoted' && c.promotedTargetId) {
      throw new ConflictException(`Candidate already promoted (MentionTarget ${c.promotedTargetId}).`);
    }

    const targetType = CANDIDATE_TO_TARGET_TYPE[c.type as AuthorityCandidateType] ?? 'other';
    const url = /^https?:\/\//i.test(c.url) ? c.url : `https://${c.domain}/`;
    const target = await this.mentions.createTarget(
      scan.projectId,
      url,
      targetType,
      c.title,
      undefined,
      `Promoted from authority scan ${scanId} (${c.discoveredVia}); relevance ${c.relevance}`,
    );
    const updated = await this.prisma.authorityCandidate.update({
      where: { id: candidateId },
      data: { status: 'promoted', promotedTargetId: target.id },
    });
    await this.prisma.authorityScan.update({
      where: { id: scanId },
      data: { promotedCount: { increment: 1 } },
    });
    this.logger.log(`authority candidate ${candidateId} promoted → MentionTarget ${target.id}`);
    return { candidate: updated, target };
  }

  async remove(scanId: string) {
    await this.getOr404(scanId);
    await this.prisma.authorityScan.delete({ where: { id: scanId } });
    return { removed: scanId };
  }

  // ─── internals ─────────────────────────────────────────────

  private resolveQueries(provided: string[] | undefined, category: string): string[] {
    const base =
      provided && provided.length > 0
        ? provided
        : [`best ${category} tools`, `${category} alternatives`, `top ${category} platforms`];
    return [...new Set(base.map((q) => q.trim().toLowerCase()).filter((q) => q.length >= 3))].slice(
      0,
      AUTHORITY_LIMITS.maxListicleQueries,
    );
  }

  private async citationCandidates(projectId: string, category: string, ex: ExcludeSet): Promise<WorkingCandidate[]> {
    // Every citation an AI answer produced in this project's journeys — the
    // point of authority discovery is the domains the answers cite, most of
    // which are NOT the client.
    const [journeySteps, observations] = await Promise.all([
      this.prisma.journeyStep.findMany({
        where: { journey: { projectId }, status: 'done' },
        select: { citations: true, citedUrl: true },
        take: 500,
      }),
      this.prisma.observation.findMany({
        where: { run: { projectId }, cited: true },
        select: { citedUrl: true },
        take: 500,
      }),
    ]);

    const journeyUrls = new Set<string>();
    for (const s of journeySteps) {
      if (s.citedUrl) journeyUrls.add(s.citedUrl);
      try {
        for (const u of JSON.parse(s.citations) as string[]) if (typeof u === 'string') journeyUrls.add(u);
      } catch {
        /* ignore */
      }
    }
    const measurementUrls = observations.map((o) => o.citedUrl).filter((u): u is string => !!u);

    return [
      ...candidatesFromCitations([...journeyUrls], 'journey', category, ex),
      ...candidatesFromCitations(measurementUrls, 'measurement', category, ex),
    ];
  }

  private async llmCandidates(
    category: string,
    ex: ExcludeSet,
  ): Promise<{ candidates: WorkingCandidate[]; model: string }> {
    const model = this.config.get<string>('AUTHORITY_LLM_MODEL', 'claude-opus-5');
    try {
      const client = this.ensureClient();
      const res = await client.messages.create({
        model,
        max_tokens: 1500,
        system:
          'You list REAL, well-known publications, communities, podcasts, directories, and newsletters ' +
          `where a B2B company in "${category}" could plausibly earn an unpaid mention or be reviewed. ` +
          'Return ONLY minified JSON: {"items":[{"domain","url","title","type","why"}]}. ' +
          'type ∈ listicle|community|podcast|publication|directory|newsletter. 8-15 items. No paid placements, no PR wires.',
        messages: [{ role: 'user', content: `category: ${category}` }],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start === -1 || end <= start) return { candidates: [], model };
      const parsed = JSON.parse(text.slice(start, end + 1)) as { items?: Array<Record<string, unknown>> };
      const types = new Set(['listicle', 'community', 'podcast', 'publication', 'directory', 'newsletter']);
      const candidates: WorkingCandidate[] = [];
      for (const it of parsed.items ?? []) {
        const domain = typeof it.domain === 'string' ? it.domain.toLowerCase().replace(/^www\./, '') : hostOf(String(it.url ?? ''));
        if (!domain || ex.subjectHost === domain || ex.competitorHosts.includes(domain)) continue;
        const type = (types.has(it.type as string) ? it.type : classify(domain, String(it.title ?? ''))) as AuthorityCandidateType;
        candidates.push({
          domain,
          url: typeof it.url === 'string' && /^https?:\/\//.test(it.url) ? it.url : `https://${domain}/`,
          title: typeof it.title === 'string' ? it.title.slice(0, 200) : domain,
          type,
          discoveredVia: 'llm',
          rank: null,
          relevance: 0.6,
          rationale: typeof it.why === 'string' ? it.why.slice(0, 400) : 'Suggested by category research.',
        });
      }
      return { candidates, model };
    } catch (err) {
      this.logger.warn(`authority LLM discovery failed (${(err as Error).message})`);
      return { candidates: [], model };
    }
  }

  private ensureClient(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.get<string>('ANTHROPIC_API_KEY') || undefined });
    }
    return this.anthropic;
  }

  private async getOr404(scanId: string) {
    const s = await this.prisma.authorityScan.findUnique({ where: { id: scanId } });
    if (!s) throw new NotFoundException('Authority scan not found: ' + scanId);
    return s;
  }
}
