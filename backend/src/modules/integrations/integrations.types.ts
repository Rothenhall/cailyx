/**
 * Integrations Types — connection status for every external service Cailyx can
 * use. Reports booleans + display metadata only; never the secret values.
 *
 * @module integrations.types
 */

export type IntegrationCategory =
  | 'analytics'
  | 'ai-surface'
  | 'serp'
  | 'performance'
  | 'infrastructure'
  | 'monetization'
  | 'email'
  | 'mode';

export type IntegrationStatus = 'connected' | 'not-connected' | 'unavailable' | 'enabled' | 'disabled';

export interface Integration {
  key: string;
  name: string;
  category: IntegrationCategory;
  connected: boolean;
  status: IntegrationStatus;
  /** One-line human explanation of the current state. */
  detail: string;
  /** Which env var(s) / OAuth flow provides this. */
  configHint: string;
  /** OAuth connect URL when we have one; null when the flow is not wired yet. */
  connectUrl: string | null;
  /** Relevant module doc path, if any. */
  docsPath: string | null;
}

export interface IntegrationsResponse {
  integrations: Integration[];
  summary: { total: number; connected: number };
}
