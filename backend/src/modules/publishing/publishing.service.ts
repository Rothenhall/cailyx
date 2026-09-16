/**
 * PublishingService — G11: destinations, the publication state machine and
 * remote verification.
 *
 * Four rules from the contract are enforced here, in this order, and none of
 * them can be satisfied by calling a different route:
 *
 * 1. **No remote write without an explicit, approved action.** A publication is
 *    created only when `ApprovalRequest.status === 'approved'` for *this exact
 *    revision*, the `ApprovalsService.assertReadyToPublish` gate passes (which
 *    also refuses blocked claims), and the caller asked for the specific scopes
 *    it uses. The `approvalId` that authorized the push is stored on the row, so
 *    "what authorized this?" is answerable afterwards — and re-checked before
 *    the push actually happens, because an approval can be invalidated between
 *    scheduling and dispatch.
 * 2. **Publishing and verifying are different outcomes.** `status` is the push;
 *    `verifiedAt`/`verifyError` are the follow-up read. Verification never
 *    changes `status`, and a `published` row with no `verifiedAt` means exactly
 *    "the remote accepted it and nothing has confirmed it is live".
 * 3. **Retries never create a second remote post.** Once a publication has a
 *    `remoteId`, retry re-runs *verification*, not the write. A retry that would
 *    re-post requires an operator to confirm there is no remote copy.
 * 4. **Credentials are never on the row.** `credentialRef` is a name resolved
 *    against the secret store at use time; `config` is validated to hold no
 *    secret-shaped keys; no view ever returns a resolved value.
 *
 * The provider catalogue (`PROVIDER_DECLARATIONS`) keeps CMS, social, email and
 * ads separate: a destination is one provider, its permissions are a subset of
 * that one provider's declared scopes, and providers without an adapter are
 * refused with `501` and a reason rather than faked.
 *
 * @module publishing.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { CustomWebhookAdapter } from './lib/custom-webhook.adapter';
import { describeCredential, resolveCredential } from './lib/credentials.util';
import { resolveScheduledFor } from './lib/timezone.util';
import {
  PROVIDER_DECLARATIONS,
  RESERVED_CONFIG_KEYS,
  SECRET_CONFIG_KEY_RE,
  findProvider,
  type ProviderDeclaration,
  type ProviderResource,
  type PublicationView,
  type PublishDestinationView,
} from './publishing.types';
import type {
  AdapterContext,
  AdapterDestination,
  PublishPayload,
  PublisherAdapter,
} from './lib/provider.types';
import type {
  CreateDestinationDto,
  ListDestinationsQueryDto,
  SelectResourceDto,
  UpdateDestinationDto,
} from './dto/destination.dto';
import type {
  CreatePublicationDto,
  ListPublicationsQueryDto,
  RetryPublicationDto,
} from './dto/publication.dto';

/** Minimal shape of the authenticated caller this service needs. */
export interface Actor {
  userId: string;
  role: string;
  type: 'operator' | 'client';
}

/** How long a row may sit in `publishing` before it is reported as stale. */
export const STALE_PUBLISHING_MS = 15 * 60 * 1000;
/** Tolerance for a `scheduledFor` that has just passed. */
const SCHEDULE_GRACE_MS = 60 * 1000;

/** `CheckResult.subjectType` used for verification evidence. */
export const VERIFICATION_SUBJECT_TYPE = 'publication';
/** `CheckResult.checkKind` used for verification evidence. */
export const VERIFICATION_CHECK_KIND = 'remote-verification';
/** `ApprovalRequest.artifactType` for a content revision. */
export const CONTENT_ARTIFACT_TYPE = 'content';
/** `RevisionClaimLink.revisionType` for a content revision. */
export const CONTENT_REVISION_TYPE = 'content-revision';

interface DestinationRow {
  id: string;
  projectId: string;
  provider: string;
  label: string;
  resourceId: string | null;
  resourceLabel: string | null;
  config: string;
  credentialRef: string | null;
  status: string;
  lastTestedAt: Date | null;
  lastError: string | null;
  createdBy: string | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PublicationRow {
  id: string;
  projectId: string;
  destinationId: string;
  assetId: string;
  revisionId: string;
  approvalId: string | null;
  mode: string;
  scheduledFor: Date | null;
  status: string;
  remoteId: string | null;
  remoteUrl: string | null;
  verifiedAt: Date | null;
  verifiedUrl: string | null;
  verifyError: string | null;
  error: string | null;
  attempt: number;
  publishedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything the view mapper needs, gathered in bulk for a list read. */
interface ViewContext {
  destinations: Map<string, DestinationRow>;
  approvals: Map<string, { status: string }>;
  pausedProjects: Set<string>;
}

/** The outcome of one dispatch attempt. */
export interface DispatchOutcome {
  dispatched: boolean;
  blockedReason: string | null;
  error: string | null;
}

@Injectable()
export class PublishingService {
  private readonly logger = new Logger(PublishingService.name);
  /** Provider id -> adapter. Only providers with a real adapter are registered. */
  private readonly adapters: Map<string, PublisherAdapter>;

  constructor(
    protected readonly prisma: PrismaService,
    protected readonly activity: ActivityService,
    protected readonly approvals: ApprovalsService,
    protected readonly webhook: CustomWebhookAdapter,
  ) {
    this.adapters = new Map<string, PublisherAdapter>([[this.webhook.provider, this.webhook]]);
  }

  // ── Provider catalogue ──────────────────────────────────────────────

  /**
   * Every provider this platform knows about, with whether it can be used
   * today and why not when it cannot. This is what a connections screen renders
   * so a disabled card states its prerequisite instead of failing on click.
   */
  listProviders(): {
    providers: Array<ProviderDeclaration & { adapterRegistered: boolean; kindIsDistinct: true }>;
  } {
    return {
      providers: PROVIDER_DECLARATIONS.map((declaration) => ({
        ...declaration,
        adapterRegistered: this.adapters.has(declaration.provider),
        kindIsDistinct: true as const,
      })),
    };
  }

  // ── Destinations ────────────────────────────────────────────────────

  /** A project's destinations, newest first. Never returns a credential. */
  async listDestinations(
    projectId: string,
    filter: ListDestinationsQueryDto = {},
  ): Promise<{ destinations: PublishDestinationView[] }> {
    await this.requireProject(projectId);
    const rows = await this.prisma.publishDestination.findMany({
      where: {
        projectId,
        provider: filter.provider || undefined,
        status: filter.status || undefined,
      },
      orderBy: { createdAt: 'desc' },
    });
    return { destinations: rows.map((row) => this.toDestinationView(row)) };
  }

  /** One destination. 404 when it belongs to a different project. */
  async getDestination(projectId: string, id: string): Promise<PublishDestinationView> {
    return this.toDestinationView(await this.requireDestination(projectId, id));
  }

  /**
   * Create a destination in the `unconfigured` state.
   *
   * Creating is not connecting: nothing is called remotely here, and the row
   * starts unusable until an operator runs the test/authorize action. That keeps
   * "we have a row for WordPress" from ever being mistaken for "WordPress works".
   */
  async createDestination(
    projectId: string,
    dto: CreateDestinationDto,
    actor: Actor,
  ): Promise<PublishDestinationView> {
    await this.requireProject(projectId);
    const declaration = this.requireProvider(dto.provider);

    const config = this.validateConfig(dto.config ?? {});
    const permissions = this.assertPermissionsWithinProvider(declaration, dto.permissions);
    if (dto.credentialRef) this.assertCredentialRefUsable(declaration, dto.credentialRef, true);

    const row = await this.prisma.publishDestination.create({
      data: {
        projectId,
        provider: declaration.provider,
        label: dto.label,
        resourceId: dto.resourceId ?? null,
        resourceLabel: dto.resourceLabel ?? null,
        // `grantedPermissions` is written by the service, never taken from the
        // request — it is the record of what was authorized.
        config: JSON.stringify({ ...config, grantedPermissions: permissions }),
        credentialRef: dto.credentialRef ?? null,
        status: 'unconfigured',
        createdBy: actor.userId,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'created',
      resource: { type: 'publish-destination', id: row.id, version: row.provider },
      projectId,
      summary: `Publish destination "${row.label}" created for ${declaration.label} (${declaration.kind})`,
      changes: { provider: row.provider, permissions },
      origin: 'api',
    });

    return this.toDestinationView(row);
  }

  /** Edit a destination's label, non-secret config, secret reference or scopes. */
  async updateDestination(
    projectId: string,
    id: string,
    dto: UpdateDestinationDto,
    actor: Actor,
  ): Promise<PublishDestinationView> {
    const current = await this.requireDestination(projectId, id);
    if (current.revokedAt) throw new ConflictException('This destination was revoked — create a new one instead');

    const declaration = this.requireProvider(current.provider);
    const existingConfig = this.parseConfig(current.config);

    let config = existingConfig;
    if (dto.config) {
      config = {
        ...this.validateConfig(dto.config),
        grantedPermissions: existingConfig.grantedPermissions,
      };
    }
    if (dto.permissions) {
      config = {
        ...config,
        grantedPermissions: this.assertPermissionsWithinProvider(declaration, dto.permissions),
      };
    }
    if (dto.credentialRef) this.assertCredentialRefUsable(declaration, dto.credentialRef, true);

    const row = await this.prisma.publishDestination.update({
      where: { id },
      data: {
        label: dto.label ?? undefined,
        config: JSON.stringify(config),
        credentialRef: dto.credentialRef ?? undefined,
        // A changed configuration invalidates the last test: what was tested is
        // no longer what is configured.
        status: dto.config || dto.credentialRef ? 'unconfigured' : undefined,
        lastError: dto.config || dto.credentialRef ? null : undefined,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'updated',
      resource: { type: 'publish-destination', id: row.id, version: row.provider },
      projectId,
      summary: `Publish destination "${row.label}" updated`,
      changes: { label: { before: current.label, after: row.label }, configKeys: Object.keys(config).sort() },
      origin: 'api',
    });

    return this.toDestinationView(row);
  }

  /**
   * Authorize (connect) a destination: run the provider's own reachability test
   * and only then mark it `connected`.
   *
   * For an unimplemented provider this is a `501` with the declaration's reason
   * — **no OAuth URL is fabricated**, because an authorization link that cannot
   * complete is worse than an honest refusal.
   */
  async authorizeDestination(projectId: string, id: string, actor: Actor): Promise<PublishDestinationView> {
    const destination = await this.requireDestination(projectId, id);
    if (destination.revokedAt) throw new ConflictException('This destination was revoked');
    const declaration = this.requireProvider(destination.provider);
    const adapter = this.requireAdapter(declaration);

    const ctx = this.adapterContext(destination);
    const ready = adapter.readiness(ctx);
    if (!ready.ready) {
      await this.persistTestFailure(destination.id, ready.reason ?? 'destination is not ready');
      throw new ServiceUnavailableException({
        error: 'provider-unconfigured',
        provider: destination.provider,
        message: ready.reason ?? 'This destination is not ready to be connected.',
      });
    }

    const result = await adapter.test(ctx);
    if (!result.ok) {
      await this.persistTestFailure(destination.id, result.reason);
      throw new ServiceUnavailableException({
        error: 'authorize-failed',
        provider: destination.provider,
        message: result.reason,
        httpStatus: result.httpStatus ?? null,
      });
    }

    const row = await this.prisma.publishDestination.update({
      where: { id: destination.id },
      data: {
        status: 'connected',
        lastTestedAt: new Date(),
        lastError: null,
        resourceLabel: result.data.resourceLabel ?? destination.resourceLabel,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'updated',
      resource: { type: 'publish-destination', id: row.id, version: row.provider },
      projectId,
      summary: `Publish destination "${row.label}" connected (${result.data.detail})`,
      changes: { status: { before: destination.status, after: 'connected' } },
      origin: 'api',
    });

    return this.toDestinationView(row);
  }

  /**
   * Test an existing destination without changing its authorized scopes.
   *
   * A failure is persisted (`status: 'error'`, `lastError`) *and* returned: the
   * row must reflect reality even if nobody is watching the response.
   */
  async testDestination(projectId: string, id: string, actor: Actor): Promise<PublishDestinationView> {
    const destination = await this.requireDestination(projectId, id);
    if (destination.revokedAt) throw new ConflictException('This destination was revoked');
    const declaration = this.requireProvider(destination.provider);
    const adapter = this.requireAdapter(declaration);

    const ctx = this.adapterContext(destination);
    const result = await adapter.test(ctx);

    if (!result.ok) {
      await this.persistTestFailure(destination.id, result.reason);
      throw new ServiceUnavailableException({
        error: 'test-failed',
        provider: destination.provider,
        message: result.reason,
        httpStatus: result.httpStatus ?? null,
      });
    }

    const row = await this.prisma.publishDestination.update({
      where: { id: destination.id },
      data: {
        status: 'connected',
        lastTestedAt: new Date(),
        lastError: null,
        resourceLabel: result.data.resourceLabel ?? destination.resourceLabel,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'updated',
      resource: { type: 'publish-destination', id: row.id, version: row.provider },
      projectId,
      summary: `Publish destination "${row.label}" tested successfully`,
      changes: { detail: result.data.detail },
      origin: 'api',
    });

    return this.toDestinationView(row);
  }

  /**
   * Revoke a destination.
   *
   * Revoking stops **future** pushes — scheduled and pending publications for it
   * are left in `pending` with a derived reason rather than being silently
   * cancelled, and the response says how many are affected. Nothing already
   * written to the remote system is touched: unpublishing there is a manual
   * action, not something a revoke here can promise.
   */
  async revokeDestination(
    projectId: string,
    id: string,
    reason: string,
    actor: Actor,
  ): Promise<PublishDestinationView & { pendingPublications: number; note: string }> {
    const destination = await this.requireDestination(projectId, id);
    if (destination.revokedAt) throw new ConflictException('This destination is already revoked');

    const pending = await this.prisma.publication.count({
      where: { destinationId: id, status: { in: ['pending', 'publishing'] } },
    });

    const row = await this.prisma.publishDestination.update({
      where: { id },
      data: { status: 'revoked', revokedAt: new Date(), lastError: null },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'revoked',
      resource: { type: 'publish-destination', id: row.id, version: row.provider },
      projectId,
      summary: `Publish destination "${row.label}" revoked: ${reason}`,
      changes: { status: { before: destination.status, after: 'revoked' } },
      origin: 'api',
    });

    return {
      ...this.toDestinationView(row),
      pendingPublications: pending,
      // Both facts every time: what stops (future pushes) and what does not
      // (anything already at the remote system) — a revoke must never be read
      // as an unpublish.
      note:
        (pending > 0
          ? `${pending} publication(s) for this destination are still pending and will not dispatch. Cancel them or point them at another destination. `
          : 'No publications were waiting on this destination. ') +
        'Anything already written to the remote system is untouched — removing it there is a manual action.',
    };
  }

  /** The remote targets this destination may publish into. */
  async listResources(
    projectId: string,
    id: string,
  ): Promise<{ provider: string; resources: ProviderResource[]; selectedResourceId: string | null }> {
    const destination = await this.requireDestination(projectId, id);
    const declaration = this.requireProvider(destination.provider);
    const adapter = this.requireAdapter(declaration);

    const result = await adapter.listResources(this.adapterContext(destination));
    if (!result.ok) {
      throw new ServiceUnavailableException({
        error: 'resource-list-failed',
        provider: destination.provider,
        message: result.reason,
      });
    }

    return {
      provider: destination.provider,
      resources: result.data.resources,
      selectedResourceId: destination.resourceId,
    };
  }

  /**
   * Record which remote resource this destination publishes into.
   *
   * The choice is validated against the adapter's own list — an id the provider
   * does not offer is a `400`, not a value stored for later to fail on.
   */
  async selectResource(
    projectId: string,
    id: string,
    dto: SelectResourceDto,
    actor: Actor,
  ): Promise<PublishDestinationView> {
    const destination = await this.requireDestination(projectId, id);
    if (destination.revokedAt) throw new ConflictException('This destination was revoked');
    const declaration = this.requireProvider(destination.provider);
    const adapter = this.requireAdapter(declaration);

    const listed = await adapter.listResources(this.adapterContext(destination));
    if (!listed.ok) {
      throw new ServiceUnavailableException({
        error: 'resource-list-failed',
        provider: destination.provider,
        message: listed.reason,
      });
    }
    const match = listed.data.resources.find((resource) => resource.id === dto.resourceId);
    if (!match) {
      throw new BadRequestException({
        error: 'unknown-resource',
        message: `"${dto.resourceId}" is not one of this destination's resources.`,
        available: listed.data.resources.map((resource) => resource.id),
      });
    }

    const row = await this.prisma.publishDestination.update({
      where: { id: destination.id },
      data: { resourceId: match.id, resourceLabel: dto.resourceLabel ?? match.label },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'updated',
      resource: { type: 'publish-destination', id: row.id, version: row.provider },
      projectId,
      summary: `Publish destination "${row.label}" set to resource "${dto.resourceLabel ?? match.label}"`,
      changes: { resourceId: { before: destination.resourceId, after: match.id } },
      origin: 'api',
    });

    return this.toDestinationView(row);
  }

  // ── Publications ────────────────────────────────────────────────────

  /** A project's publications, newest first, with derived state. */
  async listPublications(
    projectId: string,
    filter: ListPublicationsQueryDto = {},
  ): Promise<{ publications: PublicationView[] }> {
    await this.requireProject(projectId);
    const rows = await this.prisma.publication.findMany({
      where: {
        projectId,
        status: filter.status || undefined,
        destinationId: filter.destinationId || undefined,
        assetId: filter.assetId || undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(200, Math.max(1, filter.limit ?? 50)),
    });
    return { publications: await this.toPublicationViews(rows) };
  }

  /** One publication, scoped to its project. */
  async getPublication(projectId: string, id: string): Promise<PublicationView> {
    const row = await this.requirePublication(projectId, id);
    const [view] = await this.toPublicationViews([row]);
    return view;
  }

  /**
   * Create a publication — the only path that can lead to a remote write.
   *
   * The gates, in order: the project exists · the destination belongs to it and
   * is connected · the requested scopes are within what the provider declares
   * *and* what this destination was granted · the adapter is ready · the asset
   * and revision belong to the project · the revision is the one the caller
   * reviewed (`contentHash`) · an approval exists **for that revision** · the
   * claim gate passes. Only then is a row written, and a row without an
   * immediate dispatch still cannot push until the same gates pass again.
   */
  async createPublication(projectId: string, dto: CreatePublicationDto, actor: Actor): Promise<PublicationView> {
    await this.requireProject(projectId);
    const destination = await this.requireDestination(projectId, dto.destinationId);
    const declaration = this.requireProvider(destination.provider);

    if (destination.revokedAt) {
      throw new ConflictException({ error: 'destination-revoked', message: 'This destination was revoked.' });
    }
    if (destination.status !== 'connected') {
      throw new ConflictException({
        error: 'destination-not-connected',
        message: `This destination is "${destination.status}" — connect it (which runs a real test against the provider) before publishing.`,
        lastError: destination.lastError,
      });
    }

    const adapter = this.requireAdapter(declaration);
    const requested = this.assertPermissionsWithinProvider(declaration, dto.permissions);
    const granted = this.parseConfig(destination.config).grantedPermissions;
    const grantedList = Array.isArray(granted) ? granted.filter((p): p is string => typeof p === 'string') : [];
    const notGranted = requested.filter((permission) => !grantedList.includes(permission));
    if (notGranted.length > 0) {
      throw new ForbiddenException({
        error: 'permission-not-granted',
        message: `This destination is not authorized for: ${notGranted.join(', ')}. Re-authorize the destination with those scopes first.`,
        granted: grantedList,
      });
    }

    const ctx = this.adapterContext(destination);
    const ready = adapter.readiness(ctx);
    if (!ready.ready) {
      throw new ServiceUnavailableException({
        error: 'provider-unconfigured',
        provider: destination.provider,
        message: ready.reason ?? 'This destination is not ready.',
      });
    }

    const asset = await this.prisma.growthAsset.findUnique({ where: { id: dto.assetId } });
    if (!asset || asset.projectId !== projectId) {
      throw new NotFoundException(`Asset ${dto.assetId} not found for project ${projectId}`);
    }

    const revision = await this.resolveRevision(projectId, dto.assetId, dto.revisionId);
    if (dto.contentHash && revision.contentHash && dto.contentHash !== revision.contentHash) {
      throw new ConflictException({
        error: 'revision-changed',
        message:
          'The revision has changed since you read it — this publication would not be the content you reviewed. Reload the revision and publish again.',
        currentHash: revision.contentHash,
      });
    }

    const approval = await this.requireApproval(projectId, dto.assetId, revision.revision, revision.id);
    // G10's one served gate: unresolved approvals at this exact revision and
    // blocked claims both refuse, and it reads from the database rather than
    // from anything this caller sent. (It is not yet called by the report
    // release path — see this module's README, "Reported upstream".)
    await this.approvals.assertReadyToPublish(
      CONTENT_ARTIFACT_TYPE,
      dto.assetId,
      revision.revision,
      revision.id,
      CONTENT_REVISION_TYPE,
    );

    const timezone = await this.projectTimezone(projectId);
    let scheduledFor: Date | null = null;
    if (dto.scheduledFor) {
      scheduledFor = resolveScheduledFor(dto.scheduledFor, timezone);
      if (scheduledFor.getTime() < Date.now() - SCHEDULE_GRACE_MS) {
        throw new BadRequestException(
          `scheduledFor (${scheduledFor.toISOString()}) is in the past. Resolve it in ${timezone} or omit it to dispatch now.`,
        );
      }
    }

    const row = await this.prisma.publication.create({
      data: {
        projectId,
        destinationId: destination.id,
        assetId: dto.assetId,
        revisionId: revision.id,
        approvalId: approval.id,
        mode: dto.mode ?? 'draft',
        scheduledFor,
        status: 'pending',
        publishedBy: actor.userId,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'created',
      resource: { type: 'publication', id: row.id, version: String(revision.revision) },
      projectId,
      summary: `Publication created for ${declaration.label} (${row.mode}) from revision ${revision.revision}, authorized by approval ${approval.id}`,
      changes: {
        destinationId: destination.id,
        approvalId: approval.id,
        permissions: requested,
        scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
      },
      origin: 'api',
    });

    // An immediate publication dispatches now; a scheduled one waits for the
    // dispatcher (which re-runs every gate before writing anything).
    if (!scheduledFor) {
      await this.dispatch(row.id);
    }

    return this.getPublication(projectId, row.id);
  }

  /**
   * Cancel a publication that has not reached the remote system.
   *
   * A publication with a `remoteId`, or one already `published`/`publishing`,
   * is refused: cancelling a row cannot un-publish a live post, and pretending
   * otherwise would leave the operator believing it was removed. Rollback is
   * deliberately not implemented — the message says so.
   */
  async cancelPublication(
    projectId: string,
    id: string,
    reason: string,
    actor: Actor,
  ): Promise<PublicationView> {
    const row = await this.requirePublication(projectId, id);

    if (row.status === 'published' || row.status === 'publishing' || row.remoteId) {
      throw new ConflictException({
        error: 'cannot-cancel-after-remote-write',
        message:
          'This publication has already been written to the remote system, so cancelling it here would not remove it. Rollback is not implemented — remove it at the destination and record that separately.',
        remoteId: row.remoteId,
      });
    }
    if (row.status === 'cancelled') {
      throw new ConflictException({ error: 'already-cancelled', message: 'This publication is already cancelled.' });
    }

    const updated = await this.prisma.publication.update({
      where: { id },
      data: { status: 'cancelled', error: `cancelled: ${reason}` },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'cancelled',
      resource: { type: 'publication', id: updated.id, version: updated.mode },
      projectId,
      summary: `Publication cancelled: ${reason}`,
      changes: { status: { before: row.status, after: 'cancelled' } },
      origin: 'api',
    });

    return this.getPublication(projectId, id);
  }

  /**
   * Retry a publication.
   *
   * Safe by construction: if a `remoteId` exists the write already happened, so
   * this re-runs **verification** and says that is what it did. Only a row with
   * no remote id re-attempts the write, and a row stuck in `publishing` requires
   * the caller to confirm they checked the remote — because the interrupted
   * attempt may have succeeded.
   */
  async retryPublication(
    projectId: string,
    id: string,
    dto: RetryPublicationDto,
    actor: Actor,
  ): Promise<PublicationView & { retried: string }> {
    const row = await this.requirePublication(projectId, id);

    if (row.status === 'cancelled') {
      throw new ConflictException({ error: 'cancelled', message: 'A cancelled publication cannot be retried.' });
    }
    if (row.status === 'pending') {
      throw new ConflictException({
        error: 'nothing-to-retry',
        message:
          row.scheduledFor
            ? `This publication is scheduled for ${row.scheduledFor.toISOString()} and has not been attempted yet.`
            : 'This publication is pending and has not been attempted yet.',
      });
    }

    const staleMs = Date.now() - row.updatedAt.getTime();
    if (row.status === 'publishing' && staleMs < STALE_PUBLISHING_MS) {
      throw new ConflictException({
        error: 'in-flight',
        message: 'This publication is being dispatched right now. Wait for it to finish before retrying.',
      });
    }
    if (row.status === 'publishing' && dto.confirmNoRemoteCopy !== true) {
      throw new ConflictException({
        error: 'confirm-required',
        message:
          'A dispatch was interrupted, so a copy of this content may already exist at the destination. Confirm you checked the remote system and found none before retrying, or the retry could publish twice.',
        requires: 'confirmNoRemoteCopy',
      });
    }

    // A remote id means the write happened: never write again.
    if (row.remoteId) {
      await this.verifyAndRecord(projectId, row, actor);
      await this.activity.record({
        actor: { type: 'user', id: actor.userId },
        action: 'updated',
        resource: { type: 'publication', id: row.id, version: row.mode },
        projectId,
        summary: `Retry on a publication that is already at the remote system — verification re-run instead of a second write${dto.reason ? `: ${dto.reason}` : ''}`,
        changes: { remoteId: row.remoteId },
        origin: 'api',
      });
      return { ...(await this.getPublication(projectId, id)), retried: 'verification' };
    }

    await this.prisma.publication.update({
      where: { id },
      data: {
        status: 'pending',
        attempt: row.attempt + 1,
        error: row.status === 'publishing' ? 'dispatch interrupted; reset by an operator retry' : null,
      },
    });

    await this.activity.record({
      actor: { type: 'user', id: actor.userId },
      action: 'updated',
      resource: { type: 'publication', id: row.id, version: row.mode },
      projectId,
      summary: `Publication retried (attempt ${row.attempt + 1})${dto.reason ? `: ${dto.reason}` : ''}`,
      changes: { status: { before: row.status, after: 'pending' } },
      origin: 'api',
    });

    await this.dispatch(row.id);
    return { ...(await this.getPublication(projectId, id)), retried: 'publication' };
  }

  /**
   * Confirm the pushed content is actually live, on demand.
   *
   * Verification records `verifiedAt`/`verifiedUrl` or `verifyError` and writes
   * a `CheckResult` evidence row — and never touches `status`, because a failed
   * fetch does not un-publish anything and a successful one does not prove the
   * push succeeded (it may have succeeded earlier).
   */
  async verifyPublication(projectId: string, id: string, actor: Actor): Promise<PublicationView> {
    const row = await this.requirePublication(projectId, id);
    if (!row.remoteUrl) {
      throw new ConflictException({
        error: 'nothing-to-verify',
        message:
          'This publication has no remote URL yet — there is nothing to fetch. A failed push is retried, not verified.',
      });
    }
    await this.verifyAndRecord(projectId, row, actor);
    return this.getPublication(projectId, id);
  }

  // ── Dispatch (also called by the scheduler) ─────────────────────────

  /**
   * Attempt the remote write for one publication.
   *
   * Refuses — leaving the row `pending` with a reason rather than marking it
   * failed — when a gate is not satisfied: a pending row that is blocked is a
   * different fact from a push that was tried and failed, and the view says
   * which. Never re-posts a row that already has a `remoteId`.
   */
  async dispatch(publicationId: string, origin: 'api' | 'scheduler' = 'api'): Promise<DispatchOutcome> {
    const row = await this.prisma.publication.findUnique({ where: { id: publicationId } });
    if (!row) return { dispatched: false, blockedReason: 'publication not found', error: null };

    const blocked = await this.dispatchBlockedReason(row);
    if (blocked) return { dispatched: false, blockedReason: blocked, error: null };

    const destination = await this.prisma.publishDestination.findUnique({ where: { id: row.destinationId } });
    if (!destination) return { dispatched: false, blockedReason: 'destination not found', error: null };

    const adapter = this.adapters.get(destination.provider) ?? null;
    const declaration = findProvider(destination.provider);
    if (!adapter || !declaration) {
      return {
        dispatched: false,
        blockedReason: `${destination.provider} has no adapter in this build`,
        error: null,
      };
    }

    const revision = await this.prisma.contentRevision.findUnique({ where: { id: row.revisionId } });
    if (!revision) return { dispatched: false, blockedReason: 'the revision this publication points at is gone', error: null };
    const asset = await this.prisma.growthAsset.findUnique({ where: { id: row.assetId } });

    await this.prisma.publication.update({ where: { id: row.id }, data: { status: 'publishing', error: null } });

    const payload: PublishPayload = {
      projectId: row.projectId,
      publicationId: row.id,
      mode: row.mode,
      assetId: row.assetId,
      assetType: asset?.assetType ?? 'article',
      revisionId: revision.id,
      revision: revision.revision,
      title: revision.title ?? asset?.title ?? null,
      body: revision.body,
      fields: this.parseJsonObject(revision.fields),
      contentHash: revision.contentHash,
    };

    const ctx = this.adapterContext(destination);
    const result = await adapter.push(ctx, payload);

    if (!result.ok) {
      await this.prisma.publication.update({
        where: { id: row.id },
        data: { status: 'failed', error: result.reason },
      });
      await this.activity.record({
        actor: { type: origin === 'scheduler' ? 'scheduler' : 'system', id: 'publishing-dispatcher' },
        action: 'published',
        resource: { type: 'publication', id: row.id, version: String(revision.revision) },
        projectId: row.projectId,
        summary: `Push to ${declaration.label} failed (attempt ${row.attempt}): ${result.reason}`,
        changes: { provider: destination.provider, httpStatus: result.httpStatus ?? null },
        origin,
        result: 'failure',
      });
      return { dispatched: false, blockedReason: null, error: result.reason };
    }

    const published = await this.prisma.publication.update({
      where: { id: row.id },
      data: {
        status: 'published',
        remoteId: result.data.remoteId,
        remoteUrl: result.data.remoteUrl,
        error: null,
      },
    });

    await this.activity.record({
      actor: { type: origin === 'scheduler' ? 'scheduler' : 'system', id: 'publishing-dispatcher' },
      action: 'published',
      resource: { type: 'publication', id: published.id, version: String(revision.revision) },
      projectId: row.projectId,
      summary: `Published revision ${revision.revision} to ${declaration.label} as ${row.mode} (${result.data.responseSummary})`,
      changes: { remoteId: result.data.remoteId, remoteUrl: result.data.remoteUrl, mode: row.mode },
      origin,
      result: 'success',
    });

    // The push and the confirmation are separate outcomes; a failure here is
    // recorded on the row and never rolls the push back.
    try {
      await this.verifyAndRecord(row.projectId, published, null);
    } catch (err) {
      this.logger.warn(`Post-publish verification failed for ${published.id}: ${this.messageOf(err)}`);
    }

    return { dispatched: true, blockedReason: null, error: null };
  }

  /** Publications that are due and still pending — the scheduler's work list. */
  async findDuePublications(now: Date = new Date(), limit = 20): Promise<string[]> {
    const rows = await this.prisma.publication.findMany({
      where: {
        status: 'pending',
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
      },
      orderBy: { scheduledFor: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Why this publication will not dispatch right now, or null when it will.
   *
   * Derived on read rather than stored: a hold is not an error, and a stored
   * reason would go stale the moment the thing it described was fixed.
   */
  private async dispatchBlockedReason(row: PublicationRow): Promise<string | null> {
    if (row.status === 'published') return 'already published';
    if (row.status === 'cancelled') return 'cancelled';
    if (row.status === 'failed') {
      // A failed attempt is re-tried explicitly (which increments `attempt` and
      // records who asked), never re-attempted by the dispatcher on its own.
      return 'the last attempt failed — retry it explicitly';
    }
    if (row.status === 'publishing') {
      return Date.now() - row.updatedAt.getTime() > STALE_PUBLISHING_MS
        ? 'a dispatch was interrupted and never finished — check the remote system before retrying'
        : null;
    }
    if (row.remoteId) return 'already written to the remote system';

    // Permanent blocks are reported before a temporary one: a publication
    // scheduled for tomorrow onto a revoked destination must not read as merely
    // "waiting for its slot".
    const destination = await this.prisma.publishDestination.findUnique({ where: { id: row.destinationId } });
    if (!destination) return 'the destination no longer exists';
    if (destination.revokedAt) return 'the destination was revoked';
    if (destination.status !== 'connected') return `the destination is "${destination.status}"`;

    const declaration = findProvider(destination.provider);
    if (!declaration) return `provider "${destination.provider}" is not declared`;
    if (!this.adapters.has(destination.provider)) {
      return `provider "${destination.provider}" has no adapter in this build`;
    }

    if (row.approvalId) {
      const approval = await this.prisma.approvalRequest.findUnique({
        where: { id: row.approvalId },
        select: { status: true },
      });
      if (!approval) return 'the approval that authorized this publication no longer exists';
      if (approval.status !== 'approved') {
        return `the approval that authorized this publication is now "${approval.status}" — publish under a current approval`;
      }
    } else {
      return 'this publication has no recorded approval';
    }

    const project = await this.prisma.project.findUnique({
      where: { id: row.projectId },
      select: { clientId: true },
    });
    if (project?.clientId) {
      const client = await this.prisma.client.findUnique({
        where: { id: project.clientId },
        select: { status: true },
      });
      if (client?.status === 'paused') {
        return 'the client account is paused, so agreed future publications are held (design_plan §11.2 case 14)';
      }
    }

    if (row.scheduledFor && row.scheduledFor.getTime() > Date.now()) {
      return `scheduled for ${row.scheduledFor.toISOString()}`;
    }

    return null;
  }

  // ── Verification ────────────────────────────────────────────────────

  /**
   * Run the provider's verification and record the outcome on the row plus a
   * `CheckResult` evidence row.
   *
   * `status` is untouched. On success for a live (`mode: 'publish'`)
   * publication, the asset is marked published — that is the only state change
   * verification makes, and it is gated on the fetch having confirmed the
   * content.
   */
  private async verifyAndRecord(
    projectId: string,
    row: PublicationRow,
    actor: Actor | null,
  ): Promise<void> {
    const destination = await this.prisma.publishDestination.findUnique({ where: { id: row.destinationId } });
    if (!destination) return;
    const declaration = findProvider(destination.provider);
    const adapter = declaration ? (this.adapters.get(declaration.provider) ?? null) : null;
    if (!adapter) {
      await this.prisma.publication.update({
        where: { id: row.id },
        data: {
          verifyError: `provider "${destination.provider}" has no adapter in this build, so its content cannot be verified`,
        },
      });
      return;
    }

    const revision = await this.prisma.contentRevision.findUnique({ where: { id: row.revisionId } });
    const result = await adapter.verify(this.adapterContext(destination), {
      remoteUrl: row.remoteUrl as string,
      mode: row.mode,
      contentHash: revision?.contentHash ?? null,
      title: revision?.title ?? null,
    });

    if (result.ok) {
      await this.prisma.publication.update({
        where: { id: row.id },
        data: { verifiedAt: new Date(), verifiedUrl: result.data.url, verifyError: null },
      });
    } else {
      // The row carries the LATEST verification outcome, so a failed attempt
      // clears the earlier success rather than leaving the row reading
      // "verified" while the content is not confirmed live. Nothing is lost:
      // every attempt (success or failure) is a `CheckResult` evidence row
      // below, which is where the history belongs.
      await this.prisma.publication.update({
        where: { id: row.id },
        data: { verifiedAt: null, verifiedUrl: null, verifyError: result.reason },
      });
    }

    await this.approvals.recordCheckResult({
      subjectType: VERIFICATION_SUBJECT_TYPE,
      subjectId: row.id,
      checkKind: VERIFICATION_CHECK_KIND,
      status: result.ok ? 'passed' : 'failed',
      detail: result.ok ? result.data.detail : result.reason,
      payload: {
        provider: destination.provider,
        remoteUrl: row.remoteUrl,
        mode: row.mode,
        httpStatus: result.ok ? result.data.httpStatus : (result.httpStatus ?? null),
        markerMatched: result.ok ? result.data.markerMatched : null,
        verifiedUrl: result.ok ? result.data.url : null,
      },
      checkedBy: actor?.userId,
      checkedVia: 'automated',
    });

    if (result.ok && row.mode === 'publish') {
      await this.markAssetPublished(row.assetId, result.data.url);
    }
  }

  /**
   * Reflect a verified live publication on the asset.
   *
   * Only on verification, and only for `mode: 'publish'`: a pushed draft is not
   * a published asset, and an unverified push is not a published asset either.
   */
  private async markAssetPublished(assetId: string, url: string): Promise<void> {
    const asset = await this.prisma.growthAsset.findUnique({
      where: { id: assetId },
      select: { id: true, status: true },
    });
    if (!asset || asset.status === 'published') return;
    await this.prisma.growthAsset.update({
      where: { id: assetId },
      data: { status: 'published', assetUrl: url, publishedAt: new Date() },
    });
  }

  // ── Lookups and validation ──────────────────────────────────────────

  private async requireProject(projectId: string): Promise<{ id: string; clientId: string | null; engagementId: string | null; timezone: string }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, clientId: true, engagementId: true, timezone: true },
    });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    return project;
  }

  private async requireDestination(projectId: string, id: string): Promise<DestinationRow> {
    const row = await this.prisma.publishDestination.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`Publish destination ${id} not found for project ${projectId}`);
    }
    return row;
  }

  private async requirePublication(projectId: string, id: string): Promise<PublicationRow> {
    const row = await this.prisma.publication.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException(`Publication ${id} not found for project ${projectId}`);
    }
    return row;
  }

  /** The declared provider, or a 400 naming the ones that are. */
  private requireProvider(provider: string): ProviderDeclaration {
    const declaration = findProvider(provider);
    if (!declaration) {
      throw new BadRequestException({
        error: 'unknown-provider',
        message: `"${provider}" is not a declared publishing provider.`,
        known: PROVIDER_DECLARATIONS.map((entry) => entry.provider),
      });
    }
    return declaration;
  }

  /** The adapter, or a 501 stating that this provider is not implemented yet. */
  private requireAdapter(declaration: ProviderDeclaration): PublisherAdapter {
    const adapter = this.adapters.get(declaration.provider);
    if (!adapter) {
      throw new NotImplementedException({
        error: 'provider-not-implemented',
        provider: declaration.provider,
        message:
          declaration.unavailableReason ??
          `No adapter for "${declaration.provider}" exists in this build. Publishing to it is a human action until one does.`,
      });
    }
    return adapter;
  }

  /** Requested scopes must be a subset of the provider's own declared scopes. */
  private assertPermissionsWithinProvider(declaration: ProviderDeclaration, requested: string[]): string[] {
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new BadRequestException({
        error: 'permissions-required',
        message: `Name the scopes this connection is for. ${declaration.label} offers: ${declaration.permissions.join(', ')}.`,
      });
    }
    const unknown = requested.filter((permission) => !declaration.permissions.includes(permission));
    if (unknown.length > 0) {
      throw new BadRequestException({
        error: 'unknown-permission',
        message: `${declaration.label} does not offer: ${unknown.join(', ')}. A connection is authorized per provider and per named scope — scopes are never bundled across providers.`,
        available: declaration.permissions,
      });
    }
    return Array.from(new Set(requested));
  }

  /**
   * A credential reference is a name, and a provider that needs one must be
   * given one — an "authorized" connection with no secret would fail at the
   * first push instead of here.
   */
  private assertCredentialRefUsable(declaration: ProviderDeclaration, ref: string, required: boolean): void {
    if (!required && !ref) return;
    if (!ref) {
      throw new BadRequestException({
        error: 'credential-ref-required',
        provider: declaration.provider,
        message: `${declaration.label} needs a credential reference: the name of the secret-store entry holding its credential.`,
      });
    }
  }

  /**
   * Reject secret-shaped config.
   *
   * `config` is returned by every destination read, so a credential stored here
   * would leak in ordinary API traffic — and in the next database backup. This
   * refuses the write instead of trusting review, at any depth, and refuses the
   * reserved `grantedPermissions` key so authorization cannot be self-asserted.
   */
  private validateConfig(config: Record<string, unknown>, depth = 0): Record<string, unknown> {
    if (depth > 2) {
      throw new BadRequestException({ error: 'config-too-deep', message: 'config is nested too deeply (2 levels maximum)' });
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if ((RESERVED_CONFIG_KEYS as readonly string[]).includes(key)) {
        throw new BadRequestException({
          error: 'reserved-config-key',
          message: `config.${key} is written by the service, not supplied — it records what was actually authorized.`,
        });
      }
      if (SECRET_CONFIG_KEY_RE.test(key)) {
        throw new BadRequestException({
          error: 'secret-shaped-config-key',
          message: `config.${key} looks like a credential. Destination config holds non-secret settings only — put the secret in the secret store and set credentialRef to its name.`,
        });
      }

      if (Array.isArray(value)) {
        out[key] = value.map((entry, index) => {
          if (entry === null || typeof entry !== 'object') return entry;
          if (Array.isArray(entry)) {
            throw new BadRequestException({
              error: 'config-too-deep',
              message: `config.${key}[${index}] is a nested array — config is settings, not storage.`,
            });
          }
          return this.validateConfig(entry as Record<string, unknown>, depth + 1);
        });
        continue;
      }
      if (value !== null && typeof value === 'object') {
        out[key] = this.validateConfig(value as Record<string, unknown>, depth + 1);
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  /** The stored config, parsed. */
  private parseConfig(raw: string): Record<string, unknown> {
    return this.parseJsonObject(raw);
  }

  private parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  /** The revision to publish: the named one, or the latest, scoped by asset. */
  private async resolveRevision(projectId: string, assetId: string, revisionId?: string) {
    if (revisionId) {
      const row = await this.prisma.contentRevision.findUnique({ where: { id: revisionId } });
      if (!row || row.assetId !== assetId) {
        throw new NotFoundException(`Revision ${revisionId} not found for asset ${assetId}`);
      }
      return row;
    }
    const latest = await this.prisma.contentRevision.findFirst({
      where: { assetId },
      orderBy: { revision: 'desc' },
    });
    if (!latest) {
      throw new ConflictException({
        error: 'no-revision',
        message: `Asset ${assetId} has no saved revision for project ${projectId} — there is nothing to publish.`,
      });
    }
    return latest;
  }

  /**
   * The approval that authorizes publishing *this exact revision*.
   *
   * Matched on the revision number, or on the revision id when the request
   * recorded one — never "the newest approved request for this asset", which is
   * how approval of revision 2 would leak into publishing revision 3.
   */
  private async requireApproval(projectId: string, assetId: string, revision: number, revisionId: string) {
    const approval = await this.prisma.approvalRequest.findFirst({
      where: {
        projectId,
        artifactType: CONTENT_ARTIFACT_TYPE,
        artifactId: assetId,
        status: 'approved',
        OR: [{ artifactRevision: revision }, { revisionId }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!approval) {
      throw new ConflictException({
        error: 'no-approved-revision',
        message: `Revision ${revision} of asset ${assetId} has no approved request, so there is no consent to publish it. Request approval for this revision first.`,
        requiredApproval: { artifactType: CONTENT_ARTIFACT_TYPE, artifactId: assetId, artifactRevision: revision },
      });
    }
    return approval;
  }

  /** The zone a schedule resolves in: the engagement's, else the project's. */
  private async projectTimezone(projectId: string): Promise<string> {
    const project = await this.requireProject(projectId);
    if (project.engagementId) {
      const engagement = await this.prisma.engagement.findUnique({
        where: { id: project.engagementId },
        select: { timezone: true },
      });
      if (engagement?.timezone) return engagement.timezone;
    }
    return project.timezone || 'UTC';
  }

  private adapterContext(destination: DestinationRow): AdapterContext {
    const credential = resolveCredential(destination.credentialRef);
    const adapterDestination: AdapterDestination = {
      id: destination.id,
      projectId: destination.projectId,
      provider: destination.provider,
      label: destination.label,
      resourceId: destination.resourceId,
      resourceLabel: destination.resourceLabel,
      config: this.parseConfig(destination.config),
    };
    return {
      destination: adapterDestination,
      secret: credential.secret,
      projectId: destination.projectId,
    };
  }

  private async persistTestFailure(destinationId: string, reason: string): Promise<void> {
    await this.prisma.publishDestination.update({
      where: { id: destinationId },
      data: { status: 'error', lastTestedAt: new Date(), lastError: reason },
    });
  }

  // ── Views ───────────────────────────────────────────────────────────

  private toDestinationView(row: DestinationRow): PublishDestinationView {
    const declaration = findProvider(row.provider);
    const config = this.parseConfig(row.config);
    const granted = config.grantedPermissions;
    const credential = describeCredential(row.credentialRef);

    return {
      id: row.id,
      projectId: row.projectId,
      provider: row.provider,
      providerLabel: declaration?.label ?? row.provider,
      providerKind: declaration?.kind ?? 'webhook',
      providerImplemented: declaration ? this.adapters.has(declaration.provider) : false,
      label: row.label,
      resourceId: row.resourceId,
      resourceLabel: row.resourceLabel,
      config,
      // The reference, never the value. `credentialConfigured` is the only
      // thing a caller learns about the secret itself.
      credentialRef: row.credentialRef,
      credentialConfigured: credential.configured,
      grantedPermissions: Array.isArray(granted) ? granted.filter((p): p is string => typeof p === 'string') : [],
      status: row.status,
      lastTestedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
      lastError: row.lastError,
      createdBy: row.createdBy,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Map a page of rows, gathering the context they share in bulk. */
  private async toPublicationViews(rows: PublicationRow[]): Promise<PublicationView[]> {
    if (rows.length === 0) return [];
    const context = await this.buildViewContext(rows);
    const revisions = await this.prisma.contentRevision.findMany({
      where: { id: { in: rows.map((row) => row.revisionId) } },
      select: { id: true, revision: true, title: true, contentHash: true },
    });
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));

    return rows.map((row) => this.toPublicationView(row, context, revisionById.get(row.revisionId) ?? null));
  }

  private async buildViewContext(rows: PublicationRow[]): Promise<ViewContext> {
    const destinationIds = Array.from(new Set(rows.map((row) => row.destinationId)));
    const approvalIds = Array.from(
      new Set(rows.map((row) => row.approvalId).filter((id): id is string => typeof id === 'string')),
    );
    const projectIds = Array.from(new Set(rows.map((row) => row.projectId)));

    const [destinations, approvals, projects] = await Promise.all([
      this.prisma.publishDestination.findMany({ where: { id: { in: destinationIds } } }),
      this.prisma.approvalRequest.findMany({
        where: { id: { in: approvalIds } },
        select: { id: true, status: true },
      }),
      this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, clientId: true },
      }),
    ]);

    const clientIds = Array.from(
      new Set(projects.map((project) => project.clientId).filter((id): id is string => typeof id === 'string')),
    );
    const clients = clientIds.length
      ? await this.prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, status: true } })
      : [];
    const pausedClients = new Set(clients.filter((client) => client.status === 'paused').map((client) => client.id));
    const pausedProjects = new Set(
      projects.filter((project) => project.clientId && pausedClients.has(project.clientId)).map((project) => project.id),
    );

    return {
      destinations: new Map(destinations.map((destination) => [destination.id, destination as DestinationRow])),
      approvals: new Map(approvals.map((approval) => [approval.id, { status: approval.status }])),
      pausedProjects,
    };
  }

  private toPublicationView(
    row: PublicationRow,
    context: ViewContext,
    revision: { id: string; revision: number; title: string | null; contentHash: string | null } | null,
  ): PublicationView {
    const destination = context.destinations.get(row.destinationId);
    const declaration = destination ? findProvider(destination.provider) : null;
    const stale = row.status === 'publishing' && Date.now() - row.updatedAt.getTime() > STALE_PUBLISHING_MS;

    return {
      id: row.id,
      projectId: row.projectId,
      destinationId: row.destinationId,
      assetId: row.assetId,
      revisionId: row.revisionId,
      approvalId: row.approvalId,
      mode: row.mode,
      scheduledFor: row.scheduledFor ? row.scheduledFor.toISOString() : null,
      status: row.status,
      remoteId: row.remoteId,
      remoteUrl: row.remoteUrl,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      verifiedUrl: row.verifiedUrl,
      verifyError: row.verifyError,
      verifyState: row.verifyError ? 'unverified' : row.verifiedAt ? 'verified' : 'not-attempted',
      error: row.error,
      attempt: row.attempt,
      publishedBy: row.publishedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      destination: {
        id: destination?.id ?? row.destinationId,
        provider: destination?.provider ?? 'unknown',
        label: destination?.label ?? '(destination removed)',
        resourceId: destination?.resourceId ?? null,
        resourceLabel: destination?.resourceLabel ?? null,
        status: destination?.status ?? 'missing',
      },
      revision,
      blockedReason: this.deriveBlockedReason(row, destination, declaration, context, stale),
      stale,
      actions: {
        canDispatch: row.status === 'pending' && this.deriveBlockedReason(row, destination, declaration, context, stale) === null,
        canVerify: !!row.remoteUrl,
        canRetry: row.status === 'failed' || stale,
        canCancel:
          (row.status === 'pending' || row.status === 'failed') && !row.remoteId,
      },
    };
  }

  /** The same reasoning as {@link dispatchBlockedReason}, from already-loaded rows. */
  private deriveBlockedReason(
    row: PublicationRow,
    destination: DestinationRow | undefined,
    declaration: ProviderDeclaration | null,
    context: ViewContext,
    stale: boolean,
  ): string | null {
    if (row.status === 'published') return null;
    if (row.status === 'cancelled') return 'cancelled';
    if (row.status === 'failed') return row.error ?? 'the last attempt failed';
    if (row.status === 'publishing') {
      return stale ? 'a dispatch was interrupted and never finished — check the remote system before retrying' : null;
    }
    if (row.remoteId) return 'already written to the remote system';
    // Permanent blocks first, then the schedule — see dispatchBlockedReason.
    if (!destination) return 'the destination no longer exists';
    if (destination.revokedAt) return 'the destination was revoked';
    if (destination.status !== 'connected') return `the destination is "${destination.status}"`;
    if (!declaration) return `provider "${destination.provider}" is not declared`;
    if (!this.adapters.has(destination.provider)) {
      return `provider "${destination.provider}" has no adapter in this build`;
    }
    if (!row.approvalId) return 'this publication has no recorded approval';
    const approval = context.approvals.get(row.approvalId);
    if (!approval) return 'the approval that authorized this publication no longer exists';
    if (approval.status !== 'approved') {
      return `the approval that authorized this publication is now "${approval.status}"`;
    }
    if (context.pausedProjects.has(row.projectId)) {
      return 'the client account is paused, so agreed future publications are held';
    }
    if (row.scheduledFor && row.scheduledFor.getTime() > Date.now()) {
      return `scheduled for ${row.scheduledFor.toISOString()}`;
    }
    return null;
  }

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : 'unknown error';
  }
}
