/**
 * Journey Service — plan + execute branching search journeys (Agent #2).
 *
 * `planJourney`  — persona → deterministic journey tree (or one LLM-planned
 *                  tree of the same shape), persisted as Journey + JourneyStep.
 * `executeJourney` — walk the tree against a surface adapter, scoring each
 *                  answer for subject/competitor presence. Cost-capped per run.
 * `createCampaign` — fan out planning + execution over many personas under ONE
 *                  USD budget; the single knob that bounds a large swarm run.
 *
 * Safety rails:
 *   - default surface is `mock` (deterministic). A live surface requires
 *     `SWARM_ALLOW_LIVE=1` AND that surface's API key, else 503.
 *   - `JOURNEY_MAX_COST_PER_RUN` caps one journey; `budgetUsd` caps a campaign.
 *   - `JOURNEY_LIMITS.maxStepsPerJourney` hard-caps tree size regardless of
 *     depth/branches.
 *
 * @module journey.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../database/prisma.service';
import { AnthropicSurfaceAdapter } from '../measurement/adapters/anthropic.adapter';
import { PerplexitySurfaceAdapter } from '../measurement/adapters/perplexity.adapter';
import { MockSurfaceAdapter } from '../measurement/adapters/mock.adapter';
import { scoreAnswerForSubject, parseCompetitors } from '../../common/utils/subject-match';
import { planJourney } from './journey.planner';
import { buildSuggestionWheel } from './journey.suggestions';
import { JOURNEY_LIMITS } from './journey.types';
import type { PlannerContext, PlannerPersona } from './journey.planner';
import type { SurfaceAdapter } from '../measurement/measurement.types';
import type {
  CreateCampaignInput,
  ExecuteJourneyResult,
  JourneyPlan,
  JourneySurface,
  PlanJourneyInput,
  PlannedStep,
} from './journey.types';
import type { PersonaAwareness } from '../persona/persona.types';

const DEFAULT_MAX_COST_PER_RUN = 2.0;

@Injectable()
export class JourneyService {
  private readonly logger = new Logger(JourneyService.name);
  private anthropic: Anthropic | null = null;
  private readonly adapters: Map<JourneySurface, SurfaceAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    anthropic: AnthropicSurfaceAdapter,
    perplexity: PerplexitySurfaceAdapter,
    mock: MockSurfaceAdapter,
  ) {
    this.adapters = new Map<JourneySurface, SurfaceAdapter>([
      ['claude', anthropic],
      ['perplexity', perplexity],
      ['mock', mock],
    ]);
  }

  // ─── planning ────────────────────────────────────────────────

  /**
   * Plan a journey for one persona. Persists Journey + its JourneyStep tree.
   * @throws NotFoundException          project or persona missing (persona must belong to project).
   * @throws ServiceUnavailableException `useLlm` without ANTHROPIC_API_KEY.
   */
  async planJourney(projectId: string, input: PlanJourneyInput) {
    const project = await this.ensureProject(projectId);
    const persona = await this.prisma.persona.findUnique({ where: { id: input.personaId } });
    if (!persona || persona.projectId !== projectId) {
      throw new NotFoundException('Persona not found for this project: ' + input.personaId);
    }

    const useLlm = input.useLlm === true;
    if (useLlm && !this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new ServiceUnavailableException(
        'ANTHROPIC_API_KEY not configured — journey LLM planning unavailable (omit useLlm for the deterministic planner)',
      );
    }

    const surface = (input.surface ?? 'mock') as JourneySurface;
    const geo = input.geo ?? 'US';
    const maxDepth = input.maxDepth ?? JOURNEY_LIMITS.maxDepth.default;
    const maxBranches = input.maxBranches ?? JOURNEY_LIMITS.maxBranches.default;

    const plannerPersona = this.toPlannerPersona(persona);
    const ctx = this.plannerContext(project);

    const plan: JourneyPlan = useLlm
      ? await this.planWithLlm(plannerPersona, ctx, { maxDepth, maxBranches })
      : planJourney(plannerPersona, ctx, { maxDepth, maxBranches });

    return this.persistPlan(projectId, persona.id, null, { surface, geo, maxDepth, maxBranches }, plan);
  }

  /**
   * A deterministic suggestion wheel for the project. Two layers:
   *   - `stages` — buyer search queries grouped by awareness stage, built from
   *     personalised templates + the project's personas (vocabulary /
   *     objections / triggers) + queries real journeys already produced.
   *   - `boosts` — concrete AEO/GEO actions derived from the project's own
   *     latest technical audit, link graph and authority scan.
   * Feeds the frontend Flywheel card. No LLM, no spend.
   */
  async suggestionWheel(projectId: string) {
    const project = await this.ensureProject(projectId);
    const [personas, journeySteps, audit, graph, scan] = await Promise.all([
      this.prisma.persona.findMany({
        where: { projectId },
        select: {
          awareness: true,
          role: true,
          seniority: true,
          companyStage: true,
          primaryGoal: true,
          painPoints: true,
          buyingTriggers: true,
          objections: true,
          vocabulary: true,
        },
      }),
      this.prisma.journeyStep.findMany({
        where: { journey: { projectId } },
        select: { awareness: true, query: true, status: true },
        take: 400,
      }),
      this.prisma.technicalAudit.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: {
          findings: {
            select: { type: true, status: true, severity: true, detail: true, recommendedFix: true },
          },
        },
      }),
      this.prisma.linkGraph.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: {
          error: true,
          edgeCount: true,
          pagesCrawled: true,
          recommendations: {
            orderBy: { priority: 'desc' },
            take: 6,
            select: { fromPath: true, toPath: true, suggestedAnchor: true, reason: true, priority: true },
          },
          nodes: {
            where: { isOrphan: true },
            take: 4,
            select: { path: true, title: true },
          },
        },
      }),
      this.prisma.authorityScan.findFirst({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        select: {
          candidates: {
            where: { status: { not: 'dismissed' } },
            orderBy: { relevance: 'desc' },
            take: 6,
            select: { domain: true, type: true, rationale: true, relevance: true },
          },
        },
      }),
    ]);

    const cfg = this.config;
    const integrations = {
      aiSurface: Boolean(cfg.get<string>('ANTHROPIC_API_KEY') || cfg.get<string>('PERPLEXITY_API_KEY')),
      serp: Boolean(cfg.get<string>('DATAFORSEO_LOGIN') && cfg.get<string>('DATAFORSEO_PASSWORD')),
      analytics: Boolean(cfg.get<string>('GA4_PROPERTY_ID') || cfg.get<string>('GSC_SITE_URL')),
    };

    return buildSuggestionWheel({
      project: {
        name: project.name,
        domain: project.domain,
        category: project.category,
        competitors: project.competitors,
      },
      personas,
      journeySteps,
      auditFindings: audit?.findings ?? [],
      linkRecs: graph?.recommendations ?? [],
      orphanPages: graph?.nodes ?? [],
      linkGraphNote: graph?.error ?? null,
      authorityCandidates: scan?.candidates ?? [],
      integrations,
    });
  }

  /** List journeys for a project (newest first), without step bodies. */
  async listJourneys(projectId: string, status?: string) {
    await this.ensureProject(projectId);
    return this.prisma.journey.findMany({
      where: { projectId, ...(status ? { status } : {}) },
      orderBy: { plannedAt: 'desc' },
    });
  }

  /** One journey with its full step tree (ordered depth, then ordinal). */
  async getJourney(journeyId: string) {
    const journey = await this.prisma.journey.findUnique({
      where: { id: journeyId },
      include: { steps: { orderBy: [{ depth: 'asc' }, { ordinal: 'asc' }] } },
    });
    if (!journey) throw new NotFoundException('Journey not found: ' + journeyId);
    return journey;
  }

  async deleteJourney(journeyId: string) {
    const journey = await this.prisma.journey.findUnique({ where: { id: journeyId } });
    if (!journey) throw new NotFoundException('Journey not found: ' + journeyId);
    await this.prisma.journey.delete({ where: { id: journeyId } });
    return { removed: journeyId };
  }

  // ─── execution ───────────────────────────────────────────────

  /**
   * Execute a planned journey: walk pending steps against the surface adapter,
   * score each answer, accumulate cost. Stops at the effective cost cap
   * (`maxCostUsd` override if given and >= 0, else `JOURNEY_MAX_COST_PER_RUN`).
   * @param maxCostUsd Operator override for this run's USD cap (0 = stop before any spend).
   * @throws ConflictException          journey already completed/running.
   * @throws ServiceUnavailableException live surface without SWARM_ALLOW_LIVE + key.
   */
  async executeJourney(journeyId: string, maxCostUsd?: number): Promise<ExecuteJourneyResult> {
    const journey = await this.prisma.journey.findUnique({
      where: { id: journeyId },
      include: { steps: { orderBy: [{ depth: 'asc' }, { ordinal: 'asc' }] } },
    });
    if (!journey) throw new NotFoundException('Journey not found: ' + journeyId);
    if (journey.status === 'running') throw new ConflictException('Journey is already running: ' + journeyId);
    if (journey.status === 'completed') throw new ConflictException('Journey already completed: ' + journeyId);

    const adapter = this.resolveAdapter(journey.surface as JourneySurface);
    const project = await this.prisma.project.findUnique({ where: { id: journey.projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + journey.projectId);

    const subject = { name: project.name, domain: project.domain };
    const competitorNames = parseCompetitors(project.competitors).map((c) => c.name);
    const costCap =
      typeof maxCostUsd === 'number' && Number.isFinite(maxCostUsd) && maxCostUsd >= 0
        ? maxCostUsd
        : this.maxCostPerRun();

    await this.prisma.journey.update({
      where: { id: journeyId },
      data: { status: 'running', startedAt: new Date(), error: null, note: null },
    });

    let cost = journey.costUsd;
    let executed = journey.executedSteps;
    let mentioned = journey.mentionedSteps;
    let cited = journey.citedSteps;
    let stopNote: string | null = null;
    let anyFailure = false;

    for (const step of journey.steps) {
      if (step.status !== 'pending') continue;
      if (cost >= costCap) {
        stopNote = `cost cap $${costCap.toFixed(2)} reached — ${journey.steps.filter((s) => s.status === 'pending').length} step(s) left unrun`;
        break;
      }
      try {
        const answer = await adapter.runPrompt(step.query, journey.geo);
        const score = scoreAnswerForSubject(answer.text, answer.citations, subject, competitorNames);
        cost += answer.costUsd;
        executed += 1;
        if (score.mentioned) mentioned += 1;
        if (score.cited) cited += 1;
        await this.prisma.journeyStep.update({
          where: { id: step.id },
          data: {
            status: 'done',
            answerText: answer.text.slice(0, 8000),
            citations: JSON.stringify(answer.citations.slice(0, 50)),
            mentioned: score.mentioned,
            cited: score.cited,
            citedUrl: score.citedUrl,
            position: score.position,
            competitorsSeen: JSON.stringify(score.competitorsSeen),
            costUsd: Number(answer.costUsd.toFixed(6)),
            latencyMs: answer.latencyMs,
            model: answer.model,
            executedAt: new Date(),
          },
        });
      } catch (err) {
        anyFailure = true;
        this.logger.warn(`journey ${journeyId} step ${step.id} failed: ${(err as Error).message}`);
        await this.prisma.journeyStep.update({
          where: { id: step.id },
          data: { status: 'failed', answerText: (err as Error).message.slice(0, 500), executedAt: new Date() },
        });
      }
    }

    // Mark any still-pending steps skipped (cost cap path).
    if (stopNote) {
      await this.prisma.journeyStep.updateMany({
        where: { journeyId, status: 'pending' },
        data: { status: 'skipped' },
      });
    }

    const pendingLeft = await this.prisma.journeyStep.count({ where: { journeyId, status: 'pending' } });
    // A deliberate cost-cap stop is `partial` even at 0 executed steps — nothing
    // broke, we were told to stop. Only a genuine execution failure is `failed`.
    const status = stopNote
      ? 'partial'
      : executed === 0
        ? 'failed'
        : anyFailure || pendingLeft > 0
          ? 'partial'
          : 'completed';

    const updated = await this.prisma.journey.update({
      where: { id: journeyId },
      data: {
        status,
        executedSteps: executed,
        mentionedSteps: mentioned,
        citedSteps: cited,
        costUsd: Number(cost.toFixed(6)),
        note: stopNote,
        finishedAt: new Date(),
      },
    });

    this.logger.log(
      `journey ${journeyId} ${status}: ${executed}/${updated.stepCount} steps, ` +
        `${mentioned} mentioned, ${cited} cited, $${cost.toFixed(4)}`,
    );
    return {
      journeyId,
      status: status as ExecuteJourneyResult['status'],
      stepCount: updated.stepCount,
      executedSteps: executed,
      mentionedSteps: mentioned,
      citedSteps: cited,
      costUsd: Number(cost.toFixed(6)),
      note: stopNote,
    };
  }

  // ─── campaigns (fan-out governor) ────────────────────────────

  /**
   * Plan (and by default execute) a batch of journeys across many personas
   * under one USD budget. Execution halts the instant `spentUsd >= budgetUsd`.
   */
  async createCampaign(projectId: string, input: CreateCampaignInput) {
    const project = await this.ensureProject(projectId);
    const surface = (input.surface ?? 'mock') as JourneySurface;
    const useLlm = input.useLlm === true;
    const autoRun = input.autoRun !== false;

    if (useLlm && !this.config.get<string>('ANTHROPIC_API_KEY')) {
      throw new ServiceUnavailableException('ANTHROPIC_API_KEY not configured — campaign LLM planning unavailable');
    }
    if (autoRun) this.assertLiveAllowed(surface); // fail before we persist anything

    const roles = input.personaRoles ?? [];
    const personas = await this.prisma.persona.findMany({
      where: { projectId, status: 'active', ...(roles.length > 0 ? { role: { in: roles } } : {}) },
      orderBy: { createdAt: 'asc' },
      take: Math.min(input.journeyTarget, JOURNEY_LIMITS.journeyTarget.max),
    });
    if (personas.length === 0) {
      throw new ConflictException(
        'No active personas match — activate personas first' + (roles.length ? ` (roles: ${roles.join(', ')})` : ''),
      );
    }

    const maxDepth = input.maxDepth ?? JOURNEY_LIMITS.maxDepth.default;
    const maxBranches = input.maxBranches ?? JOURNEY_LIMITS.maxBranches.default;
    const geo = input.geo ?? 'US';

    const campaign = await this.prisma.journeyCampaign.create({
      data: {
        projectId,
        name: input.name,
        surface,
        geo,
        planSource: useLlm ? 'llm' : 'deterministic',
        journeyTarget: input.journeyTarget,
        maxDepth,
        maxBranches,
        personaRoles: JSON.stringify(roles),
        budgetUsd: input.budgetUsd,
        status: 'planned',
      },
    });

    // Plan a journey per persona.
    const ctx = this.plannerContext(project);
    let planned = 0;
    for (const persona of personas) {
      const pp = this.toPlannerPersona(persona);
      const plan = useLlm
        ? await this.planWithLlm(pp, ctx, { maxDepth, maxBranches })
        : planJourney(pp, ctx, { maxDepth, maxBranches });
      await this.persistPlan(projectId, persona.id, campaign.id, { surface, geo, maxDepth, maxBranches }, plan);
      planned += 1;
    }
    await this.prisma.journeyCampaign.update({
      where: { id: campaign.id },
      data: { journeysPlanned: planned },
    });

    if (!autoRun) {
      this.logger.log(`campaign ${campaign.id} planned ${planned} journeys (autoRun off)`);
      return this.getCampaign(campaign.id);
    }
    return this.executeCampaign(campaign.id);
  }

  async listCampaigns(projectId: string) {
    await this.ensureProject(projectId);
    return this.prisma.journeyCampaign.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' } });
  }

  async getCampaign(campaignId: string) {
    const campaign = await this.prisma.journeyCampaign.findUnique({
      where: { id: campaignId },
      include: { journeys: { orderBy: { plannedAt: 'asc' } } },
    });
    if (!campaign) throw new NotFoundException('Campaign not found: ' + campaignId);
    return campaign;
  }

  /**
   * Execute a campaign's not-yet-completed journeys in order, stopping the
   * moment cumulative spend reaches the campaign budget.
   */
  async executeCampaign(campaignId: string) {
    const campaign = await this.prisma.journeyCampaign.findUnique({
      where: { id: campaignId },
      include: { journeys: { orderBy: { plannedAt: 'asc' } } },
    });
    if (!campaign) throw new NotFoundException('Campaign not found: ' + campaignId);
    if (campaign.status === 'completed') throw new ConflictException('Campaign already completed: ' + campaignId);
    this.assertLiveAllowed(campaign.surface as JourneySurface);

    await this.prisma.journeyCampaign.update({
      where: { id: campaignId },
      data: { status: 'running', startedAt: campaign.startedAt ?? new Date() },
    });

    let spent = campaign.spentUsd;
    let executed = campaign.journeysExecuted;
    let budgetHit = false;

    for (const journey of campaign.journeys) {
      if (journey.status === 'completed' || journey.status === 'partial' || journey.status === 'failed') continue;
      if (spent >= campaign.budgetUsd) {
        budgetHit = true;
        break;
      }
      const result = await this.executeJourney(journey.id);
      spent += result.costUsd;
      executed += 1;
      if (spent >= campaign.budgetUsd) {
        budgetHit = true;
        break;
      }
    }

    const remaining = await this.prisma.journey.count({
      where: { campaignId, status: { in: ['planned', 'running'] } },
    });
    const status = executed === 0 ? 'failed' : budgetHit || remaining > 0 ? 'partial' : 'completed';
    const note = budgetHit
      ? `budget $${campaign.budgetUsd.toFixed(2)} reached — ${remaining} journey(s) left unrun`
      : null;

    const updated = await this.prisma.journeyCampaign.update({
      where: { id: campaignId },
      data: {
        status,
        spentUsd: Number(spent.toFixed(6)),
        journeysExecuted: executed,
        note,
        finishedAt: new Date(),
      },
      include: { journeys: { orderBy: { plannedAt: 'asc' } } },
    });
    this.logger.log(
      `campaign ${campaignId} ${status}: ${executed}/${updated.journeysPlanned} journeys, $${spent.toFixed(4)} of $${campaign.budgetUsd}`,
    );
    return updated;
  }

  // ─── internals ───────────────────────────────────────────────

  /** Persist a plan as Journey + step tree (two-pass to resolve parent ids). */
  private async persistPlan(
    projectId: string,
    personaId: string,
    campaignId: string | null,
    opts: { surface: JourneySurface; geo: string; maxDepth: number; maxBranches: number },
    plan: JourneyPlan,
  ) {
    const journey = await this.prisma.journey.create({
      data: {
        projectId,
        personaId,
        campaignId,
        label: plan.label,
        objective: plan.objective,
        surface: opts.surface,
        geo: opts.geo,
        maxDepth: opts.maxDepth,
        maxBranches: opts.maxBranches,
        planSource: plan.source,
        planModel: plan.model,
        status: 'planned',
        stepCount: plan.steps.length,
      },
    });

    // Steps are already in BFS order → a parent is always created before its child.
    const idByLocal = new Map<string, string>();
    for (const s of plan.steps) {
      const created = await this.prisma.journeyStep.create({
        data: {
          journeyId: journey.id,
          parentId: s.parentLocalId ? idByLocal.get(s.parentLocalId) ?? null : null,
          depth: s.depth,
          ordinal: s.ordinal,
          kind: s.kind,
          awareness: s.awareness,
          query: s.query,
          rationale: s.rationale,
        },
      });
      idByLocal.set(s.localId, created.id);
    }

    return this.getJourney(journey.id);
  }

  private resolveAdapter(surface: JourneySurface): SurfaceAdapter {
    this.assertLiveAllowed(surface);
    const adapter = this.adapters.get(surface);
    if (!adapter) throw new BadRequestException('Unknown surface: ' + surface);
    return adapter;
  }

  /**
   * Live-surface guard. `mock` always allowed. A real surface requires
   * `SWARM_ALLOW_LIVE=1` AND that surface's API key.
   */
  private assertLiveAllowed(surface: JourneySurface): void {
    if (surface === 'mock') return;
    if (this.config.get<string>('SWARM_ALLOW_LIVE') !== '1') {
      throw new ServiceUnavailableException(
        `Live surface "${surface}" blocked — set SWARM_ALLOW_LIVE=1 to allow the swarm to spend on real AI surfaces (mock runs need no flag).`,
      );
    }
    const keyName = surface === 'claude' ? 'ANTHROPIC_API_KEY' : 'PERPLEXITY_API_KEY';
    if (!this.config.get<string>(keyName)) {
      throw new ServiceUnavailableException(`${keyName} not configured — cannot run the "${surface}" surface.`);
    }
  }

  private maxCostPerRun(): number {
    const raw = this.config.get<string>('JOURNEY_MAX_COST_PER_RUN');
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_COST_PER_RUN;
  }

  private async ensureProject(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found: ' + projectId);
    return project;
  }

  private toPlannerPersona(p: {
    id: string;
    label: string;
    role: string;
    awareness: string;
    primaryGoal: string;
    researchObjective: string;
    vocabulary: string;
    objections: string;
    seed: string | null;
  }): PlannerPersona {
    const list = (raw: string): string[] => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    };
    return {
      id: p.id,
      label: p.label,
      role: p.role,
      awareness: p.awareness as PersonaAwareness,
      primaryGoal: p.primaryGoal,
      researchObjective: p.researchObjective,
      vocabulary: list(p.vocabulary),
      objections: list(p.objections),
      seed: p.seed,
    };
  }

  private plannerContext(project: { category: string | null; name: string; competitors: string | null }): PlannerContext {
    const competitors = parseCompetitors(project.competitors).map((c) => c.name);
    return {
      category: project.category?.trim() || 'this category',
      brand: project.name,
      competitor: competitors[0] ?? 'the incumbent tool',
    };
  }

  /**
   * LLM planner — one Anthropic call returns a branching tree of the same
   * shape as the deterministic planner. Falls back to deterministic on any
   * parse failure so a plan always lands.
   */
  private async planWithLlm(
    persona: PlannerPersona,
    ctx: PlannerContext,
    opts: { maxDepth: number; maxBranches: number },
  ): Promise<JourneyPlan> {
    const model = this.config.get<string>('JOURNEY_LLM_MODEL', 'claude-opus-5');
    const deterministic = planJourney(persona, ctx, opts);
    try {
      const client = this.ensureClient();
      const system =
        'You design realistic B2B buyer search journeys for market research. Given a persona and ' +
        'context, output ONLY minified JSON: {"steps":[{"localId","parentLocalId","depth","ordinal",' +
        '"kind","awareness","query","rationale"}]}. kind ∈ query|refinement|branch|comparison|objection. ' +
        'awareness ∈ problem-aware|solution-aware|product-aware|most-aware and should advance toward ' +
        `most-aware with depth. Exactly one root (parentLocalId null, depth 0). Max depth ${opts.maxDepth}, ` +
        `max ${opts.maxBranches} children per node, at most ${JOURNEY_LIMITS.maxStepsPerJourney} steps. ` +
        'Queries are what the persona would type into a search box — short, natural, no brand unless product/most-aware.';
      const user = JSON.stringify({
        context: ctx,
        persona: {
          label: persona.label,
          role: persona.role,
          awareness: persona.awareness,
          primaryGoal: persona.primaryGoal,
          researchObjective: persona.researchObjective,
          vocabulary: persona.vocabulary,
          objections: persona.objections,
        },
      });
      const res = await client.messages.create({
        model,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      const steps = this.parsePlannedSteps(text, opts);
      if (steps.length === 0) return deterministic;
      return { ...deterministic, source: 'llm', model, steps };
    } catch (err) {
      this.logger.warn(`journey LLM planning failed (${(err as Error).message}) — using deterministic plan`);
      return deterministic;
    }
  }

  private parsePlannedSteps(text: string, opts: { maxDepth: number; maxBranches: number }): PlannedStep[] {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      return [];
    }
    const arr = (raw as { steps?: unknown }).steps;
    if (!Array.isArray(arr)) return [];
    const kinds = new Set(['query', 'refinement', 'branch', 'comparison', 'objection']);
    const aware = new Set(['problem-aware', 'solution-aware', 'product-aware', 'most-aware']);
    const out: PlannedStep[] = [];
    for (const s of arr.slice(0, JOURNEY_LIMITS.maxStepsPerJourney)) {
      if (!s || typeof s !== 'object') continue;
      const o = s as Record<string, unknown>;
      const query = typeof o.query === 'string' ? o.query.trim() : '';
      const localId = typeof o.localId === 'string' ? o.localId : '';
      if (!query || !localId) continue;
      const depth = Math.max(0, Math.min(Number(o.depth) || 0, opts.maxDepth));
      out.push({
        localId,
        parentLocalId: typeof o.parentLocalId === 'string' && o.parentLocalId ? o.parentLocalId : null,
        depth,
        ordinal: Math.max(0, Number(o.ordinal) || 0),
        kind: kinds.has(o.kind as string) ? (o.kind as PlannedStep['kind']) : 'query',
        awareness: aware.has(o.awareness as string) ? (o.awareness as PersonaAwareness) : 'problem-aware',
        query: query.slice(0, 400),
        rationale: typeof o.rationale === 'string' ? o.rationale.slice(0, 400) : 'follow-up',
      });
    }
    // Must have exactly one root and every parent reference must resolve.
    const ids = new Set(out.map((s) => s.localId));
    const roots = out.filter((s) => s.parentLocalId === null);
    if (roots.length !== 1) return [];
    if (out.some((s) => s.parentLocalId !== null && !ids.has(s.parentLocalId))) return [];
    // Order parent-before-child (stable) so persistence can resolve ids.
    return this.topoOrder(out);
  }

  private topoOrder(steps: PlannedStep[]): PlannedStep[] {
    const byParent = new Map<string | null, PlannedStep[]>();
    for (const s of steps) {
      const bucket = byParent.get(s.parentLocalId);
      if (bucket) bucket.push(s);
      else byParent.set(s.parentLocalId, [s]);
    }
    const ordered: PlannedStep[] = [];
    const queue = [...(byParent.get(null) ?? [])];
    while (queue.length) {
      const n = queue.shift() as PlannedStep;
      ordered.push(n);
      for (const c of byParent.get(n.localId) ?? []) queue.push(c);
    }
    return ordered.length === steps.length ? ordered : steps;
  }

  private ensureClient(): Anthropic {
    if (!this.anthropic) {
      this.anthropic = new Anthropic({ apiKey: this.config.get<string>('ANTHROPIC_API_KEY') || undefined });
    }
    return this.anthropic;
  }
}
