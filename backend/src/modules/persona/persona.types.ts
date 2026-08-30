/**
 * Persona Types — synthetic buyer personas (Agent #1, Swarm layer).
 *
 * A Persona is a research identity: a role, its buying context, and the
 * concrete thing it is trying to find out. Personas seed branching search
 * journeys (`journey` module) and tag measurement observations by segment.
 *
 * Design boundary: a persona is a lens for asking questions of AI surfaces
 * and licensed SERP data. It is never used to impersonate a real human to
 * generate traffic, clicks, impressions, or rankings on any live surface.
 *
 * @module persona.types
 */

/** Awareness stage — mirrors the QuerySet `PromptPersona` union so a persona
 * feeds `query-set` / `journey` without translation. */
export type PersonaAwareness =
  | 'problem-aware'
  | 'solution-aware'
  | 'product-aware'
  | 'most-aware';

export const PERSONA_AWARENESS: readonly PersonaAwareness[] = [
  'problem-aware',
  'solution-aware',
  'product-aware',
  'most-aware',
];

/** Buyer role catalogue the deterministic generator draws from. */
export type PersonaRole =
  | 'founder'
  | 'cmo'
  | 'head-of-growth'
  | 'seo-lead'
  | 'content-lead'
  | 'demand-gen'
  | 'saas-operator'
  | 'product-marketer'
  | 'agency-owner'
  | 'rev-ops';

export const PERSONA_ROLES: readonly PersonaRole[] = [
  'founder',
  'cmo',
  'head-of-growth',
  'seo-lead',
  'content-lead',
  'demand-gen',
  'saas-operator',
  'product-marketer',
  'agency-owner',
  'rev-ops',
];

export type PersonaSeniority = 'ic' | 'lead' | 'director' | 'vp' | 'c-level' | 'founder';
export const PERSONA_SENIORITY: readonly PersonaSeniority[] = [
  'ic',
  'lead',
  'director',
  'vp',
  'c-level',
  'founder',
];

export type PersonaCompanyStage = 'idea' | 'seed' | 'series-a' | 'growth' | 'enterprise';
export const PERSONA_COMPANY_STAGE: readonly PersonaCompanyStage[] = [
  'idea',
  'seed',
  'series-a',
  'growth',
  'enterprise',
];

export type PersonaStatus = 'draft' | 'active' | 'archived';
export const PERSONA_STATUS: readonly PersonaStatus[] = ['draft', 'active', 'archived'];

export type PersonaSource = 'generated' | 'generated-llm' | 'manual';

/** API representation — JSON arrays parsed out of their stored string columns. */
export interface PersonaDto {
  id: string;
  projectId: string;
  label: string;
  role: PersonaRole | string;
  seniority: PersonaSeniority | string;
  companyStage: PersonaCompanyStage | string;
  awareness: PersonaAwareness | string;
  primaryGoal: string;
  researchObjective: string;
  painPoints: string[];
  buyingTriggers: string[];
  objections: string[];
  vocabulary: string[];
  status: PersonaStatus | string;
  source: PersonaSource | string;
  generationModel: string | null;
  seed: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The freeform fields a persona is made of — shared by the deterministic
 * generator and the optional LLM refinement so both produce the same shape. */
export interface PersonaProfile {
  label: string;
  role: PersonaRole;
  seniority: PersonaSeniority;
  companyStage: PersonaCompanyStage;
  awareness: PersonaAwareness;
  primaryGoal: string;
  researchObjective: string;
  painPoints: string[];
  buyingTriggers: string[];
  objections: string[];
  vocabulary: string[];
}

/** Context handed to the generator — everything it needs about the project. */
export interface PersonaGenerationContext {
  projectId: string;
  /** Project category, e.g. "AI visibility diagnostics". Falls back to a generic noun. */
  category: string;
  /** Project / client brand, used only to phrase "most-aware" objectives. */
  brand: string;
  /** Competitor names seeded by intake — used for solution/product-aware framing. */
  competitors: string[];
}

export interface GeneratePersonasInput {
  /** How many personas to create this call. Clamped to the remaining project budget. */
  count: number;
  /** Restrict generation to these roles (round-robin). Defaults to the full catalogue. */
  roles?: PersonaRole[];
  /** Refine the deterministic draft with an LLM pass. Requires ANTHROPIC_API_KEY (503 otherwise). */
  useLlm?: boolean;
}

export interface CreatePersonaInput {
  label: string;
  role: PersonaRole;
  seniority?: PersonaSeniority;
  companyStage?: PersonaCompanyStage;
  awareness?: PersonaAwareness;
  primaryGoal: string;
  researchObjective: string;
  painPoints?: string[];
  buyingTriggers?: string[];
  objections?: string[];
  vocabulary?: string[];
}

export interface UpdatePersonaInput {
  label?: string;
  seniority?: PersonaSeniority;
  companyStage?: PersonaCompanyStage;
  awareness?: PersonaAwareness;
  primaryGoal?: string;
  researchObjective?: string;
  painPoints?: string[];
  buyingTriggers?: string[];
  objections?: string[];
  vocabulary?: string[];
}
