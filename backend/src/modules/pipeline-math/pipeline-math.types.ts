/**
 * Types for the Pipeline Math module (GTM Playbook).
 *
 * @module pipeline-math.types
 */

/** All intermediate stages of the qualification chain — persisted, not derived. */
export interface PipelineStages {
  /** Deals needed = revenueTarget / ACV (rounded up). */
  deals: number;
  /** SQLs needed = deals / winRate. */
  sqls: number;
  /** Booked meetings needed = SQLs / meetingToSql. */
  meetings: number;
  /** Leads needed = meetings / leadToMeeting. */
  leads: number;
  /** Visitors needed = leads / visitorToLead. */
  visitors: number;
}

export type PipelineVerdict = 'feasible' | 'fiction';

/**
 * Verdict threshold: when a market size is supplied, the plan is called
 * fiction if the required visitors exceed market size by this factor.
 * Disclosed on every response (FR-8.4 spirit — name the threshold).
 */
export const FICTION_FACTOR = 1.5;