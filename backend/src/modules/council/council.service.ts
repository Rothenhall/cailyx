/**
 * Council Service — run the multi-agent intervention debate (Agent #10).
 *
 * Gathers the project's existing artefacts (gap-analysis, latest link graph,
 * completed journeys, latest completed measurement run, technical-audit
 * failures, entity schema failures), derives candidate interventions, runs the
 * deterministic debate engine (or one LLM-driven debate, gated + cost-capped),
 * and persists the session + per-agent contributions + the ranked outcome.
 *
 * @module council.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../database/prisma.service';
import { buildCandidates } from './council.candidates';
import { runDebate } from './council.engine';
import { AGENT_ROLES, COUNCIL_LIMITS } from './council.types';
import type { ArtefactBundle } from './council.candidates';
import type { AgentContribution, AgentRole, RankedIntervention, RunCouncilInput } from './council.types';

@Injectable()
export class CouncilService {
  private readonly logger = new Logger(CouncilService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Run a council session for a project.
   * @throws NotFoundException          project missing.
   * @throws ServiceUnavailableException useLlm without ANTHROPIC_API_KEY.
   */
  async run(projectId: string, input: RunCouncilInput) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const useLlm = input.useLlm === true;
    if (useLlm && !this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY not configured — council LLM debate unavailable (omit useLlm for the deterministic engine)',
      );
    }

    const rounds = clamp(input.rounds ?? COUNCIL_LIMITS.rounds.default, COUNCIL_LIMITS.rounds.min, COUNCIL_LIMITS.rounds.max);
    const roles = (input.agentRoles && input.agentRoles.length > 0 ? input.agentRoles : [...AGENT_ROLES]).filter((r) =>
      (AGENT_ROLES as readonly string[]).includes(r),
    ) as AgentRole[];
    const question = (input.question ?? 'Which interventions will most improve our AI visibility?').slice(0, 300);

    const bundle = await this.gatherArtefacts(projectId);
    const { candidates, evidenceRefs } = buildCandidates(bundle);

    const session = await this.prisma.councilSession.create({
      data: {
        projectId,
        question,
        rounds,
        agentRoles: JSON.stringify(roles),
        source: useLlm ? 'llm' : 'deterministic',
        status: 'running',
        evidenceRefs: JSON.stringify(evidenceRefs),
      },
    });

    try {
      if (candidates.length === 0) {
        const finished = await this.prisma.councilSession.update({
          where: { id: session.id },
          data: {
            status: 'complete',
            model: null,
            finishedAt: new Date(),
            error: null,
          },
        });
        this.logger.log(`council ${session.id}: no artefacts in scope — nothing to debate`);
        return this.get(finished.id);
      }

      let contributions: AgentContribution[];
      let rankings: RankedIntervention[];
      let model: string | null = null;

      if (useLlm) {
        const llm = await this.debateWithLlm(question, candidates, roles, rounds);
        contributions = llm.contributions;
        rankings = llm.rankings;
        model = llm.model;
      } else {
        const out = runDebate(candidates, roles, rounds);
        contributions = out.contributions;
        rankings = out.rankings;
      }

      await this.persist(session.id, contributions, rankings);

      const finished = await this.prisma.councilSession.update({
        where: { id: session.id },
        data: { status: 'complete', model, finishedAt: new Date() },
      });
      this.logger.log(
        `council ${session.id} complete: ${candidates.length} candidates, ${roles.length} agents × ${rounds} round(s), ` +
          `top = ${rankings[0]?.interventionKey ?? '—'}`,
      );
      return this.get(finished.id);
    } catch (err) {
      await this.prisma.councilSession.update({
        where: { id: session.id },
        data: { status: 'failed', error: (err as Error).message.slice(0, 500), finishedAt: new Date() },
      });
      throw err;
    }
  }

  async list(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return this.prisma.councilSession.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  async get(sessionId: string) {
    const session = await this.prisma.councilSession.findUnique({
      where: { id: sessionId },
      include: {
        contributions: { orderBy: [{ round: 'asc' }, { agentRole: 'asc' }] },
        rankings: { orderBy: { rank: 'asc' } },
      },
    });
    if (!session) throw new NotFoundException('Council session not found: ' + sessionId);
    return session;
  }

  async remove(sessionId: string) {
    const s = await this.prisma.councilSession.findUnique({ where: { id: sessionId } });
    if (!s) throw new NotFoundException('Council session not found: ' + sessionId);
    await this.prisma.councilSession.delete({ where: { id: sessionId } });
    return { removed: sessionId };
  }

  // ─── artefact gathering ─────────────────────────────────────

  private async gatherArtefacts(projectId: string): Promise<ArtefactBundle> {
    const [gapAnalysis, linkGraph, journeys, measurementRun, technicalAudit, entityAudit] = await Promise.all([
      this.prisma.gapAnalysis.findFirst({ where: { projectId } }),
      this.prisma.linkGraph.findFirst({ where: { projectId, status: 'complete' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.journey.findMany({ where: { projectId, status: { in: ['completed', 'partial'] } } }),
      this.prisma.measurementRun.findFirst({ where: { projectId, status: 'completed' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.technicalAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { findings: true },
      }),
      this.prisma.entityAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        include: { entities: { include: { schemaChecks: true } } },
      }),
    ]);

    const gaps = gapAnalysis
      ? await this.prisma.gap.findMany({
          where: { gapAnalysisId: gapAnalysis.id },
          select: { id: true, dimension: true, title: true, status: true, priorityScore: true },
        })
      : [];

    const jAgg = journeys.reduce(
      (acc, j) => {
        acc.completed += 1;
        acc.executedSteps += j.executedSteps;
        acc.mentionedSteps += j.mentionedSteps;
        acc.citedSteps += j.citedSteps;
        return acc;
      },
      { completed: 0, executedSteps: 0, mentionedSteps: 0, citedSteps: 0 },
    );

    let measurement: ArtefactBundle['measurement'] = null;
    if (measurementRun) {
      const obs = await this.prisma.observation.findMany({
        where: { runId: measurementRun.id },
        select: { mentioned: true, cited: true },
      });
      if (obs.length > 0) {
        measurement = {
          runId: measurementRun.id,
          observations: obs.length,
          mentionRate: obs.filter((o) => o.mentioned).length / obs.length,
          citationRate: obs.filter((o) => o.cited).length / obs.length,
        };
      }
    }

    const technicalFailures = (technicalAudit?.findings ?? [])
      .filter((f) => f.status === 'fail')
      .map((f) => ({ id: f.id, type: f.type }));

    const entitySchemaFailures = (entityAudit?.entities ?? [])
      .flatMap((e) => e.schemaChecks)
      .filter((c) => c.status === 'fail').length;

    return {
      gaps,
      linkGraph: linkGraph
        ? { id: linkGraph.id, orphanCount: linkGraph.orphanCount, recommendationCount: linkGraph.recommendationCount }
        : null,
      journeys: jAgg,
      measurement,
      technicalFailures,
      entitySchemaFailures,
    };
  }

  // ─── persistence ───────────────────────────────────────────

  private async persist(sessionId: string, contributions: AgentContribution[], rankings: RankedIntervention[]) {
    for (const c of contributions) {
      await this.prisma.councilContribution.create({
        data: {
          sessionId,
          round: c.round,
          agentRole: c.agentRole,
          summary: c.summary,
          positions: JSON.stringify(c.positions),
        },
      });
    }
    for (const r of rankings) {
      await this.prisma.councilRanking.create({
        data: {
          sessionId,
          rank: r.rank,
          interventionKey: r.interventionKey,
          title: r.title,
          rationale: r.rationale,
          consensus: r.consensus,
          expectedImpact: r.expectedImpact,
          effort: r.effort,
          confidence: r.confidence,
          sourceRefs: JSON.stringify(r.sourceRefs),
          dissent: r.dissent,
        },
      });
    }
  }

  // ─── optional LLM debate ───────────────────────────────────

  /**
   * One Anthropic call runs the whole debate; result is validated against the
   * candidate set and falls back to the deterministic engine on any problem, so
   * a session always produces a coherent ranking.
   */
  private async debateWithLlm(
    question: string,
    candidates: ReturnType<typeof buildCandidates>['candidates'],
    roles: AgentRole[],
    rounds: number,
  ): Promise<{ contributions: AgentContribution[]; rankings: RankedIntervention[]; model: string }> {
    const model = this.config.get<string>('COUNCIL_LLM_MODEL', 'claude-opus-5');
    const deterministic = runDebate(candidates, roles, rounds);
    try {
      const client = this.ensureClient();
      const res = await client.messages.create({
        model,
        max_tokens: 2500,
        system:
          'You facilitate a panel of B2B AI-visibility specialists debating which interventions to prioritise. ' +
          'Roles: ' +
          roles.join(', ') +
          '. Use ONLY the provided candidate interventions and their evidence. Return ONLY minified JSON: ' +
          '{"contributions":[{"round","agentRole","summary","positions":[{"interventionKey","vote","weight","rationale"}]}],' +
          '"rankings":[{"rank","interventionKey","title","rationale","consensus","expectedImpact","effort","confidence","dissent"}]}. ' +
          'vote ∈ for|against|conditional; weight 0..1; consensus 0..1; expectedImpact 0..100; effort/confidence ∈ low|medium|high. ' +
          'interventionKey MUST be one of the provided keys.',
        messages: [
          {
            role: 'user',
            content: JSON.stringify({ question, rounds, candidates }),
          },
        ],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      const parsed = this.parseDebate(text, new Set(candidates.map((c) => c.key)));
      if (!parsed) return { ...deterministic, model };
      return { ...parsed, model };
    } catch (err) {
      this.logger.warn(`council LLM debate failed (${(err as Error).message}) — using deterministic engine`);
      return { ...deterministic, model };
    }
  }

  private parseDebate(
    text: string,
    validKeys: Set<string>,
  ): { contributions: AgentContribution[]; rankings: RankedIntervention[] } | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let raw: { contributions?: unknown; rankings?: unknown };
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!Array.isArray(raw.contributions) || !Array.isArray(raw.rankings)) return null;

    const votes = new Set(['for', 'against', 'conditional']);
    const grades = new Set(['low', 'medium', 'high']);
    const contributions: AgentContribution[] = [];
    for (const c of raw.contributions as Array<Record<string, unknown>>) {
      if (!c || typeof c.agentRole !== 'string' || typeof c.summary !== 'string') continue;
      const positions = Array.isArray(c.positions)
        ? (c.positions as Array<Record<string, unknown>>)
            .filter((p) => typeof p.interventionKey === 'string' && validKeys.has(p.interventionKey))
            .map((p) => ({
              interventionKey: p.interventionKey as string,
              vote: votes.has(p.vote as string) ? (p.vote as AgentContribution['positions'][number]['vote']) : 'conditional',
              weight: clamp(Number(p.weight) || 0.5, 0, 1),
              rationale: typeof p.rationale === 'string' ? p.rationale.slice(0, 300) : '',
            }))
        : [];
      contributions.push({
        round: clamp(Number(c.round) || 1, 1, COUNCIL_LIMITS.rounds.max),
        agentRole: c.agentRole as AgentRole,
        summary: c.summary.slice(0, 600),
        positions,
      });
    }

    const rankings: RankedIntervention[] = [];
    let rank = 1;
    for (const r of raw.rankings as Array<Record<string, unknown>>) {
      if (!r || typeof r.interventionKey !== 'string' || !validKeys.has(r.interventionKey)) continue;
      rankings.push({
        rank: rank++,
        interventionKey: r.interventionKey,
        title: typeof r.title === 'string' ? r.title.slice(0, 200) : r.interventionKey,
        rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 400) : '',
        consensus: clamp(Number(r.consensus) || 0, 0, 1),
        expectedImpact: Math.round(clamp(Number(r.expectedImpact) || 0, 0, 100)),
        effort: grades.has(r.effort as string) ? (r.effort as RankedIntervention['effort']) : 'medium',
        confidence: grades.has(r.confidence as string) ? (r.confidence as RankedIntervention['confidence']) : 'medium',
        sourceRefs: [],
        dissent: typeof r.dissent === 'string' && r.dissent.trim() ? r.dissent.slice(0, 300) : null,
      });
    }
    if (contributions.length === 0 || rankings.length === 0) return null;
    return { contributions, rankings };
  }

  private ensureClient(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.get<string>('ANTHROPIC_API_KEY') || undefined });
    }
    return this.anthropic;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
