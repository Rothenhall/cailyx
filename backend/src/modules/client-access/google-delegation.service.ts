/**
 * GoogleDelegationService — G02 client-scoped / delegated Google access.
 *
 * A `GoogleConnection` is owned by exactly one `User.id` (operator or
 * client — `google` module code never checks `type`). This service adds a
 * layer on top without touching that module's files:
 *
 * - lets a CLIENT authorize/map/disconnect their OWN Google account, reusing
 *   `GoogleOAuthService`/`GoogleConnectionService`/`SearchConsoleService`/
 *   `AnalyticsService` exactly as the operator surface does (those services
 *   are userId-agnostic about operator vs. client);
 * - lets a second user (operator or client collaborator) read data through
 *   someone else's connection via `ConnectionDelegation`, WITHOUT ever
 *   handing them tokens — every delegated read is proxied here using the
 *   OWNER's userId against the already-exported google services.
 *
 * Every entry point takes the resourceId/service from the caller but never
 * an arbitrary owner `userId` — the owner is always derived from the stored
 * `GoogleConnection`/`GoogleProjectResource` row, never from the request.
 *
 * @module client-access/google-delegation.service
 */

import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GoogleOAuthService } from '../google/google-oauth.service';
import { GoogleConnectionService } from '../google/google-connection.service';
import { SearchConsoleService } from '../google/search-console.service';
import { AnalyticsService } from '../google/analytics.service';
import type { GoogleService } from '../google/google.types';
import type { AnalyticsSummary, SearchConsoleSummary } from '../google/google.types';
import type { ConnectionImpactDto, DelegationAccessLevel, DelegationDto, ScopedGoogleConnectionDto } from './client-access.types';

const SERVICES: GoogleService[] = ['search-console', 'analytics'];

@Injectable()
export class GoogleDelegationService {
  private readonly logger = new Logger(GoogleDelegationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: GoogleOAuthService,
    private readonly connections: GoogleConnectionService,
    private readonly gsc: SearchConsoleService,
    private readonly ga: AnalyticsService,
  ) {}

  isConfigured(): boolean {
    return this.oauth.isConfigured();
  }

  /** Begin OAuth consent for the CALLER's own Google account. `projectId` is only carried through for context — the resulting connection is scoped to the caller's userId, not any project. */
  authorize(userId: string, projectId: string, service: GoogleService): { url: string } {
    const state = this.oauth.signState(userId, projectId, service);
    return { url: this.oauth.authUrl(state, service) };
  }

  /** Per-service view for one project: the caller's own authorization state, plus whether THIS project's mapped resource (if any) is reachable to them (as owner or delegate). */
  async listConnections(userId: string, projectId: string): Promise<ScopedGoogleConnectionDto[]> {
    const out: ScopedGoogleConnectionDto[] = [];
    for (const service of SERVICES) {
      const own = await this.prisma.googleConnection.findUnique({ where: { userId_service: { userId, service } } });
      const mapped = await this.prisma.googleProjectResource.findUnique({ where: { projectId_service: { projectId, service } } });

      // Whichever connection actually serves this project wins: the project's
      // mapped resource if one exists, otherwise the caller's own grant.
      // `null` is the honest value when neither exists — that is exactly the
      // "none" access state below, and the UI renders "not connected" for it.
      let connectionId: string | null = mapped?.connectionId ?? own?.id ?? null;
      let ownerUserId = userId;
      let access: ScopedGoogleConnectionDto['access'] = own ? 'owner' : 'none';
      let accessLevel: DelegationAccessLevel | null = own ? 'read-write' : null;
      let source = own;

      if (mapped) {
        if (mapped.connectionId === own?.id) {
          access = 'owner';
          accessLevel = 'read-write';
          source = own;
        } else {
          const delegation = await this.prisma.connectionDelegation.findFirst({
            where: { connectionId: mapped.connectionId, granteeUserId: userId, projectId, revokedAt: null },
          });
          const owningConnection = await this.prisma.googleConnection.findUnique({ where: { id: mapped.connectionId } });
          if (delegation && owningConnection) {
            access = 'delegated';
            accessLevel = delegation.accessLevel as DelegationAccessLevel;
            ownerUserId = owningConnection.userId;
            source = owningConnection;
          } else {
            access = 'none';
            accessLevel = null;
            ownerUserId = owningConnection?.userId ?? ownerUserId;
            source = null;
          }
        }
      }

      out.push({
        connectionId,
        service,
        ownerUserId,
        access,
        accessLevel,
        googleEmail: source?.googleEmail ?? null,
        connectedAt: source?.connectedAt.toISOString() ?? null,
        expiresAt: source?.expiresAt.toISOString() ?? null,
        expired: source ? source.expiresAt.getTime() < Date.now() : false,
        lastError: source?.lastError ?? null,
        mappedResourceId: mapped?.resourceId ?? null,
        mappedResourceLabel: mapped?.resourceLabel ?? null,
      });
    }
    return out;
  }

  /** Sites/properties for the resource picker — only meaningful when the caller owns a connection for the service; a delegated grantee gets a read-only view of the current mapping instead (they cannot browse or change it). */
  async resources(userId: string, projectId: string, service: GoogleService) {
    const own = await this.prisma.googleConnection.findUnique({ where: { userId_service: { userId, service } } });
    const selected = await this.connections.getProjectResource(projectId, service);

    if (own) {
      let options;
      let connected = true;
      try {
        options = service === 'analytics' ? await this.ga.listProperties(userId) : await this.gsc.listSites(userId);
      } catch {
        connected = false;
        options = [];
      }
      return { service, projectId, connected, options, selected, readOnly: false };
    }

    return { service, projectId, connected: selected !== null, options: [], selected, readOnly: true };
  }

  /** Only the connection OWNER may map a project to a resource. */
  async setResource(userId: string, projectId: string, service: GoogleService, resourceId: string, resourceLabel: string | null): Promise<void> {
    const own = await this.prisma.googleConnection.findUnique({ where: { userId_service: { userId, service } } });
    if (!own) throw new ConflictException(`Connect Google ${service} with your own account before mapping a resource.`);
    await this.connections.setProjectResource(userId, projectId, service, resourceId, resourceLabel);
  }

  /** Only the connection OWNER may disconnect. Returns the impact so the caller can be told plainly what just broke. */
  async disconnect(userId: string, service: GoogleService): Promise<ConnectionImpactDto | null> {
    const own = await this.prisma.googleConnection.findUnique({ where: { userId_service: { userId, service } } });
    if (!own) return null;
    const impact = await this.impact(own.id);
    await this.connections.disconnect(userId, service); // cascades GoogleProjectResource rows
    await this.prisma.connectionDelegation.updateMany({ where: { connectionId: own.id, revokedAt: null }, data: { revokedAt: new Date() } });
    this.logger.log(`Google ${service} disconnected for ${userId} — ${impact.affectedProjects.length} project(s), ${impact.affectedDelegates.length} delegate(s) affected`);
    return impact;
  }

  /** What breaks if this connection is disconnected right now. `restrictToClientProjectIds`, when given, filters affected projects to one client's own (the portal surface must never reveal another client's project ids). */
  async impact(connectionId: string, restrictToClientProjectIds?: string[]): Promise<ConnectionImpactDto> {
    const conn = await this.prisma.googleConnection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new NotFoundException(`Connection ${connectionId} not found`);

    const mappings = await this.prisma.googleProjectResource.findMany({ where: { connectionId } });
    const affectedProjects = mappings
      .filter((m) => !restrictToClientProjectIds || restrictToClientProjectIds.includes(m.projectId))
      .map((m) => ({ projectId: m.projectId, resourceId: m.resourceId, resourceLabel: m.resourceLabel }));

    const delegations = await this.prisma.connectionDelegation.findMany({ where: { connectionId, revokedAt: null } });
    const affectedDelegates = delegations
      .filter((d) => !restrictToClientProjectIds || restrictToClientProjectIds.includes(d.projectId))
      .map((d) => ({ granteeUserId: d.granteeUserId, projectId: d.projectId, accessLevel: d.accessLevel as DelegationAccessLevel }));

    return { connectionId, service: conn.service as GoogleService, ownerUserId: conn.userId, affectedProjects, affectedDelegates };
  }

  /**
   * Grant a delegation. Only the connection owner may grant it (the owner
   * decides who reuses their authorized data — never self-service by the
   * would-be grantee). The grant is scoped to a specific project the
   * connection is already mapped to.
   */
  async grantDelegation(connectionId: string, projectId: string, granteeUserId: string, accessLevel: DelegationAccessLevel, grantedBy: string): Promise<DelegationDto> {
    const conn = await this.prisma.googleConnection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new NotFoundException(`Connection ${connectionId} not found`);
    if (conn.userId !== grantedBy) throw new ForbiddenException('Only the connection owner may grant delegated access to it');

    const mapping = await this.prisma.googleProjectResource.findUnique({
      where: { projectId_service: { projectId, service: conn.service } },
    });
    if (!mapping || mapping.connectionId !== connectionId) {
      throw new BadRequestException('This connection is not mapped to this project — map it first');
    }
    if (granteeUserId === grantedBy) throw new BadRequestException('Cannot delegate a connection to its own owner');

    const grantee = await this.prisma.user.findUnique({ where: { id: granteeUserId } });
    if (!grantee) throw new BadRequestException('granteeUserId does not exist');

    const row = await this.prisma.connectionDelegation.upsert({
      where: { connectionId_granteeUserId_projectId: { connectionId, granteeUserId, projectId } },
      create: { connectionId, projectId, granteeUserId, grantedBy, accessLevel },
      update: { accessLevel, revokedAt: null, grantedBy },
    });
    this.logger.log(`Delegation granted: connection ${connectionId} -> user ${granteeUserId} on project ${projectId} (${accessLevel})`);
    return this.toDelegationDto(row);
  }

  /** The owner, or the grantee themselves, may revoke. */
  async revokeDelegation(connectionId: string, projectId: string, granteeUserId: string, requestedBy: string): Promise<{ ok: true }> {
    const conn = await this.prisma.googleConnection.findUnique({ where: { id: connectionId } });
    if (!conn) throw new NotFoundException(`Connection ${connectionId} not found`);
    if (conn.userId !== requestedBy && granteeUserId !== requestedBy) {
      throw new ForbiddenException('Only the connection owner or the grantee may revoke this delegation');
    }
    await this.prisma.connectionDelegation.updateMany({
      where: { connectionId, projectId, granteeUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  async listDelegationsForConnection(connectionId: string): Promise<DelegationDto[]> {
    const rows = await this.prisma.connectionDelegation.findMany({ where: { connectionId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.toDelegationDto(r));
  }

  /**
   * Proxied read: resolves the resource mapped to `projectId`/`service`,
   * confirms the requester is either the owning user or holds a live
   * delegation on that exact connection+project, then reads using the
   * OWNER's stored token. The requester never sees or receives the token.
   */
  async proxiedSummary(
    requesterUserId: string,
    projectId: string,
    service: GoogleService,
    days: number,
  ): Promise<SearchConsoleSummary | AnalyticsSummary> {
    const mapping = await this.prisma.googleProjectResource.findUnique({ where: { projectId_service: { projectId, service } } });
    if (!mapping) throw new NotFoundException(`No Google ${service} resource is mapped to this project yet`);
    const conn = await this.prisma.googleConnection.findUnique({ where: { id: mapping.connectionId } });
    if (!conn) throw new NotFoundException('The mapped Google connection no longer exists');

    let ownerUserId: string;
    if (conn.userId === requesterUserId) {
      ownerUserId = conn.userId;
    } else {
      const delegation = await this.prisma.connectionDelegation.findFirst({
        where: { connectionId: conn.id, granteeUserId: requesterUserId, projectId, revokedAt: null },
      });
      if (!delegation) throw new ForbiddenException('You do not have access to this project\'s Google connection — ask its owner to delegate access');
      ownerUserId = conn.userId;
    }

    return service === 'analytics' ? this.ga.summary(ownerUserId, mapping.resourceId, days) : this.gsc.summary(ownerUserId, mapping.resourceId, days);
  }

  private toDelegationDto(row: {
    id: string;
    connectionId: string;
    projectId: string;
    granteeUserId: string;
    grantedBy: string;
    accessLevel: string;
    revokedAt: Date | null;
    createdAt: Date;
  }): DelegationDto {
    return {
      id: row.id,
      connectionId: row.connectionId,
      projectId: row.projectId,
      granteeUserId: row.granteeUserId,
      grantedBy: row.grantedBy,
      accessLevel: row.accessLevel as DelegationAccessLevel,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
