/**
 * Types for the refresh-cadence module.
 *
 * @module refresh-cadence.types
 */

/** Same vocabulary as `clients.types.PlanTier` — duplicated rather than
 *  imported so this module never has to import `ClientsModule` just for a
 *  string union (see module README "why no ClientsModule import"). */
export type PlanTier = 'starter' | 'growth' | 'scale' | 'enterprise';

/** Cadence values this module ever writes to `ScheduleConfig.refreshCadence`. */
export type RefreshCadence = 'daily' | 'weekly' | 'manual-only';

/** Read-only status view for `GET /projects/:projectId/refresh-cadence`. */
export interface RefreshCadenceStatusDto {
  projectId: string;
  clientId: string | null;
  planTier: PlanTier | null;
  cadence: RefreshCadence;
  active: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
}

/** Result of one scoped refresh attempt, returned by the manual run-now route. */
export interface RefreshRunResultDto {
  projectId: string;
  ran: boolean;
  /** Why nothing ran, when `ran` is false (e.g. no active query set yet). */
  skippedReason?: string;
  measurementRunId?: string;
  scoreRunId?: string;
}
