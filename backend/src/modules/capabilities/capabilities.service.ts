/**
 * CapabilitiesService — G18: the readiness contract, and the one place other
 * modules record whether a provider actually worked.
 *
 * ## Two halves that must not blur
 *
 * **Config** is read from env on every request by
 * {@link CAPABILITY_REGISTRY}'s probes. It answers "is a key present?" and
 * nothing more.
 *
 * **Observation** lives in the `CapabilityStatus` row and is written *only* by
 * {@link recordSuccess}, {@link recordFailure}, {@link recordProbe} and
 * {@link withProbe}. `verified` flips to true on the first recorded success
 * and never from configuration — the literal acceptance criterion of the
 * package. A module that wants its capability to show as ready calls
 * {@link withProbe} around its provider call; nothing else can make it ready.
 *
 * ## Why the seeding exists
 *
 * `CapabilityStatus` starts empty, and `CadenceService.evaluatePrerequisites`
 * treats a missing row as *unknown, therefore not ready* — correctly, but it
 * means nothing is ever ready until something writes rows. The registry is the
 * list of keys that exist; `ensureSeeded` materialises a row per key with the
 * config-derived columns filled in and the observation columns left alone.
 * Seeding never invents an observation.
 *
 * @module capabilities.service
 */

import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import {
  CAPABILITY_REGISTRY,
  MOCK_DISCLOSURE,
  findCapability,
  type CapabilityDefinition,
  type EnvReader,
} from './capabilities.registry';
import type {
  BlockedBy,
  CapabilityProbe,
  CapabilityProbeResult,
  CapabilitySchedulerState,
  CapabilityState,
  CapabilityView,
  ClientCapabilityView,
} from './capabilities.types';

/** The caller, as far as readiness cares. */
export interface CapabilityCaller {
  userId: string;
  role: string;
  type: 'operator' | 'client';
  clientId?: string;
}

/** A `CapabilityStatus` row, as needed to derive a view. */
interface StatusRow {
  key: string;
  configured: boolean;
  verified: boolean;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  mockMode: boolean;
  checkedAt: Date;
}

/** Everything a view needs beyond the registry and the row. */
interface AuditContext {
  caller: CapabilityCaller;
  /** Null on the global route — project-scoped facts are then unknown, not true. */
  projectId: string | null;
  /** Mapped Google resources for this project, by service. */
  mappedGoogleServices: Set<string>;
  /** Google services the caller was granted by delegation on this project. */
  delegatedGoogleServices: Set<string>;
  /** Google services the caller connected for their own account. */
  ownGoogleServices: Set<string>;
  /** Per task kind, the project's cadence rule. */
  cadenceByTaskKind: Map<string, CapabilitySchedulerState>;
}

/** `lastError` is a diagnostic string, not an unbounded log line. */
const MAX_ERROR_LENGTH = 800;

@Injectable()
export class CapabilitiesService implements OnModuleInit {
  private readonly logger = new Logger(CapabilitiesService.name);
  private seeded = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Materialise a `CapabilityStatus` row for every registered key.
   *
   * Best-effort on boot: a database that is not yet reachable must not stop
   * the process starting, and the read path re-runs this if it finds the table
   * short.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureSeeded();
    } catch (err) {
      this.logger.warn(
        `Capability seeding deferred — the database was not ready at boot (${(err as Error).message}). ` +
          'The first read will seed instead.',
      );
    }
  }

  /** Trimmed, non-empty env read — the strictest predicate in the codebase. */
  private envReader(): EnvReader {
    return {
      // `?? fallback` rather than ConfigService's own overload: the registry
      // passes a plain string key, which the heavily-overloaded `get` signature
      // cannot resolve. Same semantics — an unset var yields the fallback.
      get: (key: string, fallback?: string) => this.config.get<string>(key) ?? fallback,
      has: (key: string) => {
        const v = this.config.get<string>(key);
        return typeof v === 'string' && v.trim().length > 0;
      },
      // ConfigService cannot enumerate, and the only capability that needs to
      // is the publishing family (`PUBLISH_CREDENTIAL_<SLUG>`), whose names are
      // derived from destination slugs. Read from the process env, which is
      // exactly where that module reads them from too.
      list: (prefix: string) =>
        Object.keys(process.env).filter(
          (k) => k.startsWith(prefix) && (process.env[k] ?? '').trim().length > 0,
        ),
    };
  }

  /**
   * Write a row per registered key, refreshing only the config-derived
   * columns. `verified`, `lastSuccessAt` and `lastError*` are deliberately
   * absent from the `update` — configuration must never overwrite an
   * observation.
   */
  async ensureSeeded(force = false): Promise<number> {
    if (this.seeded && !force) return 0;
    const env = this.envReader();
    let written = 0;

    for (const def of CAPABILITY_REGISTRY) {
      const probe = def.probe(env);
      const shared = {
        label: def.label,
        category: def.category,
        configured: probe.configured,
        mockMode: probe.mockMode,
        supports: JSON.stringify(def.supports),
        prerequisites: JSON.stringify(def.prerequisites),
        limits: JSON.stringify(def.limits),
      };
      await this.prisma.capabilityStatus.upsert({
        where: { key: def.key },
        create: { key: def.key, ...shared, verified: false },
        update: { ...shared, checkedAt: new Date() },
      });
      written += 1;
    }

    this.seeded = true;
    return written;
  }

  /** True when a row exists for every registered key. */
  private async isFullySeeded(): Promise<boolean> {
    const count = await this.prisma.capabilityStatus.count({
      where: { key: { in: CAPABILITY_REGISTRY.map((d) => d.key) } },
    });
    return count >= CAPABILITY_REGISTRY.length;
  }

  // ── the recording contract, for other modules ─────────────────────────

  /**
   * Record that a real provider call succeeded.
   *
   * This is the **only** way `verified` becomes true. Call it after a genuine
   * call — never after a configuration check, never optimistically before the
   * result is in.
   *
   * @throws Error when `key` is not in the registry. That is a programming
   *   error (a typo would otherwise create a phantom capability row), so it
   *   fails loudly and names the file to fix.
   */
  async recordSuccess(key: string, detail?: string): Promise<void> {
    this.assertRegistered(key);
    await this.prisma.capabilityStatus.update({
      where: { key },
      data: {
        verified: true,
        lastSuccessAt: new Date(),
        // The last error is no longer the last thing that happened.
        lastError: null,
        lastErrorAt: null,
        checkedAt: new Date(),
      },
    });
    this.logger.log(`Capability ${key} verified by a recorded successful call${detail ? `: ${detail}` : ''}`);
  }

  /**
   * Record that a provider call failed.
   *
   * `verified` is **not** cleared: it means "a real call has succeeded at
   * least once", and a later failure does not un-happen that. What changes is
   * that `lastErrorAt` becomes the most recent observation, which is what the
   * derived `degraded` state reads.
   */
  async recordFailure(key: string, error: string, opts: { mock?: boolean } = {}): Promise<void> {
    this.assertRegistered(key);
    await this.prisma.capabilityStatus.update({
      where: { key },
      data: {
        lastErrorAt: new Date(),
        lastError: error.slice(0, MAX_ERROR_LENGTH),
        ...(opts.mock === true ? { mockMode: true } : {}),
        checkedAt: new Date(),
      },
    });
    this.logger.warn(`Capability ${key} recorded a failed call: ${error.slice(0, 200)}`);
  }

  /** Record the outcome of a probe in one call. */
  async recordProbe(key: string, result: CapabilityProbeResult): Promise<void> {
    if (result.ok) {
      await this.recordSuccess(key, result.mock ? 'ran against fixtures' : undefined);
    } else {
      await this.recordFailure(key, result.error ?? 'The provider call failed without an error message.');
    }
  }

  /**
   * Run `fn` and record whether the provider call worked.
   *
   * The intended call site for a module that touches a provider: wrap the
   * network call, and readiness updates itself. A recording failure never
   * masks the original result — if the ledger write fails, the caller still
   * gets its answer or its error.
   */
  async withProbe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      await this.recordSafely(() => this.recordSuccess(key));
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordSafely(() => this.recordFailure(key, message));
      throw err;
    }
  }

  private async recordSafely(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.logger.warn(`Could not record the capability observation: ${(err as Error).message}`);
    }
  }

  private assertRegistered(key: string): void {
    if (!findCapability(key)) {
      throw new Error(
        `Capability "${key}" is not in the registry. Add a definition to ` +
          'modules/capabilities/capabilities.registry.ts rather than recording against an unregistered key — ' +
          'a row with no definition would report readiness nobody can act on.',
      );
    }
  }

  /**
   * Refuse to proceed unless a capability is genuinely ready.
   *
   * The server-side half of "no enabled button merely because an env key
   * exists": a route that would spend money or touch a provider calls this
   * first, so the rule holds even for a caller that never looked at the UI.
   *
   * `authorized` is treated as satisfied here on purpose — per-caller
   * authorization is the calling route's job (it already ran
   * `ScopeValidationService`), and folding it in would make this gate depend
   * on actor identity for a question that is about the provider. Pass
   * `projectId` to have the project-resource check included.
   *
   * @throws ServiceUnavailableException carrying the actionable state, not a generic error.
   */
  async assertReady(key: string, projectId?: string): Promise<void> {
    const def = findCapability(key);
    if (!def) {
      throw new ServiceUnavailableException(
        `Capability "${key}" is not registered, so its readiness is unknown and it is not assumed ready.`,
      );
    }
    await this.ensureSeeded();

    const { state, stateDetail, blockedBy } = await this.systemState(def, projectId ?? null, new Set([key]));
    if (state === 'ready') return;

    throw new ServiceUnavailableException(
      `${def.label} is not ready (${state}${blockedBy ? `: ${blockedBy}` : ''}). ${stateDetail}`,
    );
  }

  /**
   * Readiness for a server-side gate: config, observation and project
   * resource — but not the caller. `seen` breaks prerequisite cycles (a
   * mis-authored registry could otherwise recurse forever).
   */
  private async systemState(
    def: CapabilityDefinition,
    projectId: string | null,
    seen: Set<string>,
  ): Promise<{ state: CapabilityState; stateDetail: string; blockedBy: BlockedBy | null }> {
    const probe = def.probe(this.envReader());
    const row = await this.prisma.capabilityStatus.findUnique({ where: { key: def.key } });
    const unmetPrerequisites = await this.unmetPrerequisites(def, projectId, seen);

    return this.deriveState(def, probe, {
      verified: row?.verified ?? false,
      lastErrorAt: row?.lastErrorAt ?? null,
      authorized: true,
      resourceMapped: projectId ? await this.projectResourceMapped(def, projectId) : true,
      unmetPrerequisites,
    });
  }

  /** Prerequisite keys that are not ready, resolved recursively. */
  private async unmetPrerequisites(
    def: CapabilityDefinition,
    projectId: string | null,
    seen: Set<string>,
  ): Promise<string[]> {
    const unmet: string[] = [];
    for (const key of def.prerequisites) {
      if (seen.has(key)) continue;
      seen.add(key);
      const prereq = findCapability(key);
      if (!prereq) {
        unmet.push(key);
        continue;
      }
      const { state } = await this.systemState(prereq, projectId, seen);
      if (state !== 'ready') unmet.push(key);
    }
    return unmet;
  }

  /** Does this project have the resource the capability needs? */
  private async projectResourceMapped(def: CapabilityDefinition, projectId: string): Promise<boolean> {
    if (def.projectResource === null || def.projectResource === 'domain') return true;
    const service = def.projectResource === 'google-analytics' ? 'analytics' : 'search-console';
    const found = await this.prisma.googleProjectResource.findFirst({
      where: { projectId, service },
      select: { id: true },
    });
    return found !== null;
  }

  // ── reads ─────────────────────────────────────────────────────────────

  /** `GET /api/capabilities` — the operator roster. */
  async list(caller: CapabilityCaller) {
    const capabilities = await this.readViews(caller);
    return { capabilities, summary: this.summarise(capabilities), audience: 'operator' as const };
  }

  /** `GET /api/projects/:projectId/capabilities` — project-scoped readiness. */
  async listForProject(caller: CapabilityCaller, projectId: string) {
    const capabilities = await this.readViews(caller, projectId);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, domain: true },
    });
    return {
      projectId,
      project: project ? { id: project.id, name: project.name, domain: project.domain } : null,
      capabilities,
      summary: this.summarise(capabilities),
      audience: 'operator' as const,
    };
  }

  /**
   * The reduced client view.
   *
   * Built, not filtered: the shape has no field for an env var name, a
   * provider key, an internal error string or a blocked-by code, so there is
   * nothing to leak. Fixture mode still reaches the client — as
   * `dataSource: 'simulated-test'` with a disclosure sentence — because a
   * result a client has already seen must not be silently re-labelled as a
   * measurement.
   *
   * Only capabilities with a `clientFacing` block appear at all.
   */
  async listForClient(caller: CapabilityCaller, projectId: string) {
    const views = await this.readViews(caller, projectId);
    const byKey = new Map(views.map((v) => [v.key, v]));

    const capabilities: ClientCapabilityView[] = [];
    for (const def of CAPABILITY_REGISTRY) {
      if (!def.clientFacing) continue;
      const view = byKey.get(def.key);
      if (!view) continue;
      capabilities.push(this.toClientView(def, view));
    }

    return {
      projectId,
      audience: 'client' as const,
      capabilities,
      summary: {
        total: capabilities.length,
        available: capabilities.filter((c) => c.state === 'available').length,
        actionRequired: capabilities.filter((c) => c.state === 'action-required').length,
      },
      /** No infrastructure diagnostics on this surface, by construction. */
      note:
        'This view lists what Cailyx can measure for this project and what, if anything, is needed from you. ' +
        'Items that are not available yet say why in plain terms; nothing here exposes internal configuration.',
    };
  }

  /** Map an operator view onto the client shape. Nothing passes through untouched. */
  private toClientView(def: CapabilityDefinition, view: CapabilityView): ClientCapabilityView {
    const facing = def.clientFacing!;
    const simulated = view.mockMode;

    const state: ClientCapabilityView['state'] =
      view.state === 'ready'
        ? 'available'
        : view.state === 'unmapped' || view.state === 'unauthorized'
          ? 'action-required'
          : view.state === 'unverified' || view.state === 'degraded'
            ? 'unavailable'
            : 'not-set-up';

    const lastMeasuredAt = view.lastSuccessAt;

    return {
      capability: facing.capability,
      label: facing.label,
      description: facing.description,
      /**
       * Fixture output is never "available": a client must not be shown
       * simulated data behind a button that implies a measurement.
       */
      available: state === 'available' && !simulated,
      state: simulated && state === 'available' ? 'unavailable' : state,
      clientAction: state === 'available' && !simulated ? null : facing.clientAction,
      produces: facing.produces,
      lastMeasuredAt,
      dataSource: simulated ? 'simulated-test' : view.verified ? 'live' : 'unknown',
      dataSourceDisclosure: simulated ? MOCK_DISCLOSURE : null,
    };
  }

  /**
   * Derive one view per registered key.
   *
   * Two passes, because prerequisites refer to other capabilities: pass one
   * derives every state without the prerequisite check, pass two downgrades
   * anything whose prerequisite did not come out ready. Iterated to a fixed
   * point (bounded — the registry's graph is two levels deep) so a blocked
   * grandparent cannot leave a grandchild looking ready.
   */
  private async readViews(caller: CapabilityCaller, projectId?: string): Promise<CapabilityView[]> {
    if (!(await this.isFullySeeded())) await this.ensureSeeded(true);

    const env = this.envReader();
    const ctx = await this.buildContext(caller, projectId ?? null);

    const rows = await this.prisma.capabilityStatus.findMany({
      where: { key: { in: CAPABILITY_REGISTRY.map((d) => d.key) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, r as StatusRow]));

    const views = new Map<string, CapabilityView>();
    const probes = new Map<string, CapabilityProbe>();

    for (const def of CAPABILITY_REGISTRY) {
      const probe = def.probe(env);
      probes.set(def.key, probe);
      views.set(def.key, this.buildView(def, probe, byKey.get(def.key), ctx, []));
    }

    for (let pass = 0; pass < 3; pass += 1) {
      let changed = false;
      for (const def of CAPABILITY_REGISTRY) {
        const unmet = def.prerequisites.filter((p) => views.get(p)?.state !== 'ready');
        const current = views.get(def.key)!;
        if (unmet.length === current.unmetPrerequisites.length && unmet.every((u) => current.unmetPrerequisites.includes(u))) {
          continue;
        }
        views.set(def.key, this.buildView(def, probes.get(def.key)!, byKey.get(def.key), ctx, unmet));
        changed = true;
      }
      if (!changed) break;
    }

    for (const def of CAPABILITY_REGISTRY) {
      if (!byKey.has(def.key)) {
        this.logger.warn(
          `No CapabilityStatus row for ${def.key} after seeding — reporting it as unverified rather than assuming it works.`,
        );
      }
    }

    return CAPABILITY_REGISTRY.map((d) => views.get(d.key)!);
  }

  /** Load the caller/project facts every view needs, in one round. */
  private async buildContext(caller: CapabilityCaller, projectId: string | null): Promise<AuditContext> {
    const mappedGoogleServices = new Set<string>();
    const delegatedGoogleServices = new Set<string>();
    const ownGoogleServices = new Set<string>();
    const cadenceByTaskKind = new Map<string, CapabilitySchedulerState>();

    if (caller.userId) {
      const connections = await this.prisma.googleConnection.findMany({
        where: { userId: caller.userId },
        select: { service: true },
      });
      for (const c of connections) ownGoogleServices.add(c.service);
    }

    if (projectId) {
      const resources = await this.prisma.googleProjectResource.findMany({
        where: { projectId },
        select: { service: true },
      });
      for (const r of resources) mappedGoogleServices.add(r.service);

      if (caller.userId) {
        // ConnectionDelegation carries connectionId as a plain column (no
        // Prisma relation), so the service filter is a second lookup rather
        // than a join.
        const delegations = await this.prisma.connectionDelegation.findMany({
          where: { granteeUserId: caller.userId, projectId, revokedAt: null },
          select: { connectionId: true },
        });
        if (delegations.length > 0) {
          const delegated = await this.prisma.googleConnection.findMany({
            where: { id: { in: delegations.map((d) => d.connectionId) } },
            select: { service: true },
          });
          for (const c of delegated) delegatedGoogleServices.add(c.service);
        }
      }

      const rules = await this.prisma.cadenceRule.findMany({
        where: { projectId },
        select: {
          taskKind: true,
          enabled: true,
          frequency: true,
          nextRunAt: true,
          lastRunAt: true,
          lastStatus: true,
          pausedAt: true,
        },
      });
      for (const r of rules) {
        cadenceByTaskKind.set(r.taskKind, {
          taskKind: r.taskKind,
          enabled: r.enabled,
          frequency: r.frequency,
          nextRunAt: r.nextRunAt ? r.nextRunAt.toISOString() : null,
          lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
          lastStatus: r.lastStatus,
          pausedAt: r.pausedAt ? r.pausedAt.toISOString() : null,
        });
      }
    }

    return { caller, projectId, mappedGoogleServices, delegatedGoogleServices, ownGoogleServices, cadenceByTaskKind };
  }

  /** One capability's full operator view. */
  private buildView(
    def: CapabilityDefinition,
    probe: CapabilityProbe,
    row: StatusRow | undefined,
    ctx: AuditContext,
    unmetPrerequisites: string[],
  ): CapabilityView {
    // A missing row is "no observation", not "verified".
    const verified = row?.verified ?? false;
    const lastSuccessAt = row?.lastSuccessAt ?? null;
    const lastErrorAt = row?.lastErrorAt ?? null;
    const lastError = row?.lastError ?? null;

    const authorized = this.isAuthorized(def, ctx);
    const resourceMapped = this.isResourceMapped(def, ctx);

    const { state, stateDetail, blockedBy } = this.deriveState(def, probe, {
      verified,
      lastErrorAt,
      authorized,
      resourceMapped,
      unmetPrerequisites,
    });

    return {
      key: def.key,
      label: def.label,
      category: def.category,

      configured: probe.configured,
      verified,
      authorized,
      resourceMapped: ctx.projectId ? resourceMapped : null,

      state,
      stateDetail,
      // Always carried, not just in a problem state: provider preference
      // order and model ids are facts an operator wants whether or not the
      // capability happens to be degrading right now.
      operatorGuidance: probe.action,
      blockedBy,
      /** The acceptance criterion, as data: nothing is offered unless it is ready. */
      allowedActions: state === 'ready' ? [...def.actions] : [],
      retryable: state === 'unverified' || state === 'degraded',

      supportedProviders: [...def.supports],
      availableOutputs: [...def.outputs],
      prerequisites: [...def.prerequisites],
      unmetPrerequisites: [...unmetPrerequisites],
      limits: def.limits,

      mockMode: probe.mockMode,
      mockDisclosure: probe.mockMode ? MOCK_DISCLOSURE : null,

      lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
      lastErrorAt: lastErrorAt ? lastErrorAt.toISOString() : null,
      lastError,
      checkedAt: (row?.checkedAt ?? new Date()).toISOString(),

      envVars: [...probe.envVars],
      configDetail: probe.configDetail,

      ...(ctx.projectId
        ? {
            scheduler: def.taskKinds
              .map((k) => ctx.cadenceByTaskKind.get(k))
              .filter((s): s is CapabilitySchedulerState => s !== undefined),
          }
        : {}),
    };
  }

  /**
   * Derive the single-word state and its actionable sentence.
   *
   * Order is the whole design. Configuration and prerequisites outrank
   * everything because nothing downstream can be true without them; mock mode
   * outranks ready because a fixture must never earn a green light; and
   * `unverified` outranks `ready` because an env key is not evidence.
   */
  private deriveState(
    def: CapabilityDefinition,
    probe: CapabilityProbe,
    facts: {
      verified: boolean;
      lastErrorAt: Date | null;
      authorized: boolean;
      resourceMapped: boolean;
      unmetPrerequisites: string[];
    },
  ): { state: CapabilityState; stateDetail: string; blockedBy: BlockedBy | null } {
    if (!probe.configured) {
      return {
        state: 'unconfigured',
        stateDetail: probe.action,
        blockedBy: probe.blockedBy ?? 'credential-missing',
      };
    }
    if (facts.unmetPrerequisites.length > 0) {
      return {
        state: 'blocked',
        stateDetail:
          `Waiting on ${facts.unmetPrerequisites.join(', ')}. A capability is not usable while something it ` +
          'depends on is not ready.',
        blockedBy: 'prerequisite',
      };
    }
    if (probe.mockMode) {
      return { state: 'mock', stateDetail: probe.action, blockedBy: probe.blockedBy ?? 'mock-only' };
    }
    if (!facts.authorized) {
      return {
        state: 'unauthorized',
        stateDetail: def.perUserAuthorization
          ? 'Server configuration is fine, but your own account has not authorised this. Connect it, or have it delegated to you for this project.'
          : 'Your account is not authorised for this capability.',
        blockedBy: 'not-authorized',
      };
    }
    if (def.projectResource !== null && !facts.resourceMapped) {
      return {
        state: 'unmapped',
        stateDetail:
          def.projectResource === 'google-analytics'
            ? 'This project has no GA4 property mapped yet. Choose one on the project’s connections screen.'
            : def.projectResource === 'google-search-console'
              ? 'This project has no Search Console site mapped yet. Choose one on the project’s connections screen.'
              : `This project is missing the ${def.projectResource} it needs.`,
        blockedBy: 'resource-unmapped',
      };
    }
    if (!facts.verified) {
      return {
        state: 'unverified',
        stateDetail:
          'Configured, but nothing has successfully called it yet. Configuration is not evidence — run one ' +
          'measurement and the result is recorded here.',
        blockedBy: 'never-verified',
      };
    }
    if (facts.lastErrorAt !== null) {
      return {
        state: 'degraded',
        stateDetail: `${probe.action} The last recorded call failed after an earlier success.`,
        blockedBy: 'last-call-failed',
      };
    }
    return { state: 'ready', stateDetail: 'Verified by a recorded successful call.', blockedBy: null };
  }

  /**
   * May this caller use it?
   *
   * Only OAuth-backed capabilities are per-user; everything else is a server
   * credential, so any operator who can reach the project may use it.
   */
  private isAuthorized(def: CapabilityDefinition, ctx: AuditContext): boolean {
    if (!def.perUserAuthorization) return true;
    if (ctx.caller.type === 'client') return false;
    const service = def.key === 'google.analytics' ? 'analytics' : 'search-console';
    return (
      ctx.ownGoogleServices.has(service) || ctx.delegatedGoogleServices.has(service)
    );
  }

  /** Is the project wired to the resource this capability needs? */
  private isResourceMapped(def: CapabilityDefinition, ctx: AuditContext): boolean {
    if (def.projectResource === null) return true;
    if (def.projectResource === 'domain') return true;
    return ctx.mappedGoogleServices.has(
      def.projectResource === 'google-analytics' ? 'analytics' : 'search-console',
    );
  }

  private summarise(views: CapabilityView[]) {
    const byState: Record<string, number> = {};
    for (const v of views) byState[v.state] = (byState[v.state] ?? 0) + 1;
    return {
      total: views.length,
      ready: byState.ready ?? 0,
      byState,
      /** Every capability currently running against fixtures. Always disclosed. */
      mockModeKeys: views.filter((v) => v.mockMode).map((v) => v.key),
    };
  }
}
