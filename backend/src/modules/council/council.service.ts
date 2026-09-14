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
import { LlmService } from '../../common/llm/llm.service';
import { PrismaService } from '../database/prisma.service';
import { buildCandidates } from './council.candidates';
import { runDebate } from './council.engine';
import { AGENT_ROLES, COUNCIL_LIMITS } from './council.types';
import type { ArtefactBundle } from './council.candidates';
import type { AgentContribution, AgentRole, RankedIntervention, RunCouncilInput } from './council.types';

@Injectable()
export class CouncilService {
  private readonly logger = new Logger(CouncilService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Run a council session for a project.
   * @throws NotFoundException          project missing.
   * @throws ServiceUnavailableException useLlm without a configured LLM provider.
   */
  async run(projectId: string, input: RunCouncilInput) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);

    const useLlm = input.useLlm === true;
    if (useLlm && !this.llm.isAvailable()) {
      throw new ServiceUnavailableException(
        'No LLM provider configured (OPENROUTER_API_KEY or ANTHROPIC_API_KEY) — council LLM debate unavailable (omit useLlm for the deterministic engine)',
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
  ): Promise<{ contributions: AgentContribution[]; rankings: RankedIntervention[]; model: string | null }> {
    const deterministic = runDebate(candidates, roles, rounds);
    try {
      const result = await this.llm.json(
        {
          purpose: 'council LLM debate',
          maxTokens: 2500,
          openRouterModel: this.config.get<string>('COUNCIL_LLM_MODEL'),
          anthropicModel: this.config.get<string>('COUNCIL_LLM_ANTHROPIC_MODEL'),
          system:
            'You facilitate a panel of B2B AI-visibility specialists debating which interventions to prioritise. ' +
            'Roles: ' +
            roles.join(', ') +
            '. Use ONLY the provided candidate interventions and their evidence. Return ONLY minified JSON: ' +
            '{"contributions":[{"round","agentRole","summary","positions":[{"interventionKey","vote","weight","rationale"}]}],' +
            '"rankings":[{"rank","interventionKey","title","rationale","consensus","expectedImpact","effort","confidence","dissent"}]}. ' +
            'vote ∈ for|against|conditional; weight 0..1; consensus 0..1; expectedImpact 0..100; effort/confidence ∈ low|medium|high. ' +
            'interventionKey MUST be one of the provided keys.',
          user: JSON.stringify({ question, rounds, candidates }),
        },
        (raw) => this.parseDebate(raw, new Set(candidates.map((c) => c.key))),
      );
      return { ...result.data, model: result.model };
    } catch (err) {
      this.logger.warn(`council LLM debate failed (${(err as Error).message}) — using deterministic engine`);
      return { ...deterministic, model: null };
    }
  }

  private parseDebate(
    raw: unknown,
    validKeys: Set<string>,
  ): { contributions: AgentContribution[]; rankings: RankedIntervention[] } {
    const r = raw as { contributions?: unknown; rankings?: unknown };
    if (!Array.isArray(r.contributions) || !Array.isArray(r.rankings)) {
      throw new Error('debate response missing contributions/rankings arrays');
    }
    const rawContributions = r.contributions;
    const rawRankings = r.rankings;

    const votes = new Set(['for', 'against', 'conditional']);
    const grades = new Set(['low', 'medium', 'high']);
    const contributions: AgentContribution[] = [];
    for (const c of rawContributions as Array<Record<string, unknown>>) {
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
    for (const rk of rawRankings as Array<Record<string, unknown>>) {
      if (!rk || typeof rk.interventionKey !== 'string' || !validKeys.has(rk.interventionKey)) continue;
      rankings.push({
        rank: rank++,
        interventionKey: rk.interventionKey,
        title: typeof rk.title === 'string' ? rk.title.slice(0, 200) : rk.interventionKey,
        rationale: typeof rk.rationale === 'string' ? rk.rationale.slice(0, 400) : '',
        consensus: clamp(Number(rk.consensus) || 0, 0, 1),
        expectedImpact: Math.round(clamp(Number(rk.expectedImpact) || 0, 0, 100)),
        effort: grades.has(rk.effort as string) ? (rk.effort as RankedIntervention['effort']) : 'medium',
        confidence: grades.has(rk.confidence as string) ? (rk.confidence as RankedIntervention['confidence']) : 'medium',
        sourceRefs: [],
        dissent: typeof rk.dissent === 'string' && rk.dissent.trim() ? rk.dissent.slice(0, 300) : null,
      });
    }
    if (contributions.length === 0 || rankings.length === 0) {
      throw new Error('debate response produced no usable contributions/rankings');
    }
    return { contributions, rankings };
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
