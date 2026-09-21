/**
 * ClientAccessService — G02 seats and invitations.
 *
 * Owns `ClientMember` (seats) and invite-purpose `AuthToken` rows. Scope is
 * always resolved server-side: a client caller's clientId comes from their
 * JWT (`AuthedRequestUser.clientId`), never from a request body/param, and
 * public invite acceptance resolves its grant from the STORED token's
 * `scope` JSON, never from anything the caller sends.
 *
 * @module client-access.service
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, createHash } from 'crypto';
import * as bcryptjs from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import type { AccessTokenClaims } from '../auth/auth.types';
import type {
  ClientMemberDto,
  ClientMemberRole,
  InviteAcceptedDto,
  InviteCreatedDto,
  InviteDto,
  ResolvedMembership,
} from './client-access.types';
import type { AcceptInviteDto, CreateInviteDto, CreateMemberDto, UpdateMemberDto } from './dto/client-access.dto';

const BCRYPT_ROUNDS = 10;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TTL_DAYS = 30;

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

interface InviteScope {
  clientId: string;
  role: ClientMemberRole;
  projectIds: string[];
}

@Injectable()
export class ClientAccessService {
  private readonly logger = new Logger(ClientAccessService.name);

  constructor(
    protected readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  // ─── Membership scope resolution (used by this module's Google delegation
  // controllers too) ────────────────────────────────────────────────────

  /**
   * Resolve what a client-type caller may act as for their own client.
   * Falls back to a synthetic full-scope client-admin for logins created
   * before G02 (no ClientMember row yet) so nobody is locked out mid-rollout.
   */
  async resolveMembership(clientId: string, userId: string): Promise<ResolvedMembership> {
    const row = await this.prisma.clientMember.findUnique({ where: { clientId_userId: { clientId, userId } } });
    if (!row || row.removedAt) {
      return { clientId, userId, role: 'client-admin', projectIds: [], status: 'active', legacy: true };
    }
    return {
      clientId,
      userId,
      role: row.role as ClientMemberRole,
      projectIds: JSON.parse(row.projectIds) as string[],
      status: row.status as 'active' | 'suspended',
      legacy: false,
    };
  }

  /** Throws if the project does not belong to this client, or falls outside a scoped member's projectIds. */
  async requireProjectInScope(membership: ResolvedMembership, projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true, clientId: true } });
    if (!project || project.clientId !== membership.clientId) {
      throw new NotFoundException(`Project ${projectId} not found for this client`);
    }
    if (membership.projectIds.length > 0 && !membership.projectIds.includes(projectId)) {
      throw new ForbiddenException('This seat is not scoped to this project');
    }
  }

  // ─── Members (operator + portal) ───────────────────────────────────────

  async listMembers(clientId: string): Promise<{ members: ClientMemberDto[] }> {
    await this.requireClient(clientId);
    const rows = await this.prisma.clientMember.findMany({ where: { clientId, removedAt: null }, orderBy: { createdAt: 'asc' } });
    const members = await Promise.all(rows.map((r) => this.toMemberDto(r)));
    return { members };
  }

  async createMember(clientId: string, dto: CreateMemberDto, invitedBy: string): Promise<ClientMemberDto> {
    await this.requireClient(clientId);
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user || user.type !== 'client' || user.clientId !== clientId) {
      throw new BadRequestException('userId must be an existing client login belonging to this client');
    }
    const existing = await this.prisma.clientMember.findUnique({ where: { clientId_userId: { clientId, userId: dto.userId } } });
    const row = existing
      ? await this.prisma.clientMember.update({
          where: { id: existing.id },
          data: {
            role: dto.role ?? existing.role,
            projectIds: JSON.stringify(dto.projectIds ?? JSON.parse(existing.projectIds)),
            status: 'active',
            removedAt: null,
          },
        })
      : await this.prisma.clientMember.create({
          data: {
            clientId,
            userId: dto.userId,
            role: dto.role ?? 'client-collaborator',
            projectIds: JSON.stringify(dto.projectIds ?? []),
            invitedBy,
          },
        });
    this.logger.log(`Client member ${existing ? 'updated' : 'created'}: ${row.id} (client ${clientId}, user ${dto.userId})`);
    return this.toMemberDto(row);
  }

  async updateMember(clientId: string, memberId: string, dto: UpdateMemberDto): Promise<ClientMemberDto> {
    const row = await this.requireMember(clientId, memberId);
    const updated = await this.prisma.clientMember.update({
      where: { id: row.id },
      data: {
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.projectIds !== undefined ? { projectIds: JSON.stringify(dto.projectIds) } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      },
    });
    return this.toMemberDto(updated);
  }

  /** Revoke a seat. Soft-delete (removedAt + status=suspended) — never a hard delete, so the audit trail (invitedBy, history) survives. */
  async revokeMember(clientId: string, memberId: string): Promise<{ ok: true }> {
    const row = await this.requireMember(clientId, memberId);
    await this.prisma.clientMember.update({ where: { id: row.id }, data: { status: 'suspended', removedAt: new Date() } });
    this.logger.log(`Client member revoked: ${row.id} (client ${clientId})`);
    return { ok: true };
  }

  // ─── Invitations ────────────────────────────────────────────────────────

  async listInvites(clientId: string): Promise<{ invites: InviteDto[] }> {
    await this.requireClient(clientId);
    const rows = await this.prisma.authToken.findMany({
      where: { purpose: 'invite' },
      orderBy: { createdAt: 'desc' },
    });
    const scoped = rows.filter((r) => this.safeParseScope(r.scope)?.clientId === clientId);
    return { invites: scoped.map((r) => this.toInviteDto(r)) };
  }

  async createInvite(clientId: string, dto: CreateInviteDto, createdBy: string): Promise<InviteCreatedDto> {
    await this.requireClient(clientId);

    const existingUser = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existingUser && existingUser.type === 'client' && existingUser.clientId === clientId) {
      throw new ConflictException(`${dto.email} already has a login for this client — add them as a member instead of inviting.`);
    }
    if (existingUser && (existingUser.type !== 'client' || existingUser.clientId !== clientId)) {
      throw new ConflictException(`${dto.email} is already registered against a different account.`);
    }

    const scope: InviteScope = { clientId, role: dto.role ?? 'client-collaborator', projectIds: dto.projectIds ?? [] };
    const rawToken = randomBytes(32).toString('base64url');
    const row = await this.prisma.authToken.create({
      data: {
        tokenHash: hashToken(rawToken),
        purpose: 'invite',
        email: dto.email,
        scope: JSON.stringify(scope),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        createdBy,
      },
    });
    this.logger.log(`Invite created: ${row.id} for ${dto.email} (client ${clientId})`);

    const acceptUrl = this.buildAcceptUrl(rawToken);
    const { sent, error } = await this.sendInviteEmail(dto.email, acceptUrl);
    return { ...this.toInviteDto(row), token: rawToken, acceptUrl, emailSent: sent, emailError: error };
  }

  /**
   * C2 (`docs/analysis/client-portal.md` §2/§18) — system-triggered invite,
   * called by the Day-1 pipeline completion hook (never by an HTTP request).
   * Reuses the exact same canonical invite-link mechanics as
   * {@link createInvite} (7-day single-use `AuthToken`, client sets their own
   * password, no plaintext credential) rather than the deprecated
   * `POST /clients/:clientId/login` temp-password path.
   *
   * Best-effort by design: if the recipient already has a client login for
   * this client, no new invite is created (nothing to accept) and the caller
   * gets `{ alreadyHasLogin: true }` so it can still send a plain "log in"
   * link. `createdBy` carries a system label (e.g.
   * `system:day1-pipeline:<projectId>`), not a user id — `AuthToken.createdBy`
   * is a free-text column, not a foreign key.
   */
  async createSystemInvite(
    clientId: string,
    email: string,
    projectIds: string[],
    createdBySystemLabel: string,
  ): Promise<InviteCreatedDto | { alreadyHasLogin: true }> {
    await this.requireClient(clientId);

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser && existingUser.type === 'client' && existingUser.clientId === clientId) {
      return { alreadyHasLogin: true };
    }
    if (existingUser && (existingUser.type !== 'client' || existingUser.clientId !== clientId)) {
      this.logger.warn(`System invite for ${email} (client ${clientId}) skipped — email already registered against a different account`);
      return { alreadyHasLogin: true };
    }

    const scope: InviteScope = { clientId, role: 'client-admin', projectIds };
    const rawToken = randomBytes(32).toString('base64url');
    const row = await this.prisma.authToken.create({
      data: {
        tokenHash: hashToken(rawToken),
        purpose: 'invite',
        email,
        scope: JSON.stringify(scope),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        createdBy: createdBySystemLabel,
      },
    });
    this.logger.log(`System invite created: ${row.id} for ${email} (client ${clientId}, by ${createdBySystemLabel})`);

    const acceptUrl = this.buildAcceptUrl(rawToken);
    return { ...this.toInviteDto(row), token: rawToken, acceptUrl, emailSent: false, emailError: null };
  }

  async revokeInvite(clientId: string, inviteId: string): Promise<{ ok: true }> {
    const row = await this.prisma.authToken.findUnique({ where: { id: inviteId } });
    if (!row || row.purpose !== 'invite' || this.safeParseScope(row.scope)?.clientId !== clientId) {
      throw new NotFoundException(`Invite ${inviteId} not found for this client`);
    }
    if (row.usedAt) throw new ConflictException('This invite was already accepted');
    await this.prisma.authToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  /**
   * Public acceptance. Scope (clientId/role/projectIds) is resolved
   * EXCLUSIVELY from the stored token row — the request body carries only
   * the new password/name, never anything that could widen the grant.
   */
  async acceptInvite(rawToken: string, dto: AcceptInviteDto): Promise<InviteAcceptedDto> {
    const tokenHash = hashToken(rawToken);
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash } });
    if (!row || row.purpose !== 'invite') throw new NotFoundException('Invite not found');
    if (row.revokedAt) throw new ConflictException('This invite has been revoked');
    if (row.usedAt) throw new ConflictException('This invite has already been accepted');
    if (row.expiresAt.getTime() < Date.now()) throw new ConflictException('This invite has expired');
    const scope = this.safeParseScope(row.scope);
    if (!scope || !row.email) throw new ConflictException('This invite is malformed — ask for a new one');

    await this.requireClient(scope.clientId);

    let user = await this.prisma.user.findUnique({ where: { email: row.email } });
    const passwordHash = await bcryptjs.hash(dto.password, BCRYPT_ROUNDS);
    if (user) {
      if (user.type !== 'client' || user.clientId !== scope.clientId) {
        throw new ConflictException('This email is already registered against a different account');
      }
      user = await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
    } else {
      user = await this.prisma.user.create({
        data: {
          email: row.email,
          passwordHash,
          name: dto.name ?? row.email,
          type: 'client',
          clientId: scope.clientId,
        },
      });
    }

    const existingMember = await this.prisma.clientMember.findUnique({
      where: { clientId_userId: { clientId: scope.clientId, userId: user.id } },
    });
    const member = existingMember
      ? await this.prisma.clientMember.update({
          where: { id: existingMember.id },
          data: { role: scope.role, projectIds: JSON.stringify(scope.projectIds), status: 'active', removedAt: null },
        })
      : await this.prisma.clientMember.create({
          data: {
            clientId: scope.clientId,
            userId: user.id,
            role: scope.role,
            projectIds: JSON.stringify(scope.projectIds),
            invitedBy: row.createdBy,
          },
        });

    await this.prisma.authToken.update({ where: { id: row.id }, data: { usedAt: new Date(), userId: user.id } });
    this.logger.log(`Invite accepted: ${row.id} -> user ${user.id} (client ${scope.clientId})`);

    const tokens = await this.issueSessionTokens(user.id, user.email, scope.clientId);
    return { ...tokens, member: await this.toMemberDto(member) };
  }

  // ─── Session issuance for a freshly-accepted invite ───────────────────

  private async issueSessionTokens(userId: string, email: string, clientId: string): Promise<{ accessToken: string; refreshToken: string }> {
    const claims: AccessTokenClaims = { sub: userId, email, role: 'technical', type: 'client', clientId };
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m');
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: accessTtl as never,
    });
    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return { accessToken, refreshToken };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  protected async requireClient(clientId: string) {
    const client = await this.prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException(`Client ${clientId} not found`);
    return client;
  }

  private async requireMember(clientId: string, memberId: string) {
    const row = await this.prisma.clientMember.findUnique({ where: { id: memberId } });
    if (!row || row.clientId !== clientId) throw new NotFoundException(`Member ${memberId} not found for this client`);
    return row;
  }

  private safeParseScope(raw: string): InviteScope | null {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.clientId !== 'string') return null;
      return { clientId: parsed.clientId, role: parsed.role ?? 'client-collaborator', projectIds: Array.isArray(parsed.projectIds) ? parsed.projectIds : [] };
    } catch {
      return null;
    }
  }

  private buildAcceptUrl(rawToken: string): string {
    const origin = this.config.get<string>('CLIENT_PORTAL_ORIGIN') ?? this.config.get<string>('CORS_ORIGIN') ?? 'http://localhost:3000';
    return `${origin.split(',')[0].trim()}/invite/${rawToken}`;
  }

  private async sendInviteEmail(to: string, acceptUrl: string): Promise<{ sent: boolean; error: string | null }> {
    const apiKey = this.config.get<string>('PLUNK_SECRET_KEY');
    if (!apiKey) return { sent: false, error: 'PLUNK_SECRET_KEY not configured' };
    try {
      const res = await fetch('https://api.useplunk.com/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          to,
          subject: "You're invited to the Rothenhall client portal",
          body: `<p>You have been invited to the client portal.</p><p><a href="${acceptUrl}">Accept your invitation</a></p><p>This link expires in 7 days.</p>`,
        }),
      });
      if (!res.ok) return { sent: false, error: `Plunk returned ${res.status}` };
      return { sent: true, error: null };
    } catch (err) {
      return { sent: false, error: (err as Error).message };
    }
  }

  private toInviteDto(row: {
    id: string;
    email: string | null;
    scope: string;
    usedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
    createdBy: string | null;
    createdAt: Date;
  }): InviteDto {
    const scope = this.safeParseScope(row.scope);
    let status: InviteDto['status'] = 'pending';
    if (row.usedAt) status = 'accepted';
    else if (row.revokedAt) status = 'revoked';
    else if (row.expiresAt.getTime() < Date.now()) status = 'expired';
    return {
      id: row.id,
      clientId: scope?.clientId ?? '',
      email: row.email ?? '',
      role: scope?.role ?? 'client-collaborator',
      projectIds: scope?.projectIds ?? [],
      status,
      expiresAt: row.expiresAt.toISOString(),
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async toMemberDto(row: {
    id: string;
    clientId: string;
    userId: string;
    role: string;
    projectIds: string;
    status: string;
    invitedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    removedAt: Date | null;
  }): Promise<ClientMemberDto> {
    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { email: true, name: true } });
    return {
      id: row.id,
      clientId: row.clientId,
      userId: row.userId,
      email: user?.email ?? '',
      name: user?.name ?? '',
      role: row.role as ClientMemberRole,
      projectIds: JSON.parse(row.projectIds) as string[],
      status: row.status as ClientMemberDto['status'],
      invitedBy: row.invitedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      removedAt: row.removedAt?.toISOString() ?? null,
    };
  }
}
