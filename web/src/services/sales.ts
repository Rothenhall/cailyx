import { api } from '@/lib/api';

/**
 * Sales adapters — design_plan.md screens SL01–SL06.
 *
 * The section that governs almost every screen here is §5.11, *"Sales
 * qualification and handoff"*, and two of its sentences are load-bearing:
 *
 *  - *"Store the user's rate assumptions and explain the result as scenario
 *    arithmetic. Use its `feasible`/`fiction` output with context; do not
 *    portray it as a forecast based on actual acquisition data."*
 *  - *"The public completion endpoint is an unsigned stand-in, not a verified
 *    payment event. Never let a browser callback, button, or ledger status
 *    alone grant service entitlements."*
 *
 * Both are structural here rather than advisory: {@link PipelineMath} has no
 * field named "forecast" to render, and there is deliberately **no adapter
 * function** for `POST /projects/:projectId/delivery/upgrades/:id/complete` —
 * that route is unauthenticated and stands in for a Stripe webhook, so a
 * browser must not be the thing that drives it.
 *
 * @module sales
 */

// ── SL02 · Sales pipeline ───────────────────────────────────────────────

export const LEAD_STATUSES = ['new', 'reached', 'booked', 'won', 'lost'] as const;
export const LEAD_SOURCES = ['bulk', 'api', 'form', 'scorecard'] as const;
export const CTA_EVENT_TYPES = ['book-call', 'review-ask', 'upgrade-click'] as const;
export const UPGRADE_TIERS = ['full', 'monitoring'] as const;
export const UPGRADE_STATUSES = ['created', 'clicked', 'completed', 'abandoned'] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type CtaEventType = (typeof CTA_EVENT_TYPES)[number];
export type UpgradeTier = (typeof UPGRADE_TIERS)[number];
export type UpgradeStatus = (typeof UPGRADE_STATUSES)[number];

/**
 * A portfolio lead row.
 *
 * ⚠️ This is `SalesLeadRowDto` from `operations.types.ts`, which is **not** the
 * same shape as `services/operations.ts`'s `SalesLeadRow`: that adapter omits
 * `createdAt` and types the page as `{items, nextCursor, total}` when the route
 * documents `{items, page, pageSize, total}`. The type is repeated correctly
 * here rather than re-exported, and the discrepancy is reported.
 */
export interface PortfolioLead {
  id: string;
  email: string;
  name: string | null;
  source: string;
  status: string;
  projectId: string;
  projectName: string;
  clientId: string | null;
  clientName: string | null;
  createdAt: string;
}

/** The real pagination envelope for every `/operations/*` list route. */
export interface PortfolioPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PortfolioLeadQuery {
  status?: string;
  source?: string;
  projectId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Leads across the portfolio, server-filtered and paginated.
 *
 * Note what this surface can and cannot do. It is scoped through the caller's
 * assigned projects, so a lead on a project outside the portfolio is simply
 * absent — and `total` counts only what this caller may see. That is not a
 * discrepancy to explain away: it is the scope.
 */
export async function listPortfolioLeads(
  query: PortfolioLeadQuery,
  options?: { signal?: AbortSignal },
) {
  return api.get<PortfolioPage<PortfolioLead>>('/operations/sales/leads', {
    ...options,
    query: query as Record<string, string | number | undefined>,
  });
}

// ── Per-project leads (SL02 handoff, SL03 detail) ───────────────────────

export interface CtaEvent {
  type: string;
  at: string;
  meta?: Record<string, unknown>;
}

/**
 * A lead, with its CTA log parsed.
 *
 * `ctaEvents` is append-only at the API level — the log route pushes and never
 * overwrites (FR-11.3) — so the array is the history, not a current state. A
 * lead's *status* is a separate, mutable field; the two must not be conflated
 * on screen, and a later status change does not rewrite what was clicked.
 */
export interface Lead {
  id: string;
  projectId: string;
  email: string;
  name: string | null;
  source: string;
  status: string;
  scorecardRunId: string | null;
  ctaEvents: CtaEvent[];
  createdAt: string;
}

export async function listLeadRows(
  projectId: string,
  status?: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<Lead[]>(`/projects/${projectId}/delivery/leads`, {
    ...options,
    query: status ? { status } : undefined,
  });
}

export async function getLead(projectId: string, leadId: string, options?: { signal?: AbortSignal }) {
  return api.get<Lead>(`/projects/${projectId}/delivery/leads/${leadId}`, options);
}

export async function createLead(
  projectId: string,
  input: { email: string; name?: string; source?: LeadSource; scorecardRunId?: string },
) {
  return api.post<Lead>(`/projects/${projectId}/delivery/leads`, input);
}

export async function updateLeadStatus(projectId: string, leadId: string, status: LeadStatus) {
  return api.patch<Lead>(`/projects/${projectId}/delivery/leads/${leadId}`, { status });
}

/**
 * Appends a CTA click to the lead's own event log.
 *
 * Kept separate from {@link updateLeadStatus} on purpose: recording that
 * somebody clicked is an observation, whereas moving the lead to `won` is a
 * claim about what happened afterwards. Writing one must never be able to
 * imply the other.
 */
export async function logLeadCta(
  projectId: string,
  leadId: string,
  input: { type: CtaEventType; meta?: Record<string, unknown> },
) {
  return api.post<CtaEvent[]>(`/projects/${projectId}/delivery/leads/${leadId}/cta`, input);
}

/** CSV export of one project's leads — the route the backend actually offers. */
export function leadExportHref(projectId: string): string {
  return `/api/projects/${projectId}/delivery/leads/export`;
}

// ── SL06 · Offers and upgrades ──────────────────────────────────────────

/**
 * One row of the checkout ledger.
 *
 * `issued`, `clicked` and `completed` are three different facts, and the
 * `status` field is a single label spanning all three. The screen must render
 * the timeline, not the label: a click is not a purchase, and `completed` on
 * this ledger is recorded by an **unsigned webhook stand-in**, not by a
 * verified payment event (§5.11, G16).
 */
export interface Upgrade {
  id: string;
  projectId: string;
  leadId: string | null;
  tier: string;
  status: string;
  /** Null when the deployment has no checkout URL configured for the tier. */
  checkoutUrl: string | null;
  stripeSessionId?: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function listUpgrades(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<Upgrade[]>(`/projects/${projectId}/delivery/upgrades`, options);
}

/**
 * Issues a Checkout link. 503s with `payment-unconfigured` when the tier's URL
 * env var is absent — in which case nothing is recorded, because a funnel step
 * that cannot proceed should not be persisted.
 */
export async function issueUpgrade(
  projectId: string,
  input: { tier: UpgradeTier; leadId?: string },
) {
  return api.post<Upgrade>(`/projects/${projectId}/delivery/upgrades`, input);
}

/** Records that the checkout link was opened. This is not a payment. */
export async function markUpgradeClicked(projectId: string, upgradeId: string) {
  return api.post<Upgrade>(`/projects/${projectId}/delivery/upgrades/${upgradeId}/click`);
}

// There is intentionally no `completeUpgrade` here. `POST
// /projects/:projectId/delivery/upgrades/:id/complete` is `@Public()` and
// stands in for the Stripe webhook until G16. Wiring it to a button would make
// a browser click the thing that grants a paid entitlement, which §5.11
// forbids outright.

/**
 * The result of asking the provider to send one email.
 *
 * ⚠️ `delivered: true` means the provider accepted the message. It does **not**
 * establish delivery, an open or a read — §5.10 says so explicitly — and no
 * screen built on this type may upgrade it to "sent and read".
 */
export interface DeliveryEmailResult {
  delivered: boolean;
  messageId?: string;
  to: string;
  reportUrl: string;
  /** Set when the provider is configured but the send failed — never a silent loss. */
  error?: string;
}

/**
 * Sends the handoff email: report link, booking CTA, and an optional
 * review/testimonial ask.
 *
 * 503s with `email-unconfigured` when the provider key is absent, and the
 * sender identity is the deployment's — neither is a per-send choice.
 */
export async function sendHandoffEmail(
  projectId: string,
  input: { reportUrl: string; to: string; subject?: string; includeTestimonialAsk?: boolean },
) {
  return api.post<DeliveryEmailResult>(`/projects/${projectId}/delivery/send`, input);
}

// ── SL01 · Intake ───────────────────────────────────────────────────────

export interface IntakeEnrichment {
  domain: string;
  company: string | null;
  category: string | null;
  description: string | null;
  country: string | null;
  competitors: Array<{
    name: string;
    domain: string | null;
    source: 'homepage-copy' | 'search-results' | 'operator-supplied';
  }>;
  ownEntities: string[];
  pagesFetched: number;
  enrichmentSource: 'homepage' | 'search' | 'both';
}

export interface IntakeSubjectResult extends IntakeEnrichment {
  projectId: string;
  created: boolean;
}

export interface IntakeBulkResult {
  submitted: number;
  created: number;
  /** Rows that were refused, with the reason — never silently dropped. */
  skipped: Array<{ domain: string; reason: string }>;
  /**
   * ⚠️ Enriched rows carry **no `projectId`**, unlike the single-subject route,
   * so a per-row result here cannot be linked back to a project from the
   * response alone. The screen says so rather than guessing.
   */
  enriched: IntakeEnrichment[];
}

/**
 * Enriches one domain: fetches the homepage, reads JSON-LD, positioning copy,
 * named competitors and country, and creates or attaches the project.
 *
 * Creates a project and spends real fetch/LLM work, so it is an explicit
 * operator action — never something a page does on load.
 */
export async function intakeSubject(input: {
  domain: string;
  company?: string;
  email?: string;
  phone?: string;
  description?: string;
  notes?: string;
  source?: 'public-form' | 'operator-console' | 'bulk-csv' | 'api';
}) {
  return api.post<IntakeSubjectResult>('/intake/subject', input);
}

/**
 * Bulk intake over **parsed JSON items**, not a multipart file — the browser
 * does the CSV parsing (§5.11). Rate-limited to 2 requests/minute because every
 * item triggers a full enrichment.
 */
export async function intakeBulk(items: Array<{ domain: string; company?: string }>) {
  return api.post<IntakeBulkResult>('/intake/bulk', { items });
}

// ── SL04 · Qualification maths ──────────────────────────────────────────

/** The chain, as the backend computes and persists it. Never re-derived here. */
export interface PipelineStages {
  deals: number;
  sqls: number;
  meetings: number;
  leads: number;
  visitors: number;
}

export interface PipelineMath {
  id: string;
  projectId: string;
  revenueTarget: number;
  acv: number;
  winRate: number;
  meetingToSql: number;
  leadToMeeting: number;
  visitorToLead: number;
  marketSize: number | null;
  stages: PipelineStages;
  /**
   * The backend's verdict, not a probability. `fiction` means the arithmetic
   * needs more visitors than the stated market contains, by more than
   * `fictionFactor` — it is a statement about the inputs, not about the market.
   */
  verdict: 'feasible' | 'fiction';
  /** Visitors ÷ market size. Null when no market size was supplied. */
  ratio: number | null;
  /** The disclosed threshold the verdict was judged against. Always present. */
  fictionFactor: number;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineMathInput {
  revenueTarget: number;
  acv: number;
  winRate: number;
  meetingToSql: number;
  leadToMeeting: number;
  visitorToLead: number;
  marketSize?: number;
}

/** Reads the stored model. 404s with a hint when the project has never computed one. */
export async function getPipelineMath(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<PipelineMath>(`/projects/${projectId}/pipeline-math`, options);
}

/** Computes and replaces the model from a full set of inputs. */
export async function savePipelineMath(projectId: string, input: PipelineMathInput) {
  return api.put<PipelineMath>(`/projects/${projectId}/pipeline-math`, input);
}

/**
 * Recomputes with a partial patch — unspecified inputs keep their stored value.
 * Useful for answering "what if the win rate were 30%?" during a live call
 * without committing the change.
 */
export async function recalcPipelineMath(
  projectId: string,
  patch: Partial<PipelineMathInput>,
) {
  return api.patch<PipelineMath>(`/projects/${projectId}/pipeline-math`, patch);
}

// ── SL05 · Scorecards ───────────────────────────────────────────────────

/** Exactly three per run, each carrying its own reproduction-grade evidence. */
export interface ScorecardProblem {
  /** Dimension slug (e.g. `machine-access`), not the human label. */
  dimension: string;
  /** 0–100, or null when the source evidence was missing. */
  value: number | null;
  why: string;
  fix: string;
  evidence: string[];
}

export interface ScorecardRun {
  id: string;
  projectId: string;
  score: number;
  band: string;
  /** The SOP guarantee: at least one problem the prospect could not have known. */
  nonObvious: boolean;
  depth: string;
  publicToken: string;
  createdAt: string;
  problems: ScorecardProblem[];
}

export async function listScorecards(projectId: string, options?: { signal?: AbortSignal }) {
  return api.get<ScorecardRun[]>(`/projects/${projectId}/scorecard`, options);
}

export async function getScorecard(
  projectId: string,
  runId: string,
  options?: { signal?: AbortSignal },
) {
  return api.get<ScorecardRun>(`/projects/${projectId}/scorecard/${runId}`, options);
}

/**
 * Runs a fresh diagnostic at the requested depth. This performs a new technical
 * audit and writes a new row — it is work, not a re-read, so it is always an
 * explicit operator action.
 */
export async function runScorecard(projectId: string, depth: 'free' | 'operator') {
  return api.post<ScorecardRun>(`/projects/${projectId}/scorecard`, undefined, {
    query: { depth },
  });
}

/**
 * The path the public token resolves to (PB02). It only answers when the
 * deployment sets `SCORECARD_PUBLIC=1`; otherwise the route 403s and the token
 * is operator-only. The screen says which, rather than handing out a link that
 * may not resolve.
 */
export function publicScorecardHref(projectId: string, publicToken: string): string {
  return `/shared/scorecards/${projectId}/${publicToken}`;
}
