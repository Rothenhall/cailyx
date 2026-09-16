/**
 * Google connection store — the encrypted-token layer.
 *
 * Owns the `GoogleConnection` (one per operator per service) and
 * `GoogleProjectResource` (which GSC site / GA4 property a project maps to)
 * tables. Decrypted tokens never leave this service: callers ask for
 * `accessTokenFor(userId, service)` and get a string that is refreshed
 * transparently when it is within a minute of expiry.
 *
 * @module google/google-connection.service
 */

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GoogleOAuthService } from './google-oauth.service';
import { decryptToken, encryptToken } from './crypto.util';
import type { GoogleConnectionView, GoogleService, GoogleTokenSet } from './google.types';

const REFRESH_SKEW_MS = 60_000;

@Injectable()
export class GoogleConnectionService {
  private readonly logger = new Logger(GoogleConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: GoogleOAuthService,
  ) {}

  /** Persist a fresh authorisation (called from the OAuth callback). */
  async saveAuthorization(userId: string, service: GoogleService, tokens: GoogleTokenSet): Promise<void> {
    if (!tokens.refreshToken) {
      // Google only returns a refresh token on first consent / prompt=consent.
      // Without one we cannot keep the connection alive, so refuse it rather
      // than store a connection that dies in an hour.
      throw new ConflictException(
        'Google did not return a refresh token. Remove Cailyx from your Google account permissions and connect again.',
      );
    }
    const expiresAt = new Date(Date.now() + tokens.expiresInSec * 1000);
    const data = {
      googleEmail: tokens.email ?? null,
      scope: tokens.scope,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken: encryptToken(tokens.refreshToken),
      expiresAt,
      lastError: null,
    };
    await this.prisma.googleConnection.upsert({
      where: { userId_service: { userId, service } },
      create: { userId, service, ...data },
      update: { ...data, connectedAt: new Date() },
    });
    this.logger.log(`Google ${service} connected for user ${userId} (${tokens.email ?? 'unknown email'})`);
  }

  /** Sanitised list for the settings panel — no token material. */
  async list(userId: string): Promise<GoogleConnectionView[]> {
    const rows = await this.prisma.googleConnection.findMany({ where: { userId } });
    const byService = new Map(rows.map((r) => [r.service, r]));
    return (['search-console', 'analytics'] as GoogleService[]).map((service) => {
      const r = byService.get(service);
      if (!r) {
        return {
          service,
          connected: false,
          googleEmail: null,
          scope: '',
          connectedAt: null,
          expiresAt: null,
          expired: false,
          lastError: null,
        };
      }
      return {
        service,
        connected: true,
        googleEmail: r.googleEmail,
        scope: r.scope,
        connectedAt: r.connectedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        expired: r.expiresAt.getTime() < Date.now(),
        lastError: r.lastError,
      };
    });
  }

  /** Revoke at Google and delete locally. Idempotent. */
  async disconnect(userId: string, service: GoogleService): Promise<void> {
    const row = await this.prisma.googleConnection.findUnique({
      where: { userId_service: { userId, service } },
    });
    if (!row) return;
    try {
      await this.oauth.revoke(decryptToken(row.refreshToken));
    } catch {
      /* revoke is best-effort; the local delete is what matters */
    }
    await this.prisma.googleConnection.delete({ where: { id: row.id } });
    this.logger.log(`Google ${service} disconnected for user ${userId}`);
  }

  /**
   * A valid access token for this user + service, refreshing in place when it
   * is about to expire. Throws `ConflictException('google-not-connected')`
   * when there is nothing to use.
   */
  async accessTokenFor(userId: string, service: GoogleService): Promise<string> {
    const row = await this.prisma.googleConnection.findUnique({
      where: { userId_service: { userId, service } },
    });
    if (!row) {
      throw new ConflictException(`Google ${service} is not connected for this operator.`);
    }

    if (row.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
      return decryptToken(row.accessToken);
    }

    try {
      const next = await this.oauth.refresh(decryptToken(row.refreshToken));
      const update: Record<string, unknown> = {
        accessToken: encryptToken(next.accessToken),
        expiresAt: new Date(Date.now() + next.expiresInSec * 1000),
        lastError: null,
      };
      if (next.scope) update.scope = next.scope;
      if (next.refreshToken) update.refreshToken = encryptToken(next.refreshToken);
      await this.prisma.googleConnection.update({ where: { id: row.id }, data: update });
      return next.accessToken;
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.googleConnection.update({
        where: { id: row.id },
        data: { lastError: message.slice(0, 400) },
      });
      throw new ConflictException(`Google ${service} authorisation has expired — reconnect it. (${message})`);
    }
  }

  /* ── project → resource mapping ──────────────────────────────────────── */

  /**
   * Whether the STORED grant for this user + service carries a given scope.
   *
   * This answers "what did the operator actually consent to", not "what did we
   * ask for": `GoogleConnection.scope` is the space-separated list Google
   * returned on the token response. The two can differ — a grant created
   * before a scope was added to {@link GOOGLE_SCOPES} carries only the old
   * set — and a write that needs the missing scope has to say so rather than
   * let Google answer 403 (G19/D17).
   *
   * Returns false for a service that is not connected at all; callers that
   * need to distinguish that case should call `accessTokenFor` first.
   */
  async hasGrantedScope(userId: string, service: GoogleService, scope: string): Promise<boolean> {
    const row = await this.prisma.googleConnection.findUnique({
      where: { userId_service: { userId, service } },
      select: { scope: true },
    });
    if (!row) return false;
    return row.scope.split(/\s+/).filter(Boolean).includes(scope);
  }

  async getProjectResource(
    projectId: string,
    service: GoogleService,
  ): Promise<{ resourceId: string; resourceLabel: string | null } | null> {
    const r = await this.prisma.googleProjectResource.findUnique({
      where: { projectId_service: { projectId, service } },
    });
    return r ? { resourceId: r.resourceId, resourceLabel: r.resourceLabel } : null;
  }

  async setProjectResource(
    userId: string,
    projectId: string,
    service: GoogleService,
    resourceId: string,
    resourceLabel: string | null,
  ): Promise<void> {
    const conn = await this.prisma.googleConnection.findUnique({
      where: { userId_service: { userId, service } },
    });
    if (!conn) throw new ConflictException(`Connect Google ${service} before choosing a resource.`);
    await this.prisma.googleProjectResource.upsert({
      where: { projectId_service: { projectId, service } },
      create: { projectId, service, connectionId: conn.id, resourceId, resourceLabel },
      update: { connectionId: conn.id, resourceId, resourceLabel },
    });
  }

  /** The resource id a data call should read for this project, or a clear 404. */
  async requireProjectResource(projectId: string, service: GoogleService): Promise<string> {
    const r = await this.getProjectResource(projectId, service);
    if (!r) {
      throw new NotFoundException(
        `No Google ${service} ${service === 'analytics' ? 'property' : 'site'} is mapped to this project yet.`,
      );
    }
    return r.resourceId;
  }
}
