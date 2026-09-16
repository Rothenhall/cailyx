import { api } from '@/lib/api';

/**
 * Shared-surface adapter — PB01 (shared report) and PB02 (shared scorecard).
 *
 * Both screens are reached by someone who is **not signed in**, so everything
 * here has to work with no session and has to be honest about the little it can
 * know. Two rules from design_plan §10.5 and §6.4 shape the file:
 *
 *  1. **The public projection is a frozen snapshot.** Neither function below
 *     reads live data, and neither can: `/reports/:slug/render` serves the
 *     stored report, and the scorecard route serves a stored run row.
 *  2. **Fetched HTML is never trusted application markup.** `sharedReportUrl`
 *     returns a URL for a link or a sandboxed frame — deliberately not a string
 *     of HTML. There is no function here that returns the report's markup for
 *     insertion into the page, so no caller can inject it by accident.
 */

// ── PB01 — the shared report ────────────────────────────────────────────

export type SharedReportView = 'executive' | 'detailed';

/**
 * The backend-rendered HTML report.
 *
 * This is the actual public link the reporting module documents: a report whose
 * `visibility` is `public` opens here for anyone with the URL and no login. A
 * private report answers 404 unless the request carries a valid operator
 * bearer — which the same-origin session proxy may add when the reader happens
 * to be signed in, so an operator can preview their own private report through
 * the same URL.
 *
 * Because those two cases answer **identically**, a 404 is rendered as a
 * neutral "missing or private" and never as "this exists but is not yours".
 */
export function sharedReportUrl(
  projectId: string,
  slug: string,
  view: SharedReportView = 'executive',
): string {
  const query = view === 'detailed' ? '?view=detailed' : '';
  return `/api/projects/${encodeURIComponent(projectId)}/reports/${encodeURIComponent(slug)}/render${query}`;
}

/**
 * Ask the server whether this link resolves, before framing it.
 *
 * The page needs to distinguish "this link opens" from "this link does not"
 * *before* it draws a frame, because an iframe containing a 404 body renders
 * the backend's error page as if it were the report. A `null` return means the
 * server refused (404/403) and the caller should render the neutral
 * missing-or-private state.
 *
 * The body is deliberately discarded: it is HTML, and §10.5 forbids handing
 * fetched markup to a component. Only the resolution is used.
 */
export async function resolveSharedReport(
  projectId: string,
  slug: string,
  view: SharedReportView,
  options?: { signal?: AbortSignal },
): Promise<boolean> {
  try {
    await api.get<unknown>(sharedReportUrl(projectId, slug, view), options);
    return true;
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'kind' in cause) {
      const kind = (cause as { kind: string }).kind;
      // Missing and private are the same answer here on purpose. Any other
      // class (a 503, a network drop) is a real failure and must surface as
      // one rather than as "this report is not available".
      if (kind === 'not-found' || kind === 'forbidden') return false;
    }
    throw cause;
  }
}

// ── PB02 — the shared scorecard ─────────────────────────────────────────

/** One named, specific problem on the scorecard (exactly three per run). */
export interface ScorecardProblem {
  /** Scoring dimension it comes from (machine-access, entity-clarity, …). */
  dimension: string;
  /** Dimension value 0-100; null when the source evidence is missing. */
  value: number | null;
  /** The specific, named problem — a first-class evidence line. */
  why: string;
  /** Deterministic next move for this dimension. */
  fix: string;
  /** Reproduction-grade supporting evidence lines. */
  evidence: string[];
}

export interface PublicScorecard {
  id: string;
  projectId: string;
  score: number;
  band: string;
  problems: ScorecardProblem[];
  /** The SOP guarantee: at least one problem the prospect could not know. */
  nonObvious: boolean;
  /** `free` (a low-depth subset) or `operator`. */
  depth: string;
  publicToken: string;
  createdAt: string;
}

/** Raised when the token resolves to a run belonging to a different project. */
export class SharedScorecardMismatch extends Error {
  constructor() {
    super('The scorecard token does not belong to the project in this URL.');
    this.name = 'SharedScorecardMismatch';
  }
}

/**
 * Read a scorecard by its public share token.
 *
 * The token is the only credential a visitor holds, and it is what scopes the
 * read — `projectId` from the URL is used here only as a **check**, never to
 * widen or narrow the query. If the token belongs to a different project than
 * the URL claims, this raises `SharedScorecardMismatch` so the screen can
 * render the same neutral not-found it shows for an unknown token rather than
 * confirming that some other project's scorecard exists.
 *
 * A 403 means the public scorecard funnel is switched off
 * (`SCORECARD_PUBLIC` is not 1) — an explicit unavailable state, not a
 * not-found, and not something to retry.
 */
export async function getPublicScorecard(
  projectId: string,
  token: string,
  options?: { signal?: AbortSignal },
): Promise<PublicScorecard> {
  const scorecard = await api.get<PublicScorecard>(
    `/projects/${encodeURIComponent(projectId)}/scorecard/public/${encodeURIComponent(token)}`,
    options,
  );
  if (scorecard.projectId !== projectId) throw new SharedScorecardMismatch();
  if (!Array.isArray(scorecard.problems)) {
    // §10.2 — a response missing the field the screen is built on is a bug to
    // surface, not an empty scorecard to render.
    throw new Error('The scorecard response carried no `problems` list.');
  }
  return scorecard;
}

export type ScorecardCtaType = 'book-call' | 'review-ask' | 'upgrade-click';

export interface ScorecardCtaResult {
  leadId: string;
  projectId: string;
  leadCreated: boolean;
  ctaEvents: number;
  nextStep: string;
}

/**
 * Record a CTA from the shared scorecard.
 *
 * Scoped by the same token as the read. Supplying an email requires
 * `consent: true`, and the request is refused without it rather than silently
 * accepted — the record's whole point is that the person agreed. Omitting the
 * email records an anonymous click against the scorecard, which is a legitimate
 * and useful signal on its own.
 */
export async function captureScorecardCta(
  token: string,
  input: {
    type: ScorecardCtaType;
    email?: string;
    name?: string;
    consent?: boolean;
    meta?: Record<string, unknown>;
  },
): Promise<ScorecardCtaResult> {
  return api.post<ScorecardCtaResult>(
    `/public/scorecard/${encodeURIComponent(token)}/cta`,
    input,
  );
}
