/**
 * Agents Types — the dashboard "Agents Feed": one card per capability, each
 * with a live status line derived from what that module has actually produced
 * for the project.
 *
 * @module agents.types
 */

export type AgentStatus = 'ready' | 'attention' | 'idle' | 'running' | 'blocked';

export interface AgentCard {
  key: string;
  name: string;
  /** short capability group slug */
  category: string;
  status: AgentStatus;
  /** the status line shown under the agent name */
  headline: string;
  /** the primary countable thing (recs, gaps, personas, …) */
  count: number;
  /** a secondary metric string, or null */
  metric: string | null;
  /** 1–3 lines describing what the agent is doing / has done */
  activity: string[];
  /** ISO timestamp of the most recent artefact this agent produced */
  lastActivityAt: string | null;
  /** where the frontend should route to act on this agent */
  href: string;
  /** the call-to-action label */
  cta: string;
}

export interface AgentsResponse {
  projectId: string;
  agents: AgentCard[];
  summary: { total: number; needAttention: number; ready: number; idle: number };
}
