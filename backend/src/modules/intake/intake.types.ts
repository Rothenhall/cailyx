/**
 * Intake Types — Subject intake + auto-enrichment shapes (PRD §6.1).
 *
 * A Subject is accepted via: public form, operator console, bulk CSV, or API.
 * Minimum input is a domain. Enrichment auto-infers: category, description,
 * country, named competitors, and the subject's own entities.
 *
 * @module intake.types
 */

export type IntakeSource = 'public-form' | 'operator-console' | 'bulk-csv' | 'api';

export interface IntakeRequest {
  /** Minimum required input is a domain (PRD FR-1.5) */
  domain: string;
  company?: string;
  email?: string;
  phone?: string;
  description?: string;
  source?: IntakeSource;
  notes?: string;
}

export interface Competitor {
  name: string;
  domain: string | null;
  source: 'homepage-copy' | 'search-results' | 'operator-supplied';
}

export interface EnrichmentResult {
  domain: string;
  company: string | null;
  category: string | null;
  description: string | null;
  country: string | null;
  competitors: Competitor[];
  ownEntities: string[];
  pagesFetched: number;
  enrichmentSource: 'homepage' | 'search' | 'both';
}

export interface BulkResult {
  submitted: number;
  created: number;
  skipped: Array<{ domain: string; reason: string }>;
  enriched: EnrichmentResult[];
}
