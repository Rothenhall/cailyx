/**
 * ReservationsService — G12's core requirement: **reserve before you spend,
 * atomically**.
 *
 * ## The race this file exists to close
 *
 * The obvious implementation of a cap check is read-then-write: sum what is
 * already held, compare against the ceiling, then insert the hold. Two
 * requests arriving together both read the same pre-hold total, both pass,
 * and both insert — overspending the ceiling by exactly one run. The ceiling
 * looks enforced and is not.
 *
 * Three things close it, together:
 *
 * 1. **One transaction.** The cap check, the expiry sweep and the insert run
 *    inside a single `$transaction`, so nobody observes a half-applied hold.
 *
 * 2. **A write lock taken before the first read** ({@link lockProject}). The
 *    transaction's very first statement is an `UPDATE` on the project row. It
 *    changes no value, but it acquires the row/database write lock, which
 *    orders every concurrent reservation against the same project *ahead* of
 *    its own reads. By the time the second transaction reads its totals, the
 *    first has committed and its hold is visible. Reading first and locking
 *    later would leave exactly the window this is here to remove.
 *
 * 3. **Retry on write conflict.** When the engine refuses the lock (SQLite
 *    reports `SQLITE_BUSY`, and Prisma surfaces `P2034` or an operation
 *    timeout `P1008`), the losing request retries the whole transaction. It
 *    re-reads committed state, sees the winner's hold, and correctly refuses.
 *    A retry can only ever make the check *stricter*, never looser — the
 *    failure mode is a refused reservation, never a silent overspend.
 *
 * There is a fourth, and it is about throughput rather than correctness: an
 * in-process FIFO queue per project ({@link withProjectLock}). Without it,
 * twenty simultaneous reservations inside one Node process all open
 * transactions at once and fight over the same write lock, and the losers come
 * back as `P1008` operation timeouts — safe, but a 500 where a 409 was the
 * truthful answer. The queue makes this process ask one at a time, so the
 * transaction below runs uncontended and quickly. The transaction is still the
 * guarantee: the queue is an optimisation that only helps locally, and the
 * lock-plus-retry above is what holds across processes.
 *
 * ## Settling happens exactly once
 *
 * Settle and release are compare-and-swap: `updateMany` with `status: 'held'`
 * in the `WHERE`, then assert exactly one row changed. A retried run, a replayed
 * request or a cache hit that settles twice gets a 409 on the second attempt —
 * a conflict, not a second charge.
 *
 * ## Approval
 *
 * `approvedBy === null` on a `held` reservation means one specific thing: the
 * request passed a **soft** ceiling, so it is held but unapproved. Such a
 * reservation still counts against the ceiling (money set aside is money set
 * aside, and this is what stops a second overage sneaking past while the first
 * waits), and it cannot be settled until an approving role calls approve.
 * A **hard** ceiling is never approvable — it is refused outright.
 *
 * @module reservations.service
 */

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BudgetsService, type EvaluationResult } from './budgets.service';
import type { CreateReservationDto, ListReservationsQueryDto, SettleReservationDto } from './dto/spend.dto';

/** The authenticated caller, as far as this service cares. */
export interface Actor {
  userId: string;
  role: string;
  type: 'operator' | 'client';
}

/** Roles permitted to approve a soft-ceiling overage or write a ceiling. */
const APPROVER_ROLES: readonly string[] = ['admin', 'delivery-lead'];

/** A refusal that names the ceilings responsible. */
interface CapRefusal {
  message: string;
  policyId: string;
  unit: string;
  limit: number;
  remaining: number;
  requested: number;
}

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  /**
   * One FIFO queue tail per project. See {@link withProjectLock} — this is a
   * throughput guard, not the correctness one.
   */
  private readonly projectLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: BudgetsService,
  ) {}

  // ── listing ───────────────────────────────────────────────────────────

  /**
   * `GET /api/projects/:projectId/budget/reservations`.
   *
   * Sweeps lapsed holds first, so `?awaitingApprovalOnly=true` is the live
   * approval queue rather than a list that still includes holds nobody is
   * waiting on any more.
   */
  async list(projectId: string, query: ListReservationsQueryDto) {
    await this.budgets.getProjectScope(projectId);
    const now = new Date();
    const expired = await this.budgets.expireStale(projectId, now);

    const where: Prisma.SpendReservationWhereInput = {
      projectId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.taskKind ? { taskKind: query.taskKind } : {}),
      ...(query.jobRunId ? { jobRunId: query.jobRunId } : {}),
      ...(query.awaitingApprovalOnly ? { status: 'held', approvedBy: null } : {}),
    };

    const reservations = await this.prisma.spendReservation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: query.limit ?? 50,
    });

    const awaiting = await this.prisma.spendReservation.count({
      where: { projectId, status: 'held', approvedBy: null },
    });

    return {
      projectId,
      expiredOnThisRead: expired,
      awaitingApprovalCount: awaiting,
      reservations: reservations.map((r) => this.view(r, now)),
    };
  }

  // ── reserve ───────────────────────────────────────────────────────────

  /**
   * `POST /api/projects/:projectId/budget/reservations` — set money aside
   * before a run starts.
   *
   * The whole check-and-hold is one transaction; see the module docblock for
   * why the project lock comes first.
   *
   * @throws ConflictException a hard ceiling (or the per-run cap) is exceeded,
   *   a ceiling's window cannot be resolved, or a soft ceiling is exceeded
   *   twice over.
   */
  async reserve(projectId: string, dto: CreateReservationDto, actor: Actor) {
    const project = await this.budgets.getProjectScope(projectId);

    const reservedUsd =
      dto.reservedUsd !== undefined ? dto.reservedUsd : (dto.estimateHighUsd ?? 0);
    const reservedCredits = dto.reservedCredits ?? 0;
    const estimateLowUsd = dto.estimateLowUsd ?? 0;
    const estimateHighUsd = dto.estimateHighUsd ?? reservedUsd;
    const ttlMinutes = dto.ttlMinutes ?? 60;

    const result = await this.withProjectLock(projectId, () =>
      this.withWriteRetry(() =>
        this.prisma.$transaction(
        async (tx) => {
          // (1) Serialise: take the write lock before reading anything.
          await this.lockProject(tx, projectId);

          // (2) A lapsed hold is not spend — sweep before counting.
          const now = new Date();
          await this.budgets.expireStale(projectId, now, tx);

          // (3) Evaluate every applicable ceiling inside this transaction.
          const evaluation = await this.budgets.evaluate(tx, { project, taskKind: dto.taskKind });

          // (4) A ceiling nobody can measure is not a ceiling that passes.
          if (evaluation.unresolved.length > 0) {
            throw new ConflictException(
              'A budget ceiling that applies to this project could not be measured, so the reservation was ' +
                'refused rather than charged against a guessed window: ' +
                evaluation.unresolved.map((u) => `${u.policyId}: ${u.reason}`).join(' '),
            );
          }

          const hard = this.findBreach(evaluation, reservedUsd, reservedCredits);
          if (hard) throw new ConflictException(this.breachMessage(hard, evaluation));

          const perRunBreach = this.findPerRunBreach(evaluation, estimateHighUsd, reservedUsd);
          if (perRunBreach) {
            throw new ConflictException(
              `The per-run cap is $${perRunBreach.limit} (policy ${perRunBreach.policyId}) and this reservation ` +
                `asks for $${perRunBreach.requested.toFixed(2)}. A per-run cap is not approvable — split the run or raise the cap.`,
            );
          }

          const softBreaches = this.findSoftBreaches(evaluation, reservedUsd, reservedCredits);
          const requiresApproval = softBreaches.length > 0;

          const created = await tx.spendReservation.create({
            data: {
              projectId,
              taskKind: dto.taskKind,
              jobRunId: dto.jobRunId ?? null,
              estimateLowUsd,
              estimateHighUsd,
              reservedUsd,
              reservedCredits,
              status: 'held',
              expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
              requestedBy: actor.userId,
              // Null here is the approval queue. See the module docblock.
              approvedBy: requiresApproval ? null : actor.userId,
            },
          });

          return { created, evaluation, requiresApproval, softBreaches, now };
        },
          { timeout: 15_000, maxWait: 5_000 },
        ),
      ),
    );

    this.logger.log(
      `Reserved ${reservedUsd} usd / ${reservedCredits} credits for ${dto.taskKind} on project ${projectId} ` +
        `(reservation ${result.created.id}, ${result.requiresApproval ? 'awaiting approval' : 'within policy'})`,
    );

    return {
      reservation: this.view(result.created, result.now),
      approval: {
        required: result.requiresApproval,
        basis: result.requiresApproval ? ('soft-cap-exceeded' as const) : ('within-policy' as const),
        approvedBy: result.created.approvedBy,
        reason: result.requiresApproval
          ? 'A soft ceiling was exceeded. This hold still counts against the ceiling and cannot be settled ' +
            'until an approving role confirms it (POST .../reservations/:id/approve).'
          : 'Every applicable ceiling covered this reservation.',
        exceededPolicies: result.softBreaches.map((b) => ({
          policyId: b.policyId,
          enforcement: 'soft' as const,
          unit: b.unit,
          limit: b.limit,
          remaining: b.remaining,
          requested: b.requested,
        })),
      },
      policies: result.evaluation.policies,
      bindingCeilings: result.evaluation.bindingCeilings,
      next: 'Record the actual charge with POST .../reservations/:id/settle once the run finishes. '
        + 'If the run never happens, POST .../reservations/:id/release gives the hold back.',
    };
  }

  // ── approve ───────────────────────────────────────────────────────────

  /**
   * `POST .../reservations/:id/approve` — confirm a soft-ceiling overage.
   *
   * Only reachable for a `held` reservation with no approver. Approving is
   * itself a compare-and-swap, so two leads clicking at once produce one
   * approver and one 409 rather than two audit rows.
   */
  async approve(projectId: string, reservationId: string, actor: Actor) {
    if (!APPROVER_ROLES.includes(actor.role)) {
      throw new ConflictException(
        `Approving a budget overage requires one of: ${APPROVER_ROLES.join(', ')}. ` +
          `Your role is "${actor.role}" — ask a delivery lead to approve it.`,
      );
    }

    const changed = await this.prisma.spendReservation.updateMany({
      where: { id: reservationId, projectId, status: 'held', approvedBy: null },
      data: { approvedBy: actor.userId },
    });

    if (changed.count !== 1) {
      throw await this.explainMissedTransition(projectId, reservationId, 'approve');
    }

    const reservation = await this.prisma.spendReservation.findFirstOrThrow({
      where: { id: reservationId, projectId },
    });
    return {
      reservation: this.view(reservation, new Date()),
      approvedBy: actor.userId,
      note: 'The reservation can now be settled. Releasing it instead gives the hold straight back.',
    };
  }

  // ── release ───────────────────────────────────────────────────────────

  /**
   * `POST .../reservations/:id/release` — give a hold back without charging.
   *
   * For a run that never happened. The hold stops counting against the ceiling
   * immediately, which is the difference between this and letting it expire.
   *
   * A `reason` is stored on the row. It used to be refused rather than
   * accepted-and-dropped, because there was no column for it; the column now
   * exists, so the reason travels with the reservation where an audit can find
   * it. Releasing money that was held aside is exactly the kind of action whose
   * justification someone asks about later.
   */
  async release(projectId: string, reservationId: string, reason?: string) {
    const changed = await this.prisma.spendReservation.updateMany({
      where: { id: reservationId, projectId, status: 'held' },
      data: { status: 'released', note: reason ?? null },
    });

    if (changed.count !== 1) {
      throw await this.explainMissedTransition(projectId, reservationId, 'release');
    }

    const reservation = await this.prisma.spendReservation.findFirstOrThrow({
      where: { id: reservationId, projectId },
    });
    await this.budgets.expireStale(projectId, new Date());
    return {
      reservation: this.view(reservation, new Date()),
      released: true,
      note: 'The hold no longer counts against any ceiling. Nothing was charged.',
      reasonRecorded: reason ?? null,
    };
  }

  // ── settle ────────────────────────────────────────────────────────────

  /**
   * `POST .../reservations/:id/settle` — record what was actually charged.
   *
   * Exactly once. The status flip is a compare-and-swap; the `SpendEvent` rows
   * carrying the actual are written in the same transaction, so a settled
   * reservation always has its ledger entries and a ledger entry never exists
   * for a reservation that was not settled.
   *
   * Units stay separate: a USD charge writes a `usd` event, a credit charge
   * writes a `credits` event, and a run charged in one unit does not get a
   * fabricated figure in the other.
   */
  async settle(projectId: string, reservationId: string, dto: SettleReservationDto, actor: Actor) {
    const project = await this.budgets.getProjectScope(projectId);

    const reservation = await this.prisma.spendReservation.findFirst({
      where: { id: reservationId, projectId },
    });
    if (!reservation) {
      throw new NotFoundException(`Reservation ${reservationId} not found on project ${projectId}`);
    }
    if (reservation.status !== 'held') {
      throw new ConflictException(
        `Reservation ${reservationId} is already "${reservation.status}". Settling again would record a second ` +
          'charge for work that was charged once — this is the retry/cache-hit guard, not an error to work around.',
      );
    }
    if (reservation.approvedBy === null) {
      throw new ConflictException(
        `Reservation ${reservationId} exceeded a soft ceiling and has not been approved yet. ` +
          'An approving role must call POST .../reservations/:id/approve before it can be settled.',
      );
    }

    // Which unit the charge landed in is the caller's to state. Defaulting is
    // allowed, but only to the reserved amount and only when nothing at all
    // was reported — and the response says it happened.
    const reportedAny = dto.settledUsd !== undefined || dto.settledCredits !== undefined;
    const settledUsd = reportedAny ? (dto.settledUsd ?? 0) : reservation.reservedUsd;
    const settledCredits = reportedAny ? (dto.settledCredits ?? 0) : reservation.reservedCredits;
    const defaulted = !reportedAny;

    if (settledUsd > reservation.reservedUsd && dto.acknowledgeOverReservation !== true) {
      throw new ConflictException(
        `The actual charge ($${settledUsd.toFixed(2)}) exceeds what was reserved ($${reservation.reservedUsd.toFixed(2)}). ` +
          'Pass acknowledgeOverReservation: true to record it — an overrun should be a deliberate decision, ' +
          'and the ledger will show it against the ceiling.',
      );
    }

    const now = new Date();
    const provider = dto.provider ?? 'unknown';

    const outcome = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.spendReservation.updateMany({
        where: { id: reservationId, projectId, status: 'held' },
        data: { status: 'settled', settledUsd, settledCredits, settledAt: now },
      });
      if (changed.count !== 1) return null;

      // One event per unit. A charge that landed in credits writes no dollar
      // event, and vice versa — an event is a measurement, so one is never
      // fabricated in the unit the provider did not bill.
      const note = this.settlementNote(dto.note, actor.userId, defaulted);
      const shared = {
        projectId,
        clientId: project.clientId,
        taskKind: reservation.taskKind,
        jobRunId: reservation.jobRunId,
        reservationId: reservation.id,
        provider,
        quantity: dto.quantity ?? null,
        quantityUnit: dto.quantityUnit ?? null,
        note,
      };
      const usdEvent =
        settledUsd > 0
          ? await tx.spendEvent.create({ data: { ...shared, unit: 'usd', amount: settledUsd } })
          : null;
      const creditEvent =
        settledCredits > 0
          ? await tx.spendEvent.create({ data: { ...shared, unit: 'credits', amount: settledCredits } })
          : null;

      return { usdEvent, creditEvent };
    });

    if (!outcome) {
      throw new ConflictException(
        `Reservation ${reservationId} was settled or released by another request while this one was in flight. ` +
          'Nothing was charged twice.',
      );
    }

    const after = await this.prisma.spendReservation.findFirstOrThrow({
      where: { id: reservationId, projectId },
    });

    const notes: string[] = [];
    if (defaulted) {
      notes.push(
        'No actual was reported, so the settled amount defaults to what was reserved. The ledger marks this so a ' +
          'prediction is never mistaken for a measurement.',
      );
    }
    if (reportedAny && dto.settledUsd === undefined && settledCredits > 0) {
      notes.push(
        'The provider reported a credit charge and no dollar figure. No USD amount was invented to fill the gap — ' +
          'the two units are recorded separately.',
      );
    }
    if (after.status === 'settled' && settledUsd === 0 && settledCredits === 0) {
      notes.push('This run was charged nothing. No spend event was written for an empty charge.');
    }

    const written = [outcome.usdEvent, outcome.creditEvent].filter(
      (e): e is NonNullable<typeof e> => e !== null,
    );

    return {
      reservation: this.view(after, now),
      events: written.map((e) => ({
        id: e.id,
        unit: e.unit,
        amount: e.amount,
        provider: e.provider,
        quantity: e.quantity,
        quantityUnit: e.quantityUnit,
      })),
      settlement: {
        usd: settledUsd,
        credits: settledCredits,
        defaultedToReserved: defaulted,
        overReservationAcknowledged: settledUsd > reservation.reservedUsd,
        variance: {
          vsHighUsd: Number((settledUsd - reservation.estimateHighUsd).toFixed(6)),
          vsLowUsd: Number((settledUsd - reservation.estimateLowUsd).toFixed(6)),
        },
      },
      notes,
    };
  }

  private settlementNote(note: string | undefined, actorUserId: string, defaulted: boolean): string {
    const parts = [`settled by ${actorUserId}`];
    if (defaulted) parts.push('amount defaulted to the reserved figure (no actual reported)');
    if (note) parts.push(note);
    return parts.join(' — ');
  }

  /** Turn a failed compare-and-swap into the precise reason it failed. */
  private async explainMissedTransition(
    projectId: string,
    reservationId: string,
    action: 'approve' | 'release',
  ): Promise<ConflictException> {
    const current = await this.prisma.spendReservation.findFirst({
      where: { id: reservationId, projectId },
      select: { status: true, approvedBy: true },
    });
    if (!current) {
      return new ConflictException(`Reservation ${reservationId} not found on project ${projectId}`);
    }
    if (current.status !== 'held') {
      return new ConflictException(
        `Reservation ${reservationId} is "${current.status}" and cannot be ${action}d. ` +
          'Only a held reservation can be changed — releasing or approving a settled one would not undo its charge.',
      );
    }
    return new ConflictException(
      `Reservation ${reservationId} was already approved by ${current.approvedBy}. ` +
        'Two approvals are one too many; the first stands.',
    );
  }

  // ── concurrency plumbing ──────────────────────────────────────────────

  /**
   * Take the write lock on the project row **before any read** in the
   * surrounding transaction.
   *
   * The `UPDATE` assigns a column to itself, so no value changes (`updatedAt`
   * is maintained by Prisma Client, not by the database, so raw SQL here does
   * not even move the timestamp). Its purpose is entirely its lock: it orders
   * every concurrent reservation on this project ahead of its own reads, which
   * is what makes the following cap check see a committed, not a stale, total.
   */
  private async lockProject(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
    await tx.$executeRaw`UPDATE "Project" SET "updatedAt" = "updatedAt" WHERE "id" = ${projectId}`;
  }

  /**
   * Run `fn` with exclusive access to one project's budget, FIFO within this
   * process.
   *
   * This is a throughput guard, not the correctness one — the transaction and
   * its write lock are what make the check safe. What this prevents is this
   * process's own requests opening competing transactions and timing each
   * other out, which is a legitimate 409 turning into an opaque 500.
   *
   * The map holds one promise per project: the tail of its queue. A caller
   * chains itself onto the tail and waits for the entry before it to settle,
   * so ordering is strict. The entry is removed only when the finishing caller
   * is still the tail, so a queued follower is never dropped.
   */
  private async withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.projectLocks.set(projectId, tail);

    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.projectLocks.get(projectId) === tail) this.projectLocks.delete(projectId);
    }
  }

  /**
   * Retry a transaction that lost a write conflict.
   *
   * Two codes mean the same thing here. `P2034` is Prisma's own write-conflict
   * report. `P1008` is what its SQLite connector returns when a transaction
   * waited too long for the write lock — indistinguishable, from this side,
   * from a busy database, and the correct response to both is to re-read
   * committed state and try again rather than surface a 500.
   *
   * Retrying is safe *because the work is idempotent in effect*: the loser
   * re-reads committed state, so it either succeeds on a genuinely free
   * ceiling or refuses. It can never turn a refusal into an overspend.
   */
  private async withWriteRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!this.isWriteConflict(err) || attempt === maxAttempts) throw err;
        lastError = err;
        this.logger.warn(
          `Budget transaction hit a write conflict (attempt ${attempt}/${maxAttempts}) — retrying so the ceiling ` +
            'is checked against committed state rather than a stale snapshot.',
        );
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt));
      }
    }
    throw lastError;
  }

  private isWriteConflict(err: unknown): boolean {
    const e = err as { code?: string; message?: string };
    // P2034 — Prisma write conflict / deadlock.
    // P1008 — SQLite connector operation timeout, its way of reporting a
    //         transaction that could not get the write lock in time.
    if (e?.code === 'P2034' || e?.code === 'P1008') return true;
    const m = (e?.message ?? '').toLowerCase();
    return (
      m.includes('sqlite_busy') ||
      m.includes('database is locked') ||
      m.includes('write conflict') ||
      m.includes('deadlock')
    );
  }

  // ── ceiling arithmetic ────────────────────────────────────────────────

  /** A hard ceiling the requested hold would pass. */
  private findBreach(
    evaluation: EvaluationResult,
    reservedUsd: number,
    reservedCredits: number,
  ): CapRefusal | null {
    for (const policy of evaluation.policies) {
      for (const [unit, requested] of [
        ['usd', reservedUsd],
        ['credits', reservedCredits],
      ] as const) {
        const total = policy.totals.find((t) => t.unit === unit);
        if (!total || total.limit === null || total.remaining === null) continue;
        if (requested > total.remaining && policy.enforcement === 'hard') {
          return {
            message: '',
            policyId: policy.policyId,
            unit,
            limit: total.limit,
            remaining: total.remaining,
            requested,
          };
        }
      }
    }
    return null;
  }

  /** Soft ceilings the requested hold would pass. */
  private findSoftBreaches(
    evaluation: EvaluationResult,
    reservedUsd: number,
    reservedCredits: number,
  ): CapRefusal[] {
    const out: CapRefusal[] = [];
    for (const policy of evaluation.policies) {
      for (const [unit, requested] of [
        ['usd', reservedUsd],
        ['credits', reservedCredits],
      ] as const) {
        const total = policy.totals.find((t) => t.unit === unit);
        if (!total || total.limit === null || total.remaining === null) continue;
        if (requested > total.remaining && policy.enforcement === 'soft') {
          out.push({
            message: '',
            policyId: policy.policyId,
            unit,
            limit: total.limit,
            remaining: total.remaining,
            requested,
          });
        }
      }
    }
    return out;
  }

  /** A per-run ceiling the reservation would pass. Not approvable. */
  private findPerRunBreach(
    evaluation: EvaluationResult,
    estimateHighUsd: number,
    reservedUsd: number,
  ): { policyId: string; limit: number; requested: number } | null {
    const asked = Math.max(estimateHighUsd, reservedUsd);
    for (const policy of evaluation.policies) {
      if (policy.perRunCapUsd !== null && asked > policy.perRunCapUsd) {
        return { policyId: policy.policyId, limit: policy.perRunCapUsd, requested: asked };
      }
    }
    return null;
  }

  private breachMessage(breach: CapRefusal, evaluation: EvaluationResult): string {
    const window = evaluation.policies.find((p) => p.policyId === breach.policyId);
    return (
      `This reservation needs ${breach.requested} ${breach.unit} but the hard ceiling on policy ${breach.policyId} ` +
      `has ${breach.remaining} ${breach.unit} left of ${breach.limit}` +
      (window ? ` in this ${window.window.period} window (${window.scopeType}-scoped).` : '.') +
      ' A hard ceiling is not approvable — raise the ceiling or reduce the run.'
    );
  }

  // ── view ──────────────────────────────────────────────────────────────

  private view(
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
    const lapsed = r.status === 'held' && r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime();
    return {
      id: r.id,
      projectId: r.projectId,
      taskKind: r.taskKind,
      jobRunId: r.jobRunId,
      /** The estimate recorded when the hold was taken, in USD. */
      estimate: { lowUsd: r.estimateLowUsd, highUsd: r.estimateHighUsd },
      /** What is set aside, per unit. */
      reserved: { usd: r.reservedUsd, credits: r.reservedCredits },
      status: r.status,
      /** A hold that has lapsed but not yet been swept by a read. */
      expiredButUnswept: lapsed,
      /** The actual, once settled. Null means "not settled yet", never zero. */
      actual: r.status === 'settled' ? { usd: r.settledUsd ?? 0, credits: r.settledCredits ?? 0 } : null,
      /** Estimate vs actual, for settled rows only. */
      variance:
        r.status === 'settled' && r.settledUsd !== null
          ? {
              vsHighUsd: Number((r.settledUsd - r.estimateHighUsd).toFixed(6)),
              vsLowUsd: Number((r.settledUsd - r.estimateLowUsd).toFixed(6)),
            }
          : null,
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      requestedBy: r.requestedBy,
      approvedBy: r.approvedBy,
      /** Held with no approver — the approval queue. */
      awaitingApproval: r.status === 'held' && r.approvedBy === null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
