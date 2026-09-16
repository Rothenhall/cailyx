/**
 * Shared types for G18 — the usable capability/readiness contract.
 *
 * ## The four things that must never be collapsed
 *
 * design_plan.md G18's acceptance criterion is literal: *"no enabled button
 * merely because an env key exists"*. A single boolean cannot carry that, so
 * every capability is reported with four independent facts:
 *
 * | Fact | Question it answers | Where it comes from |
 * |---|---|---|
 * | `configured` | Is the server config present? | env, recomputed every read |
 * | `verified`   | Has a real call actually succeeded? | a recorded observation, never config |
 * | `authorized` | May *this caller* use it? | per-user connection / delegation |
 * | `resourceMapped` | Is this project wired to a resource? | `GoogleProjectResource` etc. |
 *
 * `state` and `allowedActions` are then *derived* from all four for the
 * button. `allowedActions` is empty unless `state === 'ready'`, which is the
 * acceptance criterion expressed as data rather than as a UI rule that could
 * be forgotten.
 *
 * ## Two audiences, two shapes
 *
 * {@link CapabilityView} is the operator surface: it names env vars, the
 * blocked reason and the last raw error, because an operator needs those to
 * fix anything. {@link ClientCapabilityView} is a genuinely separate, reduced
 * DTO — it is *built*, not filtered. It carries no env var names, no provider
 * keys, no internal error text and no blocked-by codes.
 *
 * @module capabilities.types
 */

/** Grouping for the connections screen (OP15/OP16). */
export const CAPABILITY_CATEGORIES = [
  'aeo-engine',
  'ai-surface',
  'serp-data',
  'analytics',
  'site-health',
  'social',
  'llm',
  'content',
  'email',
  'billing',
  'infrastructure',
  'mode',
] as const;
export type CapabilityCategory = (typeof CAPABILITY_CATEGORIES)[number];

/**
 * Machine-readable "why not ready". Codes, not prose, so the UI can pick an
 * icon and the operator-facing `action` can stay a sentence. These are
 * **operator-only** — the client DTO has no equivalent field.
 */
export const BLOCKED_BY = [
  /** The credential/env var is not set at all. */
  'credential-missing',
  /** A cross-cutting master switch (e.g. SWARM_ALLOW_LIVE) is off. */
  'master-switch-off',
  /** A browser surface is enabled but no session path is configured. */
  'session-missing',
  /** A session path is configured but the file is not on disk. */
  'session-file-missing',
  /** Another capability this one depends on is not ready. */
  'prerequisite',
  /** The caller is not authorized for it (per-user OAuth, delegation). */
  'not-authorized',
  /** This project has no resource mapped (GSC site / GA4 property). */
  'resource-unmapped',
  /** Configured, but nothing has ever actually called it. */
  'never-verified',
  /** The last recorded attempt failed — provider outage or a rejected credential. */
  'last-call-failed',
  /** Running against fixtures; a production action must not be enabled from here. */
  'mock-only',
] as const;
export type BlockedBy = (typeof BLOCKED_BY)[number];

/**
 * The derived, single-word answer for the button.
 *
 * Order of precedence is deliberate and lives in
 * `CapabilitiesService.deriveState`: an unmet prerequisite and an
 * unconfigured credential outrank everything, because nothing downstream of
 * them can be true; mock mode outranks "ready" because a fixture result must
 * never be presented as a measurement; and `unverified`/`degraded` outrank
 * `ready` because configuration alone never earns a green light.
 */
export const CAPABILITY_STATES = [
  'ready',
  'unverified',
  'unconfigured',
  'blocked',
  'mock',
  'degraded',
  'unauthorized',
  'unmapped',
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

/** A project-scoped resource a capability needs before it can act on the project. */
export type ProjectResourceKind = 'google-search-console' | 'google-analytics' | 'domain';

/** Live, config-derived facts. Recomputed on every read; never stored. */
export interface CapabilityProbe {
  configured: boolean;
  mockMode: boolean;
  /** Null when nothing about the configuration is wrong. */
  blockedBy: BlockedBy | null;
  /** What a human should do next. Never empty. */
  action: string;
  /** Env var names involved. **Operator surface only.** */
  envVars: string[];
  /** Extra operator-only detail (session path, model id, actor map). */
  configDetail: string | null;
}

/** What a provider call reports back, recorded into `CapabilityStatus`. */
export interface CapabilityProbeResult {
  ok: boolean;
  /** The raw error when `ok` is false. Truncated to the column's practical length. */
  error?: string;
  /** Set when the call ran against a fixture rather than the real provider. */
  mock?: boolean;
}

/** Scheduler state for one capability on one project. */
export interface CapabilitySchedulerState {
  taskKind: string;
  enabled: boolean;
  frequency: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  /** Set while the parent client/engagement is paused. */
  pausedAt: string | null;
}

/**
 * The operator view — `GET /api/capabilities` and
 * `GET /api/projects/:projectId/capabilities`.
 *
 * Carries the four facts *and* the derived state, so a caller can render the
 * button from `allowedActions` without re-deriving anything, and can still
 * show the four separately when the reason matters.
 */
export interface CapabilityView {
  key: string;
  label: string;
  category: CapabilityCategory;

  // ── the four independent facts ──
  /** Server config is present. Says nothing about whether it works. */
  configured: boolean;
  /** A real call has succeeded and been recorded. Never derived from config. */
  verified: boolean;
  /** This caller may use it. */
  authorized: boolean;
  /** This project is wired to the resource it needs. Null on the global route. */
  resourceMapped: boolean | null;

  // ── derived ──
  state: CapabilityState;
  /** Why it is in this state, in one sentence. Never empty. */
  stateDetail: string;
  /**
   * What an operator should know or do about this capability's configuration,
   * independent of its state — provider preference order, which model is in
   * use, what a fix would be. Kept separate from `stateDetail` so it is not
   * lost once the capability becomes ready.
   */
  operatorGuidance: string;
  blockedBy: BlockedBy | null;
  /**
   * Actions the server will currently accept, e.g. `['aeo.run']`. **Empty
   * unless `state === 'ready'`** — this is the acceptance criterion.
   */
  allowedActions: string[];
  /** True when retrying the provider call is a sensible next step. */
  retryable: boolean;

  // ── provider facts ──
  supportedProviders: string[];
  availableOutputs: string[];
  prerequisites: string[];
  /** Prerequisite keys that are not ready, in the same order. */
  unmetPrerequisites: string[];
  limits: Record<string, unknown>;

  // ── disclosure ──
  /** Fixture mode. Present on every capability that could be affected by it. */
  mockMode: boolean;
  /**
   * The sentence to show when `mockMode` is true. Null otherwise. Kept as a
   * field rather than left to the caller so the disclosure cannot be dropped.
   */
  mockDisclosure: string | null;

  // ── observations ──
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  /** Operator-only: the raw provider error, as recorded. */
  lastError: string | null;
  checkedAt: string;

  // ── operator-only diagnostics ──
  /** Env var names. Never serialized into the client DTO. */
  envVars: string[];
  /** Operator-only config detail. Never serialized into the client DTO. */
  configDetail: string | null;

  /** Present on the project route only. */
  scheduler?: CapabilitySchedulerState[];
}

/**
 * The reduced client view.
 *
 * Built explicitly rather than filtered from {@link CapabilityView}: there is
 * no field here that could leak an env var name, a provider key, an internal
 * error string or a blocked-by code, because no such field exists on the
 * shape. `dataSource` is how fixture mode stays visible to a client without
 * handing them an infrastructure diagnostic.
 */
export interface ClientCapabilityView {
  /** A client-meaningful slug (`ai-visibility`), never an internal key (`aeo.cloro.gemini`). */
  capability: string;
  label: string;
  description: string;
  available: boolean;
  state: 'available' | 'action-required' | 'not-set-up' | 'unavailable';
  /** What the client can do about it, when they can do anything. */
  clientAction: string | null;
  /** What this capability measures, in client terms. */
  produces: string[];
  /** When the underlying data was last measured. Null means not measured yet. */
  lastMeasuredAt: string | null;
  /**
   * `live` — real provider data. `simulated-test` — fixtures, disclosed so a
   * test result is never read as a measurement. `unknown` — nothing recorded.
   */
  dataSource: 'live' | 'simulated-test' | 'unknown';
  /** Present only for `simulated-test`, so the disclosure cannot be forgotten. */
  dataSourceDisclosure: string | null;
}
