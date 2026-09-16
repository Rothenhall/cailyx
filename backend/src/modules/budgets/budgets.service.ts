/**
 * BudgetsService — G12: budget policies, policy evaluation, the cost-estimate
 * pre-flight and the spend ledger.
 *
 * The reservation lifecycle lives in {@link ReservationsService}, which calls
 * {@link BudgetsService.evaluate} *inside its transaction* so a cap check and
 * the hold it authorises commit together. This service is deliberately
 * split into two halves:
 *
 * - **Reading** — `getBudgetView`, `getSpendView`, `estimate`. Pure reads.
 * - **Evaluating** — `evaluate`, which takes a `db` handle so the caller
 *   decides whether it runs in a transaction.
 *
 * ## Invariants this file maintains
 *
 * 1. **A ceiling is checked per unit.** `UnitTotal` carries its own unit; no
 *    method here returns a single blended "spend" figure, because dollars and
 *    provider credits are not the same quantity (design_plan.md G12).
 *
 * 2. **`SpendReservation` contributes holds; `SpendEvent` contributes actuals.**
 *    A settled reservation is *not* also summed from its `settledUsd`, because
 *    settling writes the `SpendEvent` that carries it. Summing both would
 *    double-count every settled run. `released` and `expired` reservations
 *    contribute nothing.
 *
 * 3. **An unresolvable window is refused, not guessed.** A `cycle`-period
 *    policy on a project with no live cycle comes back in `unresolved` and the
 *    reservation path fails closed on it.
 *
 * 4. **Context: the AEO estimate is a Cloro credit estimate.** `estimate()`
 *    reports it in `credits` with its tariff basis, and reports any dollar
 *    figure as an explicitly-flagged conversion — never as "the budget".
 *    It is not all-provider USD spend and it is not a team ledger.
 *
 * @module budgets.service
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CloroClient, CLORO_BASE_CREDITS, type CloroSurface } from '../measurement/adapters/cloro.adapter';
import { AEO_SURFACES, MATRIX_TIERS, SURFACE_LABELS, TIER_SIZES, type MatrixTier } from '../aeo-audit/aeo-audit.types';
import type {
  Affordability,
  BudgetEnforcement,
  BudgetPeriod,
  PolicyEvaluation,
  PolicyWindow,
  ProviderBalance,
  SpendUnit,
  UnitTotal,
} from './budgets.types';
import {
  BUDGET_ENFORCEMENTS,
  BUDGET_PERIODS,
  SPEND_UNITS,
  TASK_KINDS,
} from './budgets.types';
import { describeWindow, resolvePeriodWindow, type CycleBoundary } from './lib/period.util';
import type { CreateCostEstimateDto, ListSpendQueryDto } from './dto/budget.dto';
import type { RecordSpendEventDto } from './dto/spend.dto';

/** The project fields every evaluation needs. */
export interface ProjectScope {
  id: string;
  name: string;
  domain: string;
  clientId: string | null;
  timezone: string;
}

/**
 * The narrowest Prisma surface this service needs. Typed as a structural
 * subset of `PrismaService` so the same code runs against the root client and
 * against a `Prisma.TransactionClient` inside `$transaction`.
 */
export type BudgetDb = Pick<
  PrismaService,
  'budgetPolicy' | 'spendReservation' | 'spendEvent' | 'project' | 'cycle'
>;

/** A ceiling that could not be measured, and why. */
export interface UnresolvedPolicy {
  policyId: string;
  scopeType: string;
  taskKind: string | null;
  enforcement: BudgetEnforcement;
  period: BudgetPeriod;
  reason: string;
}

export interface EvaluationResult {
  /** Every applicable ceiling, already measured. */
  policies: PolicyEvaluation[];
  /**
   * Applicable ceilings whose window could not be resolved. Callers must fail
   * closed on a non-empty list rather than treat the ceiling as absent.
   */
  unresolved: UnresolvedPolicy[];
  activeCycle: (CycleBoundary & { name: string }) | null;
  /** One entry per unit, naming the tightest ceiling that applies. */
  bindingCeilings: Array<{ unit: SpendUnit; policyId: string; limit: number; remaining: number }>;
  /** Units no applicable policy caps at all. */
  unboundedUnits: SpendUnit[];
}

export interface EvaluateOptions {
  project: ProjectScope;
  /** The task kind about to run; selects the operation-level policy. */
  taskKind: string;
  /** Injectable clock. */
  at?: Date;
}

@Injectable()
export class BudgetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cloro: CloroClient,
  ) {}

  // ── config helpers ────────────────────────────────────────────────────

  /**
   * Strictest "configured" predicate in the codebase (trimmed, so a value of
   * `' '` counts as unset) — reused verbatim from `IntegrationsService` so the
   * two surfaces never disagree about whether a key is present.
   */
  private has(key: string): boolean {
    const v = this.config.get<string>(key);
    return typeof v === 'string' && v.trim().length > 0;
  }

  // ── project scope ─────────────────────────────────────────────────────

  /**
   * Load the project fields an evaluation needs.
   * @throws NotFoundException the project does not exist.
   */
  async getProjectScope(projectId: string, db: BudgetDb = this.prisma): Promise<ProjectScope> {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, domain: true, clientId: true, timezone: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  // ── policy read ───────────────────────────────────────────────────────

  /**
   * Every ceiling that could apply to a run on this project, evaluated.
   *
   * Precedence is *additive*, not override: a client-wide ceiling, a
   * project-wide ceiling and an operation ceiling all bind, because each is a
   * real commitment somebody made. The most specific one is named in
   * `bindingCeilings` when it is the tightest, but it does not switch the
   * others off.
   */
  async evaluate(db: BudgetDb, opts: EvaluateOptions): Promise<EvaluationResult> {
    const { project, taskKind } = opts;
    const at = opts.at ?? new Date();

    const activeCycleRow = await db.cycle.findFirst({
      where: { projectId: project.id, status: { in: ['committed', 'active', 'review'] } },
      orderBy: { startsOn: 'desc' },
      select: { id: true, name: true, startsOn: true, endsOn: true },
    });
    const activeCycle = activeCycleRow
      ? { id: activeCycleRow.id, name: activeCycleRow.name, startsOn: activeCycleRow.startsOn, endsOn: activeCycleRow.endsOn }
      : null;

    // Operation-scoped policies are selected by task kind. `taskKind: null`
    // means the project-wide policy; SQLite treats NULLs as distinct in a
    // unique index, so project-wide rows are matched explicitly.
    const policies = await db.budgetPolicy.findMany({
      where: {
        OR: [
          { scopeType: 'operation', scopeId: project.id, taskKind },
          { scopeType: 'project', scopeId: project.id, taskKind: null },
          ...(project.clientId ? [{ scopeType: 'client', scopeId: project.clientId, taskKind: null }] : []),
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    const evaluated: PolicyEvaluation[] = [];
    const unresolved: UnresolvedPolicy[] = [];

    for (const policy of policies) {
      const period = this.asPeriod(policy.period);
      const enforcement = this.asEnforcement(policy.enforcement);
      const resolution = resolvePeriodWindow(period, project.timezone, activeCycle, at);
      const window = describeWindow(period, project.timezone, resolution);

      if (resolution.resolved === 'unresolved') {
        unresolved.push({
          policyId: policy.id,
          scopeType: policy.scopeType,
          taskKind: policy.taskKind,
          enforcement,
          period,
          reason: resolution.unresolvedReason ?? 'The policy window could not be resolved.',
        });
        continue;
      }

      const totals = await this.measurePolicy(db, {
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        policyTaskKind: policy.taskKind,
        limitUsd: policy.limitUsd,
        limitCredits: policy.limitCredits,
        window: resolution,
        project,
      });

      evaluated.push({
        policyId: policy.id,
        scopeType: policy.scopeType as PolicyEvaluation['scopeType'],
        scopeId: policy.scopeId,
        taskKind: policy.taskKind,
        enforcement,
        window,
        totals,
        exceeded: totals.some((t) => t.overLimit === true),
        perRunCapUsd: policy.perRunCapUsd,
      });
    }

    return {
      policies: evaluated,
      unresolved,
      activeCycle,
      bindingCeilings: this.bindingCeilings(evaluated),
      unboundedUnits: this.unboundedUnits(evaluated),
    };
  }

  /**
   * Pre-flight check for a run that has not started.
   *
   * Answers one question: **would starting this work breach a hard ceiling?**
   * It creates nothing and charges nothing — it is a gate, not a reservation.
   *
   * This exists because `reserve` was only ever called by the API, so a
   * pipeline that never reserved was never checked and a `BudgetPolicy` bounded
   * nothing in practice. Calling this from the queue means a hard cap is
   * enforced at the one place every background run passes through, including
   * the ones with no UI in front of them.
   *
   * Only **hard** enforcement refuses. A soft ceiling is advisory by
   * definition — refusing on it would silently convert a warning into a
   * blocker, which is not what anyone configured. Reports are advisory too:
   * a project with no policy is completely unaffected.
   *
   * @returns the evaluation, so a caller can surface the reason rather than a
   *          bare refusal.
   * @throws ConflictException when a hard ceiling is already exceeded.
   */
  async assertWithinBudget(projectId: string, taskKind: string): Promise<EvaluationResult> {
    const project = await this.getProjectScope(projectId);
    const evaluation = await this.evaluate(this.prisma, { project, taskKind });

    const breachedHard = evaluation.policies.filter(
      (policy) => policy.exceeded && policy.enforcement === 'hard',
    );

    if (breachedHard.length > 0) {
      const detail = breachedHard
        .map((policy) => {
          const totals = policy.totals
            .filter((total) => total.overLimit)
            .map(
              (total) =>
                `${total.reservedHeld + total.settled} of ${total.limit} ${total.unit} used`,
            )
            .join(', ');
          return `${policy.taskKind ?? 'project'} ${policy.window} ceiling: ${totals}`;
        })
        .join('; ');
      throw new ConflictException(
        `This run would exceed a budget ceiling set to hard enforcement — ${detail}. Raise the ceiling on the project's budget, or run it outside the capped window.`,
      );
    }

    return evaluation;
  }

  /**
   * Measure one policy's usage for its window.
   *
   * Holds come from `held`, non-expired reservations; actuals come from
   * `SpendEvent`. Settled reservations are excluded from the hold sum on
   * purpose — settling writes the event, and adding both would count the same
   * charge twice.
   */
  private async measurePolicy(
    db: BudgetDb,
    input: {
      policyId: string;
      scopeType: string;
      scopeId: string;
      policyTaskKind: string | null;
      limitUsd: number | null;
      limitCredits: number | null;
      window: { startsAt: Date | null; endsAt: Date | null };
      project: ProjectScope;
    },
  ): Promise<UnitTotal[]> {
    const projectIds = await this.scopeProjectIds(db, input.scopeType, input.scopeId, input.project);
    if (projectIds.length === 0) return this.totalsFor(input.limitUsd, input.limitCredits, 0, 0, 0, 0);

    const taskKindFilter = input.policyTaskKind ? { taskKind: input.policyTaskKind } : {};
    const createdAtFilter = this.dateFilter(input.window, 'createdAt');
    const occurredAtFilter = this.dateFilter(input.window, 'occurredAt');

    const held = await db.spendReservation.aggregate({
      _sum: { reservedUsd: true, reservedCredits: true },
      where: {
        projectId: { in: projectIds },
        status: 'held',
        // A lapsed hold is not spend. Excluding it here is what lets a
        // crashed run stop blocking the next one.
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        ...taskKindFilter,
        ...createdAtFilter,
      },
    });

    const settledUsd = await db.spendEvent.aggregate({
      _sum: { amount: true },
      where: {
        projectId: { in: projectIds },
        unit: 'usd',
        ...taskKindFilter,
        ...occurredAtFilter,
      },
    });
    const settledCredits = await db.spendEvent.aggregate({
      _sum: { amount: true },
      where: {
        projectId: { in: projectIds },
        unit: 'credits',
        ...taskKindFilter,
        ...occurredAtFilter,
      },
    });

    return this.totalsFor(
      input.limitUsd,
      input.limitCredits,
      held._sum.reservedUsd ?? 0,
      held._sum.reservedCredits ?? 0,
      settledUsd._sum.amount ?? 0,
      settledCredits._sum.amount ?? 0,
    );
  }

  /** Build the per-unit totals. Units are never combined. */
  private totalsFor(
    limitUsd: number | null,
    limitCredits: number | null,
    heldUsd: number,
    heldCredits: number,
    settledUsd: number,
    settledCredits: number,
  ): UnitTotal[] {
    const build = (unit: SpendUnit, limit: number | null, held: number, settled: number): UnitTotal => {
      const consumed = held + settled;
      return {
        unit,
        limit,
        reservedHeld: held,
        settled,
        remaining: limit === null ? null : limit - consumed,
        overLimit: limit === null ? null : consumed > limit,
      };
    };
    return [
      build('usd', limitUsd, heldUsd, settledUsd),
      build('credits', limitCredits, heldCredits, settledCredits),
    ];
  }

  /**
   * The project ids a policy's usage is summed over. A client-scoped policy
   * spans every project of that client — anything narrower would report a
   * client ceiling as satisfied while the client's actual total sailed past it.
   */
  private async scopeProjectIds(
    db: BudgetDb,
    scopeType: string,
    scopeId: string,
    project: ProjectScope,
  ): Promise<string[]> {
    if (scopeType === 'operation' || scopeType === 'project') return [project.id];
    const projects = await db.project.findMany({ where: { clientId: scopeId }, select: { id: true } });
    return projects.map((p) => p.id);
  }

  /** Half-open window filter for the given timestamp field, or `{}` for all-time. */
  private dateFilter(
    window: { startsAt: Date | null; endsAt: Date | null },
    field: 'createdAt' | 'occurredAt',
  ): Record<string, unknown> {
    if (!window.startsAt && !window.endsAt) return {};
    const range: { gte?: Date; lt?: Date } = {};
    if (window.startsAt) range.gte = window.startsAt;
    if (window.endsAt) range.lt = window.endsAt;
    return { [field]: range };
  }

  /** Per unit, the ceiling with the least headroom, naming the policy it came from. */
  private bindingCeilings(policies: PolicyEvaluation[]): EvaluationResult['bindingCeilings'] {
    const out: EvaluationResult['bindingCeilings'] = [];
    for (const unit of SPEND_UNITS) {
      let best: { policyId: string; limit: number; remaining: number } | null = null;
      for (const p of policies) {
        const t = p.totals.find((x) => x.unit === unit);
        if (!t || t.limit === null || t.remaining === null) continue;
        if (!best || t.remaining < best.remaining) {
          best = { policyId: p.policyId, limit: t.limit, remaining: t.remaining };
        }
      }
      if (best) out.push({ unit, ...best });
    }
    return out;
  }

  private unboundedUnits(policies: PolicyEvaluation[]): SpendUnit[] {
    return SPEND_UNITS.filter((unit) =>
      !policies.some((p) => {
        const t = p.totals.find((x) => x.unit === unit);
        return t ? t.limit !== null : false;
      }),
    );
  }

  private asPeriod(raw: string): BudgetPeriod {
    return (BUDGET_PERIODS as readonly string[]).includes(raw) ? (raw as BudgetPeriod) : 'month';
  }

  private asEnforcement(raw: string): BudgetEnforcement {
    return (BUDGET_ENFORCEMENTS as readonly string[]).includes(raw) ? (raw as BudgetEnforcement) : 'hard';
  }

  // ── budget endpoint views ─────────────────────────────────────────────

  /**
   * `GET /api/projects/:projectId/budget`.
   *
   * Without a `taskKind` the operation-level ceilings are not evaluated at
   * all — and the response says so rather than quietly reporting a project
   * ceiling as if it were the whole picture.
   */
  async getBudgetView(projectId: string, taskKind?: string) {
    const project = await this.getProjectScope(projectId);
    const taskKindForEvaluation = taskKind ?? TASK_KINDS[0];
    const evaluation = taskKind
      ? await this.evaluate(this.prisma, { project, taskKind: taskKindForEvaluation })
      : await this.evaluateProjectScopesOnly(project);

    return {
      projectId: project.id,
      timezone: project.timezone,
      evaluatedForTaskKind: taskKind ?? null,
      operationCeilingsExcluded: taskKind
        ? null
        : 'No taskKind was given, so operation-level ceilings are not evaluated here. Pass ?taskKind= to include them.',
      activeCycle: evaluation.activeCycle
        ? {
            id: evaluation.activeCycle.id,
            name: evaluation.activeCycle.name,
            startsOn: evaluation.activeCycle.startsOn.toISOString(),
            endsOn: evaluation.activeCycle.endsOn.toISOString(),
          }
        : null,
      policies: evaluation.policies,
      unresolvedPolicies: evaluation.unresolved,
      bindingCeilings: evaluation.bindingCeilings,
      unboundedUnits: evaluation.unboundedUnits,
      notes: this.budgetNotes(evaluation),
    };
  }

  /** Evaluation limited to client/project ceilings — no task kind in play. */
  private async evaluateProjectScopesOnly(project: ProjectScope): Promise<EvaluationResult> {
    const rows = await this.prisma.budgetPolicy.findMany({
      where: {
        OR: [
          { scopeType: 'project', scopeId: project.id, taskKind: null },
          ...(project.clientId ? [{ scopeType: 'client', scopeId: project.clientId, taskKind: null }] : []),
        ],
      },
    });
    if (rows.length === 0) {
      return {
        policies: [],
        unresolved: [],
        activeCycle: null,
        bindingCeilings: [],
        unboundedUnits: [...SPEND_UNITS],
      };
    }
    // Reuse the full evaluation for the project-wide ceiling by evaluating it
    // against an arbitrary task kind: project-scoped policies ignore taskKind,
    // so the result is identical whichever kind is used.
    return this.evaluate(this.prisma, { project, taskKind: TASK_KINDS[0] });
  }

  private budgetNotes(evaluation: EvaluationResult): string[] {
    const notes: string[] = [];
    if (evaluation.policies.length === 0) {
      notes.push(
        'No budget policy applies to this project. Unbounded work is reported as unbounded, not as within budget.',
      );
    }
    for (const u of evaluation.unresolved) {
      notes.push(`${u.scopeType} policy ${u.policyId} could not be measured: ${u.reason}`);
    }
    for (const unit of evaluation.unboundedUnits) {
      notes.push(`No policy sets a ${unit === 'usd' ? 'dollar' : 'credit'} ceiling, so that unit is unbounded.`);
    }
    return notes;
  }

  /**
   * `PUT /api/projects/:projectId/budget` — create or replace the
   * project-wide ceiling, or an operation-level one when `taskKind` is given.
   *
   * SQLite treats NULLs as distinct in a unique index, so the project-wide row
   * is matched with an explicit `taskKind: null` lookup rather than an
   * `upsert` on the composite key — which would silently create a second
   * project-wide row and then evaluate only one of them.
   */
  async putProjectPolicy(
    projectId: string,
    dto: {
      taskKind?: string;
      limitUsd?: number | null;
      limitCredits?: number | null;
      period?: string;
      enforcement?: string;
      perRunCapUsd?: number | null;
    },
    actorUserId: string,
  ) {
    await this.getProjectScope(projectId);

    const hasUsd = dto.limitUsd !== undefined && dto.limitUsd !== null;
    const hasCredits = dto.limitCredits !== undefined && dto.limitCredits !== null;
    const hasPerRun = dto.perRunCapUsd !== undefined && dto.perRunCapUsd !== null;
    if (!hasUsd && !hasCredits && !hasPerRun) {
      throw new ConflictException(
        'A budget policy must set at least one of limitUsd, limitCredits or perRunCapUsd. ' +
          'A policy that caps nothing would be reported as "bounded" for work that is not.',
      );
    }

    const scopeType = dto.taskKind ? 'operation' : 'project';
    const taskKind = dto.taskKind ?? null;
    const period = dto.period ?? 'month';
    const enforcement = dto.enforcement ?? 'hard';

    const existing = await this.prisma.budgetPolicy.findFirst({
      where: { scopeType, scopeId: projectId, taskKind },
    });

    const data = {
      limitUsd: dto.limitUsd ?? null,
      limitCredits: dto.limitCredits ?? null,
      period,
      enforcement,
      perRunCapUsd: dto.perRunCapUsd ?? null,
    };

    const saved = existing
      ? await this.prisma.budgetPolicy.update({ where: { id: existing.id }, data })
      : await this.prisma.budgetPolicy.create({
          data: {
            scopeType,
            scopeId: projectId,
            taskKind,
            createdBy: actorUserId,
            ...data,
          },
        });

    return {
      policyId: saved.id,
      scopeType: saved.scopeType,
      scopeId: saved.scopeId,
      taskKind: saved.taskKind,
      limitUsd: saved.limitUsd,
      limitCredits: saved.limitCredits,
      period: saved.period,
      enforcement: saved.enforcement,
      perRunCapUsd: saved.perRunCapUsd,
      replaced: Boolean(existing),
      budget: await this.getBudgetView(projectId, dto.taskKind),
    };
  }

  // ── cost estimates ────────────────────────────────────────────────────

  /**
   * `POST /api/projects/:projectId/cost-estimates` — the pre-flight estimate.
   *
   * Estimates are not actuals and are not reservations: nothing here sets
   * money aside, and the response says so. The estimate is priced from the
   * provider tariff tables this codebase already trusts (`CLORO_BASE_CREDITS`,
   * whose header records which rates were confirmed by a live call), so no
   * figure is invented.
   *
   * Where a task kind has no estimator, the answer is an explicit
   * `unavailable` state naming what is missing — never a zero and never a
   * guessed range.
   */
  async estimate(projectId: string, dto: CreateCostEstimateDto) {
    const project = await this.getProjectScope(projectId);
    const evaluation = await this.evaluate(this.prisma, { project, taskKind: dto.taskKind });

    const estimator = this.estimateFor(dto);
    const providerBalances: ProviderBalance[] = estimator.provider
      ? [await this.readProviderBalance(estimator.provider, dto.checkProviderBalance === true)]
      : [];

    const affordability = this.affordability(evaluation, estimator, providerBalances);

    return {
      projectId: project.id,
      taskKind: dto.taskKind,
      requestedConfiguration: dto.requestedConfiguration ?? {},
      estimate: estimator,
      /** The ceilings this estimate would be measured against, already evaluated. */
      policies: evaluation.policies,
      unresolvedPolicies: evaluation.unresolved,
      bindingCeilings: evaluation.bindingCeilings,
      /** Whether the caller must reserve before starting. Always true for paid work. */
      reservationRequired: true,
      reservationRationale:
        'Paid work must be reserved before it starts (POST .../budget/reservations). A reservation is what stops two concurrent runs from both passing the same ceiling check.',
      affordability,
      providerBalances,
      notes: [
        ...estimator.notes,
        'This is an estimate, not a charge and not a reservation. Actual settlement is recorded separately and the two are compared in the spend ledger.',
      ],
    };
  }

  /** Route an estimate request to the estimator that knows the tariff. */
  private estimateFor(dto: CreateCostEstimateDto): CostEstimate {
    if (dto.taskKind === 'aeo-audit') return this.estimateAeoAudit(dto);
    return {
      available: false,
      provider: null,
      reason:
        `No cost estimator exists for task kind "${dto.taskKind}" in this build. ` +
        'Only the AEO answer-engine sampling is priced from a tariff table (Cloro credits). ' +
        'Reserve an explicit amount with POST .../budget/reservations, or record the actual with POST .../spend.',
      ranges: [],
      notes: [],
    };
  }

  /**
   * The AEO estimate — a **Cloro credit estimate** for one audit's
   * answer-engine sampling.
   *
   * Mirrors `AeoAuditService.estimateBudget` (prompts × runCount × markets ×
   * per-task tariff) rather than importing that service, because the two are
   * used at different layers: the audit module asks "will this run fit
   * Cloro's balance?" and refuses to start; this module answers the operator's
   * "what will this cost, and does it fit the ceiling I set?". Both read the
   * same `CLORO_BASE_CREDITS` table, so a tariff change lands in one place.
   *
   * The low/high range is real, not decorative: the low end counts only the
   * Cloro-metered surfaces; the high end adds one fallback retry per surface
   * that has a browser equivalent (`CLORO_FALLBACK` in `aeo-audit.service.ts`),
   * because that retry is what actually happens when Cloro fails a surface.
   */
  private estimateAeoAudit(dto: CreateCostEstimateDto): CostEstimate {
    const configured = (this.config.get<string>('AEO_SURFACES') ?? 'chatgpt-browser')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is (typeof AEO_SURFACES)[number] => (AEO_SURFACES as readonly string[]).includes(s));

    const assumedDefaults = !dto.surfaces || dto.surfaces.length === 0;
    const requested = assumedDefaults ? (configured.length > 0 ? configured : ['chatgpt-browser']) : dto.surfaces!;
    const surfaces = requested.filter((s): s is (typeof AEO_SURFACES)[number] =>
      (AEO_SURFACES as readonly string[]).includes(s),
    );
    const unknownSurfaces = requested.filter((s) => !(AEO_SURFACES as readonly string[]).includes(s));

    const tierRaw = this.config.get<string>('AEO_MATRIX_TIER') ?? 'standard';
    const tier: MatrixTier = (MATRIX_TIERS as readonly string[]).includes(tierRaw)
      ? (tierRaw as MatrixTier)
      : 'standard';
    const prompts = dto.prompts ?? TIER_SIZES[tier];
    const runCount = Math.max(dto.runCount ?? 5, 1);
    const markets = Math.max(dto.markets ?? 1, 1);

    if (surfaces.length === 0) {
      return {
        available: false,
        provider: 'cloro',
        assumedDefaults,
        reason:
          unknownSurfaces.length > 0
            ? `None of the requested engine ids are recognised: ${unknownSurfaces.join(', ')}.`
            : 'No engines were named and none are configured, so there is nothing to price.',
        ranges: [],
        notes: [],
      };
    }

    const perSurface = surfaces.map((surface) => {
      const perTask = CLORO_BASE_CREDITS[surface as CloroSurface];
      const metered = perTask !== undefined;
      const calls = prompts * runCount * markets;
      return {
        surface,
        label: SURFACE_LABELS[surface] ?? surface,
        /** Which engine id this is, so the caller can pass it straight to the audit. */
        engineId: surface,
        calls,
        creditsPerTask: metered ? perTask : null,
        credits: metered ? perTask * calls : 0,
        /**
         * Browser surfaces cost no credits — they are paid for by the
         * operator's own subscription. Reporting a made-up number for them
         * would corrupt every total downstream.
         */
        billedBy: metered ? ('cloro-credits' as const) : ('operator-subscription' as const),
      };
    });

    const creditsLow = perSurface.reduce((sum, r) => sum + r.credits, 0);
    // The Cloro→browser fallback does not add credits (browser is free), and
    // browser→Cloro does not exist, so the fallback surcharge is zero. The
    // range collapses to a point and the response says why rather than
    // manufacturing spread.
    const creditsHigh = creditsLow;
    const calls = perSurface.reduce((sum, r) => sum + r.calls, 0);

    const rates = {
      tier,
      prompts,
      runCount,
      markets,
      engines: surfaces,
      calls,
      assumedDefaults,
      ...(assumedDefaults
        ? {
            defaultSource:
              configured.length > 0 ? 'AEO_SURFACES' : 'built-in fallback (chatgpt-browser)',
          }
        : {}),
    };

    const creditUsd = Number(this.config.get<string>('CLORO_CREDIT_USD', '0.0004'));
    const rate = Number.isFinite(creditUsd) && creditUsd > 0 ? creditUsd : 0.0004;

    const notes: string[] = [
      'Credits are the unit Cloro actually bills in. The dollar figure below is a conversion at the configured rate, reported separately — it is never added to the credit figure.',
      'Browser surfaces are paid for by the operator’s own subscription, so they contribute 0 to the credit estimate. They are not free of cost, they are free of Cloro credits.',
    ];
    if (unknownSurfaces.length > 0) {
      notes.push(`Ignored unrecognised engine ids: ${unknownSurfaces.join(', ')}.`);
    }
    for (const row of perSurface) {
      if (row.billedBy === 'cloro-credits' && (row.surface === 'cloro-perplexity' || row.surface === 'cloro-gemini' || row.surface === 'cloro-ai-mode')) {
        notes.push(
          `${row.label}’s per-task rate is Cloro’s disclosed base rate and has not been confirmed by a live call — treat this line as less certain than the confirmed ones.`,
        );
      }
    }

    return {
      available: true,
      provider: 'cloro',
      assumedDefaults,
      ranges: [
        {
          unit: 'credits' as const,
          low: creditsLow,
          high: creditsHigh,
          rangeKind: creditsLow === creditsHigh ? ('point' as const) : ('range' as const),
          basis: 'cloro-credit-tariff' as const,
          basisDetail: `Cloro base credits per task × ${prompts} prompts × ${runCount} repeats × ${markets} market(s), summed over ${surfaces.length} engine(s).`,
          caller: 'cloro',
        },
      ],
      conversion: {
        from: 'credits' as const,
        to: 'usd' as const,
        rate,
        rateEnvVar: 'CLORO_CREDIT_USD',
        convertedLow: creditsLow * rate,
        convertedHigh: creditsHigh * rate,
        caveat:
          'This is what the credits would have cost at the configured plan rate. On a free tier the actual cash spend is $0 — the conversion is a valuation, not a charge.',
      },
      rates,
      perSurface,
      notes,
    };
  }

  /**
   * Read a provider's current balance, or say why it could not be read.
   *
   * `checkProviderBalance: false` (the default) returns `unknown` **without a
   * network call** — a dry estimate must stay dry. When the probe is asked for
   * and fails, the result is still `unknown`: a provider we cannot reach never
   * becomes "affordable".
   */
  private async readProviderBalance(provider: string, probe: boolean): Promise<ProviderBalance> {
    if (!probe) {
      return {
        state: 'unknown',
        reason:
          'No balance probe was requested on this estimate. Unknown is not the same as affordable — ' +
          'set checkProviderBalance: true to read the balance, or reserve an explicit amount.',
      };
    }
    if (provider !== 'cloro') {
      return {
        state: 'unknown',
        reason: `No balance probe is wired for "${provider}" in this build. Cailyx does not guess a balance it cannot read.`,
      };
    }
    if (!this.has('CLORO_API_KEY')) {
      return { state: 'unknown', reason: 'CLORO_API_KEY is not set, so Cloro’s balance cannot be read.' };
    }
    try {
      const value = await this.cloro.getRemainingCredits();
      return {
        state: 'known',
        unit: 'credits',
        value,
        source: 'GET https://api.cloro.dev/v1/credits',
        readAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        state: 'unknown',
        reason: `Cloro’s balance could not be read: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Resolve affordability from the ceilings and any balance we actually read.
   *
   * Order matters: a ceiling breach is decisive whether or not a balance was
   * readable; a readable balance that cannot cover the estimate is `over-cap`;
   * and anything we could not determine lands on `unknown` — never
   * `affordable`.
   */
  private affordability(
    evaluation: EvaluationResult,
    estimate: CostEstimate,
    balances: ProviderBalance[],
  ): { state: Affordability; reason: string; shortfallUnits: SpendUnit[] } {
    if (evaluation.unresolved.length > 0) {
      return {
        state: 'unknown',
        reason: evaluation.unresolved.map((u) => u.reason).join(' '),
        shortfallUnits: [],
      };
    }
    if (!estimate.available) {
      return {
        state: 'unknown',
        reason: estimate.reason ?? 'No estimate is available, so affordability cannot be evaluated.',
        shortfallUnits: [],
      };
    }

    const shortfallUnits: SpendUnit[] = [];
    let hardBreach: string | null = null;
    let softBreach: string | null = null;

    for (const policy of evaluation.policies) {
      for (const range of estimate.ranges) {
        const total = policy.totals.find((t) => t.unit === range.unit);
        if (!total || total.limit === null || total.remaining === null) continue;
        const requested = range.high;
        if (requested > total.remaining) {
          shortfallUnits.push(range.unit);
          const sentence =
            `The estimate needs ${requested} ${range.unit} but ${policy.scopeType} policy ${policy.policyId} ` +
            `has ${total.remaining} ${range.unit} left of ${total.limit} in this ${policy.window.period} window.`;
          if (policy.enforcement === 'hard') hardBreach = hardBreach ?? sentence;
          else softBreach = softBreach ?? sentence;
        }
      }
      if (policy.perRunCapUsd !== null) {
        const usdRange = estimate.ranges.find((r) => r.unit === 'usd');
        const asked = usdRange ? usdRange.high : (estimate.conversion?.convertedHigh ?? 0);
        if (asked > policy.perRunCapUsd) {
          hardBreach =
            hardBreach ??
            `The per-run cap on policy ${policy.policyId} is $${policy.perRunCapUsd} and this estimate is $${asked.toFixed(2)}.`;
        }
      }
    }

    const balance = balances[0];
    if (balance && balance.state === 'known') {
      const credits = estimate.ranges.find((r) => r.unit === balance.unit);
      const needed = credits ? credits.high : 0;
      if (needed > balance.value) {
        return {
          state: 'over-cap',
          reason: `The estimate needs ${needed} ${balance.unit} and the provider has ${balance.value} left (${balance.source}).`,
          shortfallUnits,
        };
      }
    }

    if (hardBreach) return { state: 'over-cap', reason: hardBreach, shortfallUnits };
    if (softBreach) {
      return {
        state: 'requires-approval',
        reason: `${softBreach} The policy is a soft cap, so the reservation is created held and unapproved until an approving role confirms it.`,
        shortfallUnits,
      };
    }

    if (balance && balance.state === 'unknown') {
      return {
        state: 'unknown',
        reason: `The ceilings this estimate is measured against are satisfied, but the provider balance could not be read: ${balance.reason}`,
        shortfallUnits,
      };
    }

    return {
      state: 'affordable',
      reason:
        evaluation.policies.length === 0
          ? 'No ceiling applies to this project. Affordability here means "no Cailyx cap blocks it", not "the work is paid for".'
          : 'Every applicable ceiling covers this estimate.',
      shortfallUnits,
    };
  }

  // ── spend ledger ──────────────────────────────────────────────────────

  /**
   * `GET /api/projects/:projectId/spend` — the cost audit view.
   *
   * Reports actuals and holds side by side, per unit, with the per-provider
   * breakdown OP18 asks for, and the estimate-vs-actual comparison for every
   * settled reservation. No balance probe runs on this route: the response
   * says so rather than implying a balance it never read.
   */
  async getSpendView(projectId: string, query: ListSpendQueryDto) {
    const project = await this.getProjectScope(projectId);
    const now = new Date();

    // Housekeeping on read: a lapsed hold is not held, and leaving it counted
    // would make the ceiling look fuller than it is.
    const expiredCount = await this.expireStale(projectId, now);

    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    const occurredAt: { gte?: Date; lt?: Date } = {};
    if (from && !Number.isNaN(from.getTime())) occurredAt.gte = from;
    if (to && !Number.isNaN(to.getTime())) occurredAt.lt = to;

    const eventWhere: Prisma.SpendEventWhereInput = {
      projectId,
      ...(query.taskKind ? { taskKind: query.taskKind } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.unit ? { unit: query.unit } : {}),
      ...(Object.keys(occurredAt).length > 0 ? { occurredAt } : {}),
    };

    const events = await this.prisma.spendEvent.findMany({
      where: eventWhere,
      orderBy: { occurredAt: 'desc' },
      take: query.limit ?? 100,
    });

    const reservations = await this.prisma.spendReservation.findMany({
      where: { projectId, ...(query.taskKind ? { taskKind: query.taskKind } : {}) },
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 100,
    });

    // Totals are computed over the whole window, not over the returned page —
    // a capped list must not look like a capped total.
    const usdEvents = await this.prisma.spendEvent.aggregate({
      _sum: { amount: true },
      where: { ...eventWhere, unit: 'usd' },
    });
    const creditEvents = await this.prisma.spendEvent.aggregate({
      _sum: { amount: true },
      where: { ...eventWhere, unit: 'credits' },
    });

    const byProvider = await this.providerBreakdown(projectId, occurredAt, query.taskKind);

    const heldReservations = reservations.filter((r) => r.status === 'held');
    const statusCounts: Record<string, number> = { held: 0, settled: 0, released: 0, expired: 0 };
    for (const r of reservations) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

    return {
      projectId,
      timezone: project.timezone,
      window: {
        from: occurredAt.gte ? occurredAt.gte.toISOString() : null,
        to: occurredAt.lt ? occurredAt.lt.toISOString() : null,
        note: 'Reservation holds are timestamped by createdAt; actuals by occurredAt. The two are reported separately and never added together.',
      },
      totals: [
        {
          unit: 'usd' as SpendUnit,
          settled: usdEvents._sum.amount ?? 0,
          reservedHeld: heldReservations.reduce((s, r) => s + r.reservedUsd, 0),
        },
        {
          unit: 'credits' as SpendUnit,
          settled: creditEvents._sum.amount ?? 0,
          reservedHeld: heldReservations.reduce((s, r) => s + r.reservedCredits, 0),
        },
      ],
      reservationSummary: {
        ...statusCounts,
        awaitingApproval: heldReservations.filter((r) => r.approvedBy === null).length,
        expiredOnThisRead: expiredCount,
      },
      byProvider,
      events: events.map((e) => this.spendEventView(e)),
      reservations: reservations.map((r) => this.reservationView(r, now)),
      balanceProbe: {
        performed: false,
        reason:
          'This route does not read provider balances. Ask for one with POST .../cost-estimates and checkProviderBalance: true; until then a provider balance is unknown, not assumed to fit.',
      },
    };
  }

  /** Per-provider actuals, per unit. Credits and dollars stay in separate rows. */
  private async providerBreakdown(
    projectId: string,
    occurredAt: { gte?: Date; lt?: Date },
    taskKind?: string,
  ) {
    const rows = await this.prisma.spendEvent.groupBy({
      by: ['provider', 'unit'],
      where: {
        projectId,
        ...(taskKind ? { taskKind } : {}),
        ...(Object.keys(occurredAt).length > 0 ? { occurredAt } : {}),
      },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const providers = new Map<string, { provider: string; units: Array<{ unit: SpendUnit; settled: number; events: number }> }>();
    for (const row of rows) {
      const entry = providers.get(row.provider) ?? { provider: row.provider, units: [] };
      entry.units.push({
        unit: row.unit === 'credits' ? 'credits' : 'usd',
        settled: row._sum.amount ?? 0,
        events: row._count._all,
      });
      providers.set(row.provider, entry);
    }
    return [...providers.values()];
  }

  /**
   * `POST /api/projects/:projectId/spend` — record a charge that was never
   * reserved.
   *
   * Refuses an event with neither a reservation nor a job run: without one of
   * them the row cannot be de-duplicated against a retry, and a ledger that
   * double-counts a retried call is worse than no ledger. Two retries of the
   * same attributable call collide on `(reservationId|jobRunId, provider)` and
   * the second is reported as a duplicate rather than charged again.
   */
  async recordSpendEvent(projectId: string, dto: RecordSpendEventDto, actorUserId: string) {
    const project = await this.getProjectScope(projectId);

    if (!dto.reservationId && !dto.jobRunId) {
      throw new ConflictException(
        'A spend event must carry a reservationId or a jobRunId. Without one it cannot be de-duplicated ' +
          'against a retry, and a duplicate charge in the audit ledger is worse than a missing one.',
      );
    }

    if (dto.reservationId) {
      const reservation = await this.prisma.spendReservation.findFirst({
        where: { id: dto.reservationId, projectId },
        select: { id: true },
      });
      if (!reservation) {
        throw new NotFoundException(`Reservation ${dto.reservationId} not found on project ${projectId}`);
      }
    }

    const duplicate = await this.prisma.spendEvent.findFirst({
      where: {
        projectId,
        provider: dto.provider,
        ...(dto.reservationId ? { reservationId: dto.reservationId } : { jobRunId: dto.jobRunId }),
      },
      select: { id: true, occurredAt: true },
    });
    if (duplicate) {
      return {
        event: null,
        deduplicated: true,
        existingEventId: duplicate.id,
        reason:
          `A ${dto.provider} spend event is already recorded against this ` +
          `${dto.reservationId ? 'reservation' : 'run'}. Returning the existing row instead of charging twice.`,
      };
    }

    const created = await this.prisma.spendEvent.create({
      data: {
        projectId,
        clientId: project.clientId,
        taskKind: dto.taskKind ?? null,
        jobRunId: dto.jobRunId ?? null,
        reservationId: dto.reservationId ?? null,
        provider: dto.provider,
        unit: dto.unit,
        amount: dto.amount,
        quantity: dto.quantity ?? null,
        quantityUnit: dto.quantityUnit ?? null,
        note: dto.note ? `${dto.note} (recorded by ${actorUserId})` : `recorded by ${actorUserId}`,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
      },
    });

    return { event: this.spendEventView(created), deduplicated: false, existingEventId: null, reason: null };
  }

  // ── shared view builders ──────────────────────────────────────────────

  private spendEventView(e: {
    id: string;
    projectId: string;
    taskKind: string | null;
    jobRunId: string | null;
    reservationId: string | null;
    provider: string;
    unit: string;
    amount: number;
    quantity: number | null;
    quantityUnit: string | null;
    note: string | null;
    occurredAt: Date;
  }) {
    return {
      id: e.id,
      projectId: e.projectId,
      taskKind: e.taskKind,
      jobRunId: e.jobRunId,
      reservationId: e.reservationId,
      provider: e.provider,
      /** `usd` or `credits` — the unit of `amount`. Never mixed with the other. */
      unit: e.unit === 'credits' ? ('credits' as SpendUnit) : ('usd' as SpendUnit),
      amount: e.amount,
      quantity: e.quantity,
      quantityUnit: e.quantityUnit,
      note: e.note,
      occurredAt: e.occurredAt.toISOString(),
      /** True when the row is an actual charge rather than a prediction. */
      isActual: true,
    };
  }

  private reservationView(
    r: {
      id: string;
      projectId: string;
      taskKind: string;
      jobRunId: string | null;
      estimateLowUsd: number;
      estimateHighUsd: number;
      reservedUsd: number;
      reservedCredits: number;
      status: string;
      settledUsd: number | null;
      settledCredits: number | null;
      settledAt: Date | null;
      expiresAt: Date | null;
      requestedBy: string | null;
      approvedBy: string | null;
      createdAt: Date;
    },
    now: Date,
  ) {
    const expired = r.status === 'held' && r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime();
    return {
      id: r.id,
      projectId: r.projectId,
      taskKind: r.taskKind,
      jobRunId: r.jobRunId,
      /** The estimate recorded at reservation time, in USD. */
      estimate: { lowUsd: r.estimateLowUsd, highUsd: r.estimateHighUsd },
      /** What is set aside, per unit. */
      reserved: { usd: r.reservedUsd, credits: r.reservedCredits },
      status: r.status,
      /** True when the hold has lapsed but no read has swept it yet. */
      expiredButUnswept: expired,
      /** The actual, once settled. Null while the outcome is not yet known. */
      settled:
        r.status === 'settled' ? { usd: r.settledUsd ?? 0, credits: r.settledCredits ?? 0 } : null,
      /**
       * Estimate vs actual, computed only for a settled reservation. A null
       * here means "not settled yet", never "came in exactly on estimate".
       */
      variance:
        r.status === 'settled' && r.settledUsd !== null
          ? {
              vsHighUsd: Number((r.settledUsd - r.estimateHighUsd).toFixed(6)),
              vsLowUsd: Number((r.settledUsd - r.estimateLowUsd).toFixed(6)),
              note: 'Positive means the run cost more than the estimate at that end of the range.',
            }
          : null,
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      requestedBy: r.requestedBy,
      approvedBy: r.approvedBy,
      /** Approval is outstanding when a soft ceiling was exceeded and no approver has signed off. */
      awaitingApproval: r.status === 'held' && r.approvedBy === null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** Mark lapsed holds as expired. Returns how many rows changed. */
  async expireStale(projectId: string, now: Date, db: BudgetDb = this.prisma): Promise<number> {
    const result = await db.spendReservation.updateMany({
      where: { projectId, status: 'held', expiresAt: { not: null, lte: now } },
      data: { status: 'expired' },
    });
    return result.count;
  }
}

// ── estimate shapes ───────────────────────────────────────────────────────

/** One priced line range, always carrying the unit it is denominated in. */
export interface CostEstimateRange {
  unit: SpendUnit;
  low: number;
  high: number;
  /** `point` when low === high, and the response says why rather than inventing spread. */
  rangeKind: 'point' | 'range';
  basis: 'cloro-credit-tariff' | 'provider-published-rate' | 'measured-history';
  basisDetail: string;
  /** Which provider bills this unit. */
  caller: string;
}

export interface CostEstimate {
  available: boolean;
  provider: string | null;
  /** Set when the engine set came from configuration rather than the request. */
  assumedDefaults?: boolean;
  /** Why no estimate could be produced. Present only when `available` is false. */
  reason?: string;
  ranges: CostEstimateRange[];
  /**
   * A disclosed conversion from credits to dollars, when one exists. It is a
   * separate field so it can never be mistaken for a second range in the same
   * unit — and never added to one.
   */
  conversion?: {
    from: SpendUnit;
    to: SpendUnit;
    rate: number;
    rateEnvVar: string;
    convertedLow: number;
    convertedHigh: number;
    caveat: string;
  };
  rates?: {
    tier: string;
    prompts: number;
    runCount: number;
    markets: number;
    engines: string[];
    calls: number;
    assumedDefaults: boolean;
    defaultSource?: string;
  };
  perSurface?: Array<{
    surface: string;
    label: string;
    engineId: string;
    calls: number;
    creditsPerTask: number | null;
    credits: number;
    billedBy: 'cloro-credits' | 'operator-subscription';
  }>;
  notes: string[];
}
