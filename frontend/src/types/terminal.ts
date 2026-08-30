/**
 * Types for the Cailyx dashboard — mirrors the backend `agents` and
 * `integrations` aggregation modules plus the bits of other modules the panes
 * read.
 *
 * @module types/terminal
 */

export interface SafeUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: string;
}

export type AgentStatus = 'ready' | 'attention' | 'idle' | 'running' | 'blocked';

export interface AgentCard {
  key: string;
  name: string;
  category: string;
  status: AgentStatus;
  headline: string;
  count: number;
  metric: string | null;
  activity: string[];
  lastActivityAt: string | null;
  href: string;
  cta: string;
}

export interface AgentsResponse {
  projectId: string;
  agents: AgentCard[];
  summary: { total: number; needAttention: number; ready: number; idle: number };
}

export type IntegrationCategory =
  | 'analytics'
  | 'ai-surface'
  | 'serp'
  | 'performance'
  | 'infrastructure'
  | 'monetization'
  | 'email'
  | 'mode';

export interface Integration {
  key: string;
  name: string;
  category: IntegrationCategory;
  connected: boolean;
  status: 'connected' | 'not-connected' | 'unavailable' | 'enabled' | 'disabled';
  detail: string;
  configHint: string;
  connectUrl: string | null;
  docsPath: string | null;
}

export interface IntegrationsResponse {
  integrations: Integration[];
  summary: { total: number; connected: number };
}

/** technical-audit finding (subset the Analytics pane renders). */
export interface AuditFinding {
  id: string;
  type: string;
  status: string; // pass | warn | fail
  severity: string; // info | low | medium | high | critical
  confidence: string;
  detail: string;
  recommendedFix: string;
}

export interface PageMetadata {
  title: string | null;
  metaDescription: string | null;
  headings: string | null; // JSON
  positioningCopy: string | null;
}

export interface TechnicalAudit {
  id: string;
  projectId: string;
  targetUrl: string;
  createdAt: string;
  findings: AuditFinding[];
  pageMetadata: PageMetadata | null;
}

export interface LinkGraph {
  id: string;
  status: string;
  rootUrl: string;
  pagesCrawled: number;
  edgeCount: number;
  orphanCount: number;
  recommendationCount: number;
  createdAt: string;
}

export interface ProjectStats {
  technicalAudits: number;
  reports: number;
  entities: number;
  gaps: number;
  scheduleActive: boolean;
}

export interface ProjectDetail {
  id: string;
  name: string;
  domain: string;
  category?: string | null;
  clientName?: string | null;
  status?: string | null;
  notes?: string | null;
  competitors?: string | null; // JSON [{name, domain}]
  createdAt?: string;
  updatedAt?: string;
  stats?: ProjectStats;
}
