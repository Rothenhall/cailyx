/**
 * CadenceService — G07: recurring schedules per project and task kind.
 *
 * Why this is DB-driven rather than a BullMQ repeatable job: a schedule is a
 * commitment about *the project*, and the only durable place to keep it is the
 * database. A repeatable job lives in Redis, which this deployment treats as
 * cache/transport (it is not configured for persistence) — a Redis restart
 * would silently drop every client's schedule, and nothing in the ledger would
 * show that it had. `CadenceRule.nextRunAt` survives everything.
 *
 * Four semantics this file is responsible for (G07 requirement 6):
 *
 * - a `pausedAt` rule does not tick, and neither does a rule whose funding
 *   engagement is paused;
 * - a tick whose `prerequisites` are not ready is **skipped with the reason
 *   recorded** in `lastError`, not failed loudly every night;
 * - `nextRunAt` is computed in the rule's own `timezone` (see
 *   `lib/cadence-schedule.util`), derived fresh from the rule each time rather
 *   than incremented from `lastRunAt`, so a late tick or a DST change does not
 *   drift the schedule;
 * - a duplicate tick for the same due instant is recognised by its
 *   deterministic idempotency key and recorded as a duplicate — it never
 *   starts a second run.
 *
 * @module cadence.service
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { CadenceRule } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { JobsService } from './jobs.service';
import {
  isValidTimeZone,
  needsDayOfMonth,
  needsDayOfWeek,
  nextRunAt as computeNextRunAt,
} from './lib/cadence-schedule.util';
import type { CadenceRuleDto } from './jobs.types';
import { CADENCE_FREQUENCIES, TASK_KINDS, type CadenceFrequency } from './jobs.types';
import type { PutCadenceDto, RunCadenceNowDto } from './dto/cadence.dto';

/** What happened when a rule was ticked. */
export interface TickOutcome {
  projectId: string;
  taskKind: string;
  /** started = a run was created; duplicate = that run already existed; skipped = deliberately not started. */
  outcome: 'started' | 'duplicate' | 'skipped' | 'not_due' | 'locked';
  reason: string | null;
  jobRunId: string | null;
  nextRunAt: string | null;
}

export interface TickReport {
  checked: number;
  started: number;
  skipped: number;
  duplicates: number;
  outcomes: TickOutcome[];
}

/** Prerequisite evaluation result, with the reason a tick would be skipped. */
export interface PrerequisiteState {
  ready: boolean;
  /** Human-readable reasons, one per unmet prerequisite. Empty when ready. */
  unmet: string[];
}

/** Env-var integer with a fallback, so a typo cannot yield NaN. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Parse a JSON string[] column, tolerating a hand-edited/corrupt row. */
function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Parse a JSON object column, tolerating a hand-edited/corrupt row. */
function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

@Injectable()
export class CadenceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CadenceService.name);

  /**
   * How often the scheduler looks for due rules. In-process, so this assumes a
   * single API instance — the same assumption `SchedulingService` already
   * makes. A multi-instance deployment should move this loop behind the
   * existing BullMQ repeatable-job path; the rules themselves are already
   * safe to tick concurrently (see `tickRule`'s idempotency key).
   */
  private readonly tickIntervalMs = envInt('CADENCE_TICK_MS', 60_000);

  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    if (this.tickIntervalMs > 0) {
      this.tickTimer = setInterval(() => {
        void this.tickSafely();
      }, this.tickIntervalMs);
      this.tickTimer.unref?.();
      this.logger.log(`Cadence scheduler started — checking due rules every ${this.tickIntervalMs}ms`);
    } else {
      this.logger.log('Cadence scheduler disabled (CADENCE_TICK_MS=0) — rules can still be ticked manually');
    }
  }

  onModuleDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
  }

  /** Guarded sweep: a slow tick must not stack up behind the next one. */
  private async tickSafely(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const report = await this.tickDueRules();
      if (report.started > 0 || report.outcomes.some((o) => o.outcome === 'locked')) {
        this.logger.log(
          `Cadence tick: ${report.checked} due, ${report.started} started, ${report.duplicates} duplicate(s), ${report.skipped} skipped`,
        );
      }
    } catch (err) {
      this.logger.warn(`Cadence tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  // ── Reads / writes ────────────────────────────────────────────────────

  /**
   * Every supported task kind, with its rule when one is configured.
   *
   * Kinds with no row are still listed, marked `configured: false` with the
   * documented defaults — an absent schedule is a real state the UI has to
   * show, and it is not the same thing as a stored `off` rule.
   */
  async listCadences(projectId: string): Promise<{ cadences: CadenceRuleDto[] }> {
    const project = await this.requireProject(projectId);
    const rules = await this.prisma.cadenceRule.findMany({ where: { projectId } });
    const byKind = new Map(rules.map((r) => [r.taskKind, r]));
    const cadences = TASK_KINDS.map((taskKind) =>
      this.toDto(byKind.get(taskKind) ?? null, projectId, taskKind, project.timezone),
    );
    return { cadences };
  }

  /** One rule. An unconfigured kind returns its defaults with `configured: false`. */
  async getCadence(projectId: string, taskKind: string): Promise<CadenceRuleDto> {
    this.assertTaskKind(taskKind);
    const project = await this.requireProject(projectId);
    const rule = await this.prisma.cadenceRule.findUnique({
      where: { projectId_taskKind: { projectId, taskKind } },
    });
    return this.toDto(rule, projectId, taskKind, project.timezone);
  }

  /**
   * Create or replace a rule, then recompute `nextRunAt` in the rule's own
   * timezone. Validation is deliberately strict about the anchors: a weekly
   * rule with no weekday, or a monthly rule with no day, is rejected rather
   * than silently defaulted into a schedule nobody asked for.
   */
  async putCadence(projectId: string, taskKind: string, dto: PutCadenceDto): Promise<CadenceRuleDto> {
    this.assertTaskKind(taskKind);
    const project = await this.requireProject(projectId);
    const existing = await this.prisma.cadenceRule.findUnique({
      where: { projectId_taskKind: { projectId, taskKind } },
    });

    const frequency = (dto.frequency ?? existing?.frequency ?? 'off') as CadenceFrequency;
    if (!CADENCE_FREQUENCIES.includes(frequency)) {
      throw new BadRequestException(`frequency must be one of: ${CADENCE_FREQUENCIES.join(', ')}`);
    }

    const timezone = dto.timezone ?? existing?.timezone ?? project.timezone ?? 'UTC';
    if (!isValidTimeZone(timezone)) {
      throw new BadRequestException(`"${timezone}" is not a recognized IANA timezone (e.g. Europe/London).`);
    }

    const dayOfWeek = dto.dayOfWeek ?? existing?.dayOfWeek ?? null;
    const dayOfMonth = dto.dayOfMonth ?? existing?.dayOfMonth ?? null;
    if (needsDayOfWeek(frequency) && dayOfWeek === null) {
      throw new BadRequestException(`frequency "${frequency}" needs dayOfWeek (0-6, Sunday = 0).`);
    }
    if (needsDayOfMonth(frequency) && dayOfMonth === null) {
      throw new BadRequestException(`frequency "${frequency}" needs dayOfMonth (1-31).`);
    }

    const hour = dto.hour ?? existing?.hour ?? 3;
    const enabled = dto.enabled ?? existing?.enabled ?? false;
    const pausing = dto.paused === true;
    const params = dto.params ?? parseJsonObject(existing?.params);
    const prerequisites = dto.prerequisites ?? parseJsonArray(existing?.prerequisites);
    const maxCostUsd = dto.maxCostUsd ?? existing?.maxCostUsd ?? null;

    const schedule = { frequency, dayOfWeek, dayOfMonth, hour, timezone, anchor: existing?.createdAt ?? new Date() };
    const upcoming = enabled && frequency !== 'off' ? computeNextRunAt(schedule, new Date()) : null;

    const data = {
      frequency,
      dayOfWeek,
      dayOfMonth,
      hour,
      timezone,
      enabled,
      params: JSON.stringify(params),
      prerequisites: JSON.stringify(prerequisites),
      maxCostUsd,
      nextRunAt: upcoming,
      // Pausing is sticky in the schema (it records *when*), so it is set once
      // and cleared explicitly — a PUT that does not mention `paused` leaves an
      // existing pause alone rather than quietly resuming a paused client.
      ...(pausing && !existing?.pausedAt ? { pausedAt: new Date() } : {}),
      ...(dto.paused === false ? { pausedAt: null } : {}),
    };

    const saved = await this.prisma.cadenceRule.upsert({
      where: { projectId_taskKind: { projectId, taskKind } },
      create: { projectId, taskKind, ...data },
      update: data,
    });
    return this.toDto(saved, projectId, taskKind, project.timezone);
  }

  // ── Ticking ───────────────────────────────────────────────────────────

  /**
   * Tick every rule that is due. Called by the scheduler loop; safe to call
   * manually (the tests/admin path) and safe to call twice — the second call
   * finds the same rules already advanced and the same idempotency keys
   * already used.
   */
  async tickDueRules(now: Date = new Date()): Promise<TickReport> {
    const due = await this.prisma.cadenceRule.findMany({
      where: {
        enabled: true,
        pausedAt: null,
        OR: [{ nextRunAt: { lte: now } }, { nextRunAt: null }],
      },
      orderBy: { nextRunAt: 'asc' },
      take: 100,
    });

    const outcomes: TickOutcome[] = [];
    for (const rule of due) {
      // A rule that was enabled but never scheduled gets its first nextRunAt
      // now — it does not fire retroactively for a time nobody agreed to.
      if (!rule.nextRunAt) {
        const upcoming = computeNextRunAt(this.scheduleOf(rule), now);
        await this.prisma.cadenceRule.update({ where: { id: rule.id }, data: { nextRunAt: upcoming } });
        outcomes.push({
          projectId: rule.projectId,
          taskKind: rule.taskKind,
          outcome: 'not_due',
          reason: 'Rule had no nextRunAt yet — scheduled from now; it will fire at that time.',
          jobRunId: null,
          nextRunAt: upcoming ? upcoming.toISOString() : null,
        });
        continue;
      }
      outcomes.push(await this.tickRule(rule, now));
    }

    return {
      checked: due.length,
      started: outcomes.filter((o) => o.outcome === 'started').length,
      skipped: outcomes.filter((o) => o.outcome === 'skipped').length,
      duplicates: outcomes.filter((o) => o.outcome === 'duplicate').length,
      outcomes,
    };
  }

  /**
   * Tick one rule.
   *
   * The idempotency key is derived from the rule and the instant the tick was
   * *due* — not from the moment the sweep happened to run — so two sweeps that
   * both see the same overdue rule produce one run, and the second records a
   * duplicate instead of buying the same data twice.
   */
  async tickRule(
    rule: CadenceRule,
    now: Date = new Date(),
    opts: { force?: boolean; overridePrerequisites?: boolean; actorUserId?: string; reason?: string } = {},
  ): Promise<TickOutcome> {
    const base: TickOutcome = {
      projectId: rule.projectId,
      taskKind: rule.taskKind,
      outcome: 'skipped',
      reason: null,
      jobRunId: null,
      nextRunAt: rule.nextRunAt ? rule.nextRunAt.toISOString() : null,
    };

    if (!rule.enabled && !opts.force) {
      return { ...base, reason: 'Rule is disabled.' };
    }
    if (rule.pausedAt && !opts.force) {
      return { ...base, reason: `Rule is paused since ${rule.pausedAt.toISOString()}.` };
    }
    if (rule.nextRunAt && rule.nextRunAt > now && !opts.force) {
      return { ...base, outcome: 'not_due', reason: `Next run is ${rule.nextRunAt.toISOString()}.` };
    }
    if (rule.frequency === 'off' && !opts.force) {
      return { ...base, reason: 'Frequency is "off" — this rule is manual-only.' };
    }

    const paused = await this.pausedEngagement(rule.projectId);
    if (paused) {
      // Recorded, not thrown: the client being paused is a normal state, and
      // the rule resumes by itself when the engagement does.
      const reason = `Skipped: engagement "${paused.name}" is paused (since ${paused.pausedAt ? paused.pausedAt.toISOString() : 'an unrecorded time'}).`;
      await this.recordSkip(rule.id, reason);
      return { ...base, reason };
    }

    const prereq = await this.evaluatePrerequisites(rule);
    if (!prereq.ready && !opts.overridePrerequisites) {
      const reason = `Skipped: prerequisites not ready — ${prereq.unmet.join('; ')}.`;
      await this.recordSkip(rule.id, reason);
      return { ...base, reason };
    }

    // The instant this tick is *for*. A forced (manual) tick has no schedule
    // to share, so it is keyed on now — two manual presses are two runs.
    const scheduledFor = opts.force || !rule.nextRunAt ? now : rule.nextRunAt;
    const key = `cadence:${rule.id}:${scheduledFor.toISOString()}`;

    const created = await this.jobs.createAndEnqueue({
      projectId: rule.projectId,
      taskKind: rule.taskKind,
      idempotencyKey: key,
      trigger: 'cadence',
      triggeredBy: opts.actorUserId ?? null,
      cadenceRuleId: rule.id,
      input: { ...parseJsonObject(rule.params), ...(opts.reason ? { cadenceNote: opts.reason } : {}) },
      maxCostUsd: rule.maxCostUsd,
      stage: 'queued',
    });

    const upcoming = opts.force
      ? rule.nextRunAt
      : computeNextRunAt(this.scheduleOf(rule), now);

    if (created.outcome === 'existing') {
      const reason = `Duplicate tick for ${scheduledFor.toISOString()} ignored — run ${created.run.id} already exists for this schedule slot.`;
      await this.prisma.cadenceRule.update({
        where: { id: rule.id },
        data: {
          lastStatus: 'duplicate',
          lastError: reason,
          lastJobRunId: created.run.id,
          nextRunAt: upcoming,
        },
      });
      return { ...base, outcome: 'duplicate', reason, jobRunId: created.run.id, nextRunAt: upcoming ? upcoming.toISOString() : null };
    }

    if (created.outcome === 'locked') {
      const reason = `Skipped: a run of this kind is already in flight (${created.run.id}).`;
      await this.recordSkip(rule.id, reason, upcoming);
      return { ...base, outcome: 'locked', reason, jobRunId: created.run.id, nextRunAt: upcoming ? upcoming.toISOString() : null };
    }

    // Created. Whether it actually *started* depends on a handler existing for
    // this task kind — reported honestly rather than as a silent success.
    await this.prisma.cadenceRule.update({
      where: { id: rule.id },
      data: {
        lastRunAt: now,
        lastJobRunId: created.run.id,
        lastStatus: created.requeued ? 'queued' : 'queued-not-started',
        lastError: created.requeued ? null : created.requeueBlockedReason,
        nextRunAt: upcoming,
      },
    });

    return {
      ...base,
      outcome: 'started',
      reason: created.requeued ? null : created.requeueBlockedReason,
      jobRunId: created.run.id,
      nextRunAt: upcoming ? upcoming.toISOString() : null,
    };
  }

  /**
   * An explicit operator tick: same rules as an automatic one, minus the
   * clock. Pause is still respected (running a paused client's schedule is
   * a billing decision, not a UI convenience); unmet prerequisites are
   * refused unless the caller explicitly accepts them.
   */
  async runNow(projectId: string, taskKind: string, dto: RunCadenceNowDto, actorUserId: string): Promise<TickOutcome> {
    this.assertTaskKind(taskKind);
    const rule = await this.getRuleRow(projectId, taskKind);
    if (!rule) {
      throw new NotFoundException(
        `No cadence rule exists for "${taskKind}" on project ${projectId} — configure one (PUT .../cadences/${taskKind}) before running it.`,
      );
    }
    if (rule.pausedAt) {
      throw new ConflictException(
        `The "${taskKind}" cadence is paused since ${rule.pausedAt.toISOString()}. Resume it explicitly (PUT paused: false) to run it out of band.`,
      );
    }

    const prereq = await this.evaluatePrerequisites(rule);
    if (!prereq.ready && !dto.overridePrerequisites) {
      throw new ConflictException(
        `Prerequisites are not ready: ${prereq.unmet.join('; ')}. Re-send with overridePrerequisites: true to run anyway — the run records that it was started with unmet prerequisites.`,
      );
    }
    if (!prereq.ready) {
      this.logger.warn(
        `Operator ${actorUserId} started cadence ${rule.id} (${taskKind}) with unmet prerequisites: ${prereq.unmet.join('; ')}`,
      );
    }

    const outcome = await this.tickRule(rule, new Date(), {
      force: true,
      overridePrerequisites: true,
      actorUserId,
      reason: dto.reason,
    });
    // A forced tick does not move the schedule, so put nextRunAt back as it was.
    if (rule.nextRunAt) {
      await this.prisma.cadenceRule.update({ where: { id: rule.id }, data: { nextRunAt: rule.nextRunAt } });
      outcome.nextRunAt = rule.nextRunAt.toISOString();
    }
    return outcome;
  }

  // ── Prerequisites and pause ───────────────────────────────────────────

  /**
   * Are this rule's declared prerequisites ready?
   *
   * Readiness is conservative by design (design_plan §3.5 — empty is not
   * zero): a capability key with no `CapabilityStatus` row is *unknown*, and
   * unknown is not ready. Mock mode counts as not ready, because a nightly
   * schedule running against fixtures would produce numbers that look real.
   */
  async evaluatePrerequisites(rule: { prerequisites: string }): Promise<PrerequisiteState> {
    const keys = parseJsonArray(rule.prerequisites);
    if (keys.length === 0) return { ready: true, unmet: [] };

    const rows = await this.prisma.capabilityStatus.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const unmet: string[] = [];
    for (const key of keys) {
      const row = byKey.get(key);
      if (!row) {
        unmet.push(`${key} (no capability status recorded — readiness unknown, so not assumed)`);
      } else if (!row.configured) {
        unmet.push(`${key} (not configured)`);
      } else if (row.mockMode) {
        unmet.push(`${key} (running against fixtures, not the live provider)`);
      } else if (!row.verified) {
        unmet.push(`${key} (configured, but no successful call recorded yet)`);
      }
    }
    return { ready: unmet.length === 0, unmet };
  }

  /** The engagement funding this project, when it is paused. */
  private async pausedEngagement(
    projectId: string,
  ): Promise<{ name: string; pausedAt: Date | null } | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { engagementId: true },
    });
    if (!project?.engagementId) return null;
    const engagement = await this.prisma.engagement.findUnique({
      where: { id: project.engagementId },
      select: { name: true, status: true, pausedAt: true },
    });
    if (!engagement || engagement.status !== 'paused') return null;
    return { name: engagement.name, pausedAt: engagement.pausedAt };
  }

  private scheduleOf(rule: CadenceRule) {
    return {
      frequency: rule.frequency,
      dayOfWeek: rule.dayOfWeek,
      dayOfMonth: rule.dayOfMonth,
      hour: rule.hour,
      timezone: rule.timezone,
      anchor: rule.createdAt,
    };
  }

  /**
   * Record a skip reason without touching `lastRunAt` — a skip is not a run.
   * `nextRunAt` still advances, so a rule whose prerequisite is missing is
   * re-checked on its next scheduled slot rather than every sweep.
   */
  private async recordSkip(ruleId: string, reason: string, upcoming?: Date | null): Promise<void> {
    const rule = await this.prisma.cadenceRule.findUnique({ where: { id: ruleId } });
    if (!rule) return;
    const next =
      upcoming !== undefined ? upcoming : computeNextRunAt(this.scheduleOf(rule), new Date());
    await this.prisma.cadenceRule.update({
      where: { id: ruleId },
      data: { lastStatus: 'skipped', lastError: reason, nextRunAt: next },
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private async getRuleRow(projectId: string, taskKind: string): Promise<CadenceRule | null> {
    return this.prisma.cadenceRule.findUnique({ where: { projectId_taskKind: { projectId, taskKind } } });
  }

  private assertTaskKind(taskKind: string): void {
    if (!TASK_KINDS.includes(taskKind as (typeof TASK_KINDS)[number])) {
      throw new BadRequestException(
        `Unknown task kind "${taskKind}". Supported: ${TASK_KINDS.join(', ')}.`,
      );
    }
  }

  private async requireProject(projectId: string): Promise<{ id: string; timezone: string }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, timezone: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return { id: project.id, timezone: project.timezone || 'UTC' };
  }

  /** The wire shape of a rule, or its documented defaults when none is stored. */
  private toDto(
    rule: CadenceRule | null,
    projectId: string,
    taskKind: string,
    projectTimezone: string,
  ): CadenceRuleDto {
    if (!rule) {
      return {
        configured: false,
        id: null,
        projectId,
        taskKind,
        frequency: 'off',
        dayOfWeek: null,
        dayOfMonth: null,
        hour: 3,
        timezone: projectTimezone,
        enabled: false,
        params: {},
        prerequisites: [],
        maxCostUsd: null,
        lastRunAt: null,
        lastJobRunId: null,
        lastStatus: null,
        lastError: null,
        nextRunAt: null,
        pausedAt: null,
        createdAt: null,
        updatedAt: null,
      };
    }
    return {
      configured: true,
      id: rule.id,
      projectId: rule.projectId,
      taskKind: rule.taskKind,
      frequency: rule.frequency as CadenceFrequency,
      dayOfWeek: rule.dayOfWeek,
      dayOfMonth: rule.dayOfMonth,
      hour: rule.hour,
      timezone: rule.timezone,
      enabled: rule.enabled,
      params: parseJsonObject(rule.params),
      prerequisites: parseJsonArray(rule.prerequisites),
      maxCostUsd: rule.maxCostUsd,
      lastRunAt: rule.lastRunAt ? rule.lastRunAt.toISOString() : null,
      lastJobRunId: rule.lastJobRunId,
      lastStatus: rule.lastStatus,
      lastError: rule.lastError,
      nextRunAt: rule.nextRunAt ? rule.nextRunAt.toISOString() : null,
      pausedAt: rule.pausedAt ? rule.pausedAt.toISOString() : null,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }
}
