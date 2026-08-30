/**
 * Authority Types — legitimate-mention discovery (Agent #6, Swarm layer).
 *
 * Finds publications, communities, podcasts, directories, and newsletters where
 * the client could EARN a mention or link, and promotes chosen ones into the
 * `mention-tracking` outreach ledger. Discovery + drafting only — never
 * automated outreach, posting, or account creation.
 *
 * @module authority.types
 */

export type AuthorityMethod = 'serp' | 'llm' | 'citations' | 'combined';
export type AuthorityScanStatus = 'running' | 'complete' | 'partial' | 'failed';
export type AuthorityCandidateType =
  | 'listicle'
  | 'community'
  | 'podcast'
  | 'publication'
  | 'directory'
  | 'newsletter';
export type AuthorityCandidateStatus = 'new' | 'promoted' | 'dismissed';

export interface WorkingCandidate {
  domain: string;
  url: string;
  title: string;
  type: AuthorityCandidateType;
  discoveredVia: string;
  rank: number | null;
  relevance: number;
  rationale: string;
}

export interface RunScanInput {
  category?: string;
  method?: AuthorityMethod;
  listicleQueries?: string[];
  useLlm?: boolean;
}

export const AUTHORITY_LIMITS = {
  maxCandidates: 60,
  maxListicleQueries: 8,
  defaultMaxCostPerScan: 1.5,
} as const;

/** Authority candidate type → mention-tracking target type. */
export const CANDIDATE_TO_TARGET_TYPE: Record<AuthorityCandidateType, string> = {
  listicle: 'listicle',
  community: 'community',
  podcast: 'other',
  publication: 'other',
  directory: 'other',
  newsletter: 'other',
};
