/**
 * Shared types and vocabularies for G12 — budget policies, spend reservations
 * and the cost audit ledger.
 *
 * SQLite has no enums: `BudgetPolicy.scopeType`/`period`/`enforcement`,
 * `SpendReservation.status` and `SpendEvent.unit` are `String` columns whose
 * permitted values are documented on the Prisma models. This file is the
 * single source of truth for those vocabularies so the controller, the
 * reservation service and the ledger never disagree about what a value means.
 *
 * ## The two rules this file exists to keep straight
 *
 * 1. **Units never mix.** `SpendEvent.unit` is `usd` or `credits`, and there
 *    is no implicit conversion between them. Every aggregate in this module is
 *    keyed by unit — `UnitTotal` carries its own `unit` and nothing here ever
 *    returns a single "total spend" number. `CLORO_CREDIT_USD` exists, but
 *    turning credits into dollars is a *reported* conversion the caller opts
 *    into, never something a sum does behind the caller's back.
 *
 * 2. **Unknown is a value, not a default.** `UnknownValue` exists so that "we
 *    could not read the provider balance" has a shape that cannot be mistaken
 *    for "the balance covers it". A boolean `fits` cannot tell those apart
 *    when it is absent; `Affordability` can.
 *
 * ## Context (design_plan.md G12)
 *
 * The pre-existing AEO budget guard produces a **Cloro credit estimate** for
 * one audit's answer-engine sampling. That is not all-provider USD spend and
 * it is not this module's ledger. Field names here say `credits` when they
 * mean credits and `usd` when they mean dollars, and the AEO estimate is
 * reported as a `CostEstimateRange` with `unit: 'credits'` and
 * `basis: 'cloro-credit-tariff'` — never as "the budget".
 *
 * @module budgets.types
 */

import { TASK_KINDS, type TaskKind } from '../jobs/jobs.types';

export { TASK_KINDS };
export type { TaskKind };

// ── BudgetPolicy vocabularies ───────────────────────────────────────────

/**
 * What a policy's `scopeId` points at.
 * - `client`    — `scopeId` is a Client.id; covers every project of that client.
 * - `project`   — `scopeId` is a Project.id.
 * - `operation` — `scopeId` is a Project.id and `taskKind` is set; narrows the
 *                 project ceiling to one kind of work.
 */
export const BUDGET_SCOPE_TYPES = ['client', 'project', 'operation'] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

/**
 * The calendar window a policy's ceiling applies to.
 * - `day`/`week`/`month` — a calendar window in the **project's** timezone.
 * - `cycle`              — the project's live G06 Cycle (startsOn..endsOn).
 * - `total`              — all time; no window.
 */
export const BUDGET_PERIODS = ['day', 'week', 'month', 'cycle', 'total'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/**
 * What happens when a ceiling is reached.
 * - `hard` — the reservation is refused outright. There is no override.
 * - `soft` — the reservation is created but held **unapproved**; it blocks a
 *   second overage while it exists, and it cannot be settled until an
 *   approving role calls the approve action. See `ReservationsService`.
 */
export const BUDGET_ENFORCEMENTS = ['hard', 'soft'] as const;
export type BudgetEnforcement = (typeof BUDGET_ENFORCEMENTS)[number];

// ── Spend vocabularies ──────────────────────────────────────────────────

/**
 * `SpendEvent.unit`. A dollar amount and a credit amount are different
 * quantities; summing them is meaningless and this module never does it.
 */
export const SPEND_UNITS = ['usd', 'credits'] as const;
export type SpendUnit = (typeof SPEND_UNITS)[number];

/**
 * `SpendReservation.status`.
 * - `held`     — money/credits set aside; counts against the ceiling.
 * - `settled`  — the actual charge is recorded; terminal.
 * - `released` — given back without a charge (a run that never happened); terminal.
 * - `expired`  — the hold lapsed without being spent; terminal, and stops
 *                counting against the ceiling.
 */
export const RESERVATION_STATUSES = ['held', 'settled', 'released', 'expired'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

// ── Unknown / affordability shapes ──────────────────────────────────────

/**
 * "We do not know." Deliberately not a falsy number and deliberately not a
 * boolean: design_plan.md G12's acceptance criterion is that an unknown
 * provider balance is reported as unknown and never as "fits".
 */
export interface UnknownValue {
  state: 'unknown';
  /** Why it is unknown, in operator-readable terms. Never empty. */
  reason: string;
}

/** A balance we actually read, carrying the unit it was read in. */
export interface KnownBalance {
  state: 'known';
  unit: SpendUnit;
  value: number;
  /** Where it came from — e.g. `GET https://api.cloro.dev/v1/credits`. */
  source: string;
  readAt: string;
}

/** The Cloro pre-flight probe's result, in the same discriminated shape. */
export type ProviderBalance = KnownBalance | UnknownValue;

/**
 * Whether a request can go ahead, resolved against the applicable policies
 * *and* any provider-side balance we could read.
 *
 * `unknown` is a first-class outcome, and it is never upgraded to
 * `affordable`: if the provider balance could not be read, the caller is told
 * so and decides.
 */
export type Affordability = 'affordable' | 'over-cap' | 'requires-approval' | 'unknown';

// ── Aggregates ──────────────────────────────────────────────────────────

/**
 * Usage against one policy ceiling, for one unit, in one window.
 *
 * `limit` is null when the policy sets no ceiling in this unit — which is not
 * the same as a limit of zero, and not the same as `remaining: null`
 * (no ceiling to consume, so nothing to report as remaining).
 */
export interface UnitTotal {
  unit: SpendUnit;
  /** The ceiling for this unit, or null when the policy sets none. */
  limit: number | null;
  /** Sum of `held` reservations that have not expired. */
  reservedHeld: number;
  /** Sum of settled actuals plus any directly-recorded spend. */
  settled: number;
  /** `limit - reservedHeld - settled`, or null when there is no limit. */
  remaining: number | null;
  /** True when reservedHeld + settled exceeds the limit. Null when there is no limit. */
  overLimit: boolean | null;
}

/** The window a policy was evaluated over, and how it was resolved. */
export interface PolicyWindow {
  period: BudgetPeriod;
  /** Inclusive start, or null for `total`. */
  startsAt: string | null;
  /** Exclusive end, or null for `total`. */
  endsAt: string | null;
  /** IANA zone the calendar windows were resolved in (the project's). */
  timezone: string;
  /**
   * How the window was arrived at. `cycle`-period policies report
   * `unresolved` when the project has no live cycle, and a reservation is
   * then refused rather than charged against a guessed window.
   */
  resolved: 'calendar' | 'project-cycle' | 'all-time' | 'unresolved';
  /** Why it could not be resolved, when it could not. */
  unresolvedReason?: string;
}

/** One ceiling that applies to a request, already evaluated. */
export interface PolicyEvaluation {
  policyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  /** Null for client/project-wide policies. */
  taskKind: string | null;
  enforcement: BudgetEnforcement;
  /** The window this policy was evaluated over. */
  window: PolicyWindow;
  /** One entry per unit the policy sets a ceiling in. */
  totals: UnitTotal[];
  /** True when any unit is over its ceiling. */
  exceeded: boolean;
  /** Per-run ceiling for a single task run, in USD. */
  perRunCapUsd: number | null;
}

/** A parsed per-run cap decision. */
export interface PerRunCapCheck {
  limit: number;
  /** What this reservation asked for — the high end of the estimate. */
  requested: number;
  passed: boolean;
  policyId: string;
}

/** How a reservation was authorised. */
export interface ApprovalState {
  required: boolean;
  approved: boolean;
  /** User.id that authorised it, or null while approval is outstanding. */
  approvedBy: string | null;
  /**
   * Why approval was or was not required.
   * - `within-policy` — every applicable ceiling passed.
   * - `soft-cap-exceeded` — a `soft` ceiling was passed; an approving role
   *   must confirm before this reservation can be settled.
   */
  basis: 'within-policy' | 'soft-cap-exceeded';
  /** The ceilings that were exceeded, when `basis` is `soft-cap-exceeded`. */
  exceededPolicyIds: string[];
}
