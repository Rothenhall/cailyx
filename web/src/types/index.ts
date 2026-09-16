/**
 * Shared vocabulary for design_plan.md §3.3's pattern components.
 *
 * These types exist so a "measured" value, an "unmeasured" one, and a
 * "compared to a real baseline" one are three different shapes at the type
 * level — not three states a screen has to remember to check by convention.
 */

/** §3.3 Provenance badge: the six provenance classes and nothing else. */
export type ProvenanceKind =
  | 'measured'
  | 'model-interpretation'
  | 'operator-supplied'
  | 'discovered-candidate'
  | 'derived'
  | 'unmeasured';

/**
 * §3.3 Run status strip states.
 *
 * `cancelled` is included deliberately: design_plan §10.4 requires a
 * cancellation to say whether already-spent or irreversible work remains, which
 * means a stopped run must be visibly distinguishable from one that finished.
 * Folding it into `failed` would misreport an operator's deliberate action as a
 * fault.
 */
export type RunStatus = 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';

/** A named stage within a run, e.g. "Crawling sitemap" or "Scoring pages". */
export interface RunStage {
  name: string;
  /** Progress counts when the backend provides them. Never fabricate these
   *  to animate a bar — §3.4 forbids simulated progress. */
  counts?: { completed: number; total: number };
}

export interface RunSummary {
  id: string;
  status: RunStatus;
  /** ISO 8601. */
  startedAt: string;
  completedAt?: string;
  stage?: RunStage;
}

/** §3.3 Coverage panel: one source/check that did not complete, and why. */
export interface CoverageIssue {
  name: string;
  reason: string;
}

export interface CoverageSummary {
  expectedCount: number;
  successfulCount: number;
  failed?: CoverageIssue[];
  deferred?: CoverageIssue[];
}

/**
 * A baseline the caller explicitly asserts is methodologically comparable to
 * the current value — same metric definition, same measurement method,
 * same unit. `MetricTile` will not compute or show a delta without one of
 * these; there is no way to pass "just a number" as a delta (§3.3, §3.5 "No
 * comparison baseline").
 */
export interface ComparableBaseline {
  /** A literal discriminant the caller must write out — this is what makes
   *  "I asserted this is comparable" a conscious, visible choice at the call
   *  site rather than an implicit default. */
  comparable: true;
  value: number;
  runId: string;
  /** ISO 8601 date the baseline run/measurement is from. */
  runDate: string;
  /** e.g. "vs previous cycle", "vs 30 days prior". */
  label?: string;
}

/** Where a metric's underlying data was last captured. */
export interface SourceDateInfo {
  /** ISO 8601. */
  date: string;
  sourceName?: string;
}

/** §3.3 Work row. */
export type WorkStatus = 'not-started' | 'in-progress' | 'blocked' | 'in-review' | 'done';

export interface WorkItem {
  id: string;
  deliverable: string;
  owner: string;
  /** ISO 8601 date, or undefined if no due date is set. */
  dueDate?: string;
  status: WorkStatus;
  blocker?: string;
  evidenceHref?: string;
  nextAction?: string;
}

/** §3.3 Approval card. */
export type ApprovalDecision = 'pending' | 'approved' | 'changes-requested' | 'rejected';

export interface ApprovalItem {
  id: string;
  /** The exact version/artifact under review, e.g. "Article draft v3". */
  version: string;
  requestor: string;
  reviewer?: string;
  dueDate?: string;
  decisionRequested: string;
  /** What happens if no decision is made by the due date. */
  delayConsequence?: string;
  decision: ApprovalDecision;
}

/** §3.3 Change comparison. */
export interface ChangeComparisonSide {
  id: string;
  /** ISO 8601. */
  date: string;
  value: number;
}

export interface ChangeComparisonData {
  before: ChangeComparisonSide;
  after: ChangeComparisonSide;
  unit: string;
  /** Whether the two runs used a compatible methodology. When false, the
   *  component must say so instead of implying a clean comparison. */
  methodologyCompatible: boolean;
  /** Deployments/changes that occurred between before and after, if known. */
  relevantDeployments?: string[];
}

/** §3.3 Scope banner. */
export interface ScopeContext {
  clientName?: string;
  domain?: string;
  market?: string;
  projectName?: string;
  runLabel?: string;
  /** 'live' reads current data; 'snapshot' pins to a released report version. */
  mode: 'live' | 'snapshot';
  snapshotLabel?: string;
}

/** §3.3 Run configurator. */
export interface RunPrerequisite {
  label: string;
  met: boolean;
  detail?: string;
}

export interface RunParameter {
  key: string;
  label: string;
  value: string;
}

export interface RunEstimate {
  requests?: number;
  costCredits?: number;
  costCurrency?: number;
  currencyCode?: string;
}
