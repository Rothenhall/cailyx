/**
 * Auth Service — operator + client registration, login, refresh rotation,
 * logout, sessions, and password lifecycle (G01).
 *
 * Security design:
 * - Passwords hashed with bcryptjs (cost 10) — pure JS, no native build.
 * - Access tokens: JWT HS256, short TTL (default 15m), carry sub/email/role
 *   and, since G01, `sid` (the UserSession this token belongs to).
 * - Refresh tokens: opaque 96-hex random strings; only their SHA-256 hash is
 *   stored; rotation on every refresh; revoked on logout; expired rows are
 *   pruned on each refresh cycle.
 * - Sessions: one UserSession row per login, correlated to whichever
 *   RefreshToken currently belongs to it (`refreshaudit`). Refreshing
 *   rotates the refresh token but reuses the same session row (updates
 *   `lastSeenAt`/`expiresAt`/the correlation) — a "session" in the sessions
 *   UI means the same signed-in device, not the same 15-minute access token.
 * - Reset/invite tokens (AuthToken): only a SHA-256 hash is ever persisted;
 *   the raw token exists only in the outbound email and the one HTTP
 *   response that issues it. Single-use (`usedAt`), expiring, revocable.
 * - Bootstrap: the first registered account becomes admin; afterwards
 *   registration requires a valid admin bearer token.
 * - A disabled user (`User.disabledAt` set) cannot log in, cannot refresh,
 *   and — via {@link JwtStrategy.validate} — loses access on their very next
 *   request even on an already-issued access token.
 *
 * @module auth.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'crypto';
import * as bcryptjs from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import type {
  AccessTokenClaims,
  AuthTokens,
  LoginResult,
  PortalMeDto,
  Role,
  SafeUserDto,
  SessionDto,
  UserType,
} from './auth.types';

/** Bcrypt cost factor — 10 is the 2026 baseline for interactive logins. */
const BCRYPT_ROUNDS = 10;
/** Refresh tokens are pruned when older than 7 days past expiry. */
const TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Password reset links expire in 1 hour — short enough to bound a leaked-email window. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
/** Generic response for `password/forgot` — identical whether or not the email exists. */
const GENERIC_FORGOT_RESPONSE = {
  message: 'If that email is registered, a password reset link has been sent.',
} as const;
/**
 * Window in which a just-rotated-away refresh token is treated as a benign
 * race (e.g. two open tabs refreshing within the same instant) rather than
 * reuse-as-compromise. Kept short — long enough for concurrent requests
 * in flight, far too short to matter for an actually stolen token.
 */
const ROTATION_GRACE_MS = 15_000;

/** Request-derived metadata attached to a session at login/refresh time. */
export interface SessionRequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

/** Convert a Prisma User row into its public DTO (drops secrets). */
function toSafeUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  type: string;
  clientId: string | null;
  mustChangePassword: boolean;
  createdAt: Date;
}): SafeUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    type: user.type as UserType,
    clientId: user.clientId,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt.toISOString(),
  };
}

/** SHA-256 of a token — what we persist, never the raw value. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Coarse "Browser on OS" label for the sessions UI. Best-effort, never throws. */
function deviceLabelFrom(userAgent?: string): string | null {
  if (!userAgent) return null;
  const browser =
    /Edg\//.test(userAgent) ? 'Edge' :
    /Chrome\//.test(userAgent) ? 'Chrome' :
    /Firefox\//.test(userAgent) ? 'Firefox' :
    /Safari\//.test(userAgent) && !/Chrome/.test(userAgent) ? 'Safari' :
    'Browser';
  const os =
    /Windows/.test(userAgent) ? 'Windows' :
    /Mac OS X/.test(userAgent) ? 'macOS' :
    /Android/.test(userAgent) ? 'Android' :
    /iPhone|iPad/.test(userAgent) ? 'iOS' :
    /Linux/.test(userAgent) ? 'Linux' :
    null;
  return os ? `${browser} on ${os}` : browser;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * tokenHash → the pair issued when that (now-revoked) token was rotated,
   * kept for {@link ROTATION_GRACE_MS} so a losing concurrent refresh gets
   * the winner's new pair instead of tripping reuse-detection.
   */
  private readonly recentRotations = new Map<string, { tokens: AuthTokens; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether any operator exists. Registration bootstrap switches from open
   * (first account = admin) to admin-gated when this turns true.
   */
  async hasUsers(): Promise<boolean> {
    return (await this.prisma.user.count()) > 0;
  }

  /**
   * Verify that an Authorization header carries a valid ADMIN access token.
   * Used by `POST /auth/register` once the first account exists.
   * @throws UnauthorizedException when the header is missing, the token is
   *         invalid/expired, or the role is not admin.
   */
  async requireAdminBearer(authorization?: string): Promise<void> {
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Registration requires an admin bearer token');
    }
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenClaims>(authorization.slice('Bearer '.length), {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      if (payload.role !== 'admin') {
        throw new UnauthorizedException('Registration requires an admin');
      }
    } catch {
      throw new UnauthorizedException('Registration requires a valid admin bearer token');
    }
  }

  /**
   * Best-effort check: does this Authorization header carry a currently-valid
   * access token? Never throws — for @Public() routes that render differently
   * for a logged-in operator vs. an anonymous visitor (e.g. a shareable report
   * link) without forcing auth on the route itself.
   */
  async isValidBearer(authorization?: string): Promise<boolean> {
    if (!authorization?.startsWith('Bearer ')) return false;
    try {
      await this.jwt.verifyAsync<AccessTokenClaims>(authorization.slice('Bearer '.length), {
        secret: this.config.get<string>('JWT_SECRET'),
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register an operator. The FIRST account in the system always becomes
   * admin (bootstrap); later registrations must be pre-approved by an admin
   * (enforced upstream via {@link requireAdminBearer}).
   * @returns Tokens + safe user.
   * @throws ConflictException when the email is taken.
   */
  async register(
    input: { email: string; password: string; name: string; role?: string },
    meta?: SessionRequestMeta,
  ): Promise<LoginResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ConflictException('Email already registered: ' + input.email);
    }

    const isFirstUser = !(await this.hasUsers());
    const role: Role = isFirstUser ? 'admin' : ((input.role as Role) ?? 'technical');
    const passwordHash = await bcryptjs.hash(input.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: { email: input.email, passwordHash, name: input.name, role },
    });
    this.logger.log(`Operator registered (email=${user.email}, role=${user.role}, bootstrap=${isFirstUser})`);

    const tokens = await this.issueTokens(
      { sub: user.id, email: user.email, role: user.role as Role, type: 'operator' },
      meta,
    );
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * Verify credentials and issue a fresh token pair + session.
   * @throws UnauthorizedException on bad email/password or a disabled account
   *         (identical error for all three — no user enumeration, and a
   *         disabled account should look exactly like a wrong password).
   */
  async login(email: string, password: string, meta?: SessionRequestMeta): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.disabledAt) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcryptjs.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const tokens = await this.issueTokens(
      {
        sub: user.id,
        email: user.email,
        role: user.role as Role,
        type: user.type as UserType,
        clientId: user.clientId ?? undefined,
      },
      meta,
    );
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * Rotate a refresh token: verify it exists, is unrevoked and unexpired,
   * revoke it, then issue a new pair on the SAME session. Presenting a token
   * within {@link ROTATION_GRACE_MS} of its own rotation (e.g. two open tabs
   * refreshing at once) replays the winner's new pair back to the loser.
   * Outside that window, reuse of a revoked token revokes the user's whole
   * refresh chain and every session tied to it — treated as compromise.
   * @throws UnauthorizedException on unknown, expired, revoked, or reused
   *         tokens, or a since-disabled user.
   */
  async refresh(rawRefreshToken: string, meta?: SessionRequestMeta): Promise<AuthTokens> {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.revokedAt) {
      const recent = this.recentRotations.get(tokenHash);
      if (recent) {
        this.recentRotations.delete(tokenHash);
        if (recent.expiresAt > Date.now()) return recent.tokens;
      }
      // Token reuse after rotation/revocation — kill the whole family.
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.prisma.userSession.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedvia: 'admin-revoke' },
      });
      this.logger.warn(`Refresh token reuse detected (userId=${stored.userId}) — all sessions revoked`);
      throw new UnauthorizedException('Refresh token reuse detected — all sessions revoked');
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.disabledAt) {
      throw new UnauthorizedException('This account has been disabled');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    // Reuse the session this refresh token belonged to, if any survives —
    // a refresh rotates the token, not the user's notion of "this device".
    const existingSession = await this.prisma.userSession.findFirst({
      where: { refreshaudit: stored.id, revokedAt: null },
      select: { id: true },
    });

    const tokens = await this.issueTokens(
      {
        sub: user.id,
        email: user.email,
        role: user.role as Role,
        type: user.type as UserType,
        clientId: user.clientId ?? undefined,
      },
      meta,
      existingSession?.id,
    );

    for (const [hash, entry] of this.recentRotations) {
      if (entry.expiresAt <= Date.now()) this.recentRotations.delete(hash);
    }
    this.recentRotations.set(tokenHash, { tokens, expiresAt: Date.now() + ROTATION_GRACE_MS });

    return tokens;
  }

  /**
   * Logout: revoke the presented refresh token and its correlated session
   * (idempotent — an already revoked or unknown token still returns success
   * so clients can always log out).
   */
  async logout(rawRefreshToken: string): Promise<{ revoked: boolean }> {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt) return { revoked: false };

    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    await this.prisma.userSession.updateMany({
      where: { refreshaudit: stored.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedvia: 'user-logout' },
    });
    return { revoked: true };
  }

  /**
   * Current user profile by id (used by `GET /auth/me` — operator surface).
   * Deliberately does NOT serve `type: "client"` users; see {@link getPortalMe}.
   * @throws NotFoundException when the user row is gone (deleted while token valid).
   * @throws ForbiddenException the caller is a client-type user (use `/portal/me`).
   */
  async getMe(userId: string): Promise<SafeUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.type === 'client') {
      throw new ForbiddenException('Client accounts must use GET /api/portal/me');
    }
    return toSafeUser(user);
  }

  /**
   * G01 — `GET /api/portal/me`. The client-portal equivalent of `getMe`: the
   * existing `/auth/me` was operator-only (implicitly, by never being
   * reachable from a `@ClientPortal()` route and by shape), so a logged-in
   * client had nowhere to fetch its own identity + client record from.
   * @throws NotFoundException the user row is gone.
   * @throws ForbiddenException the caller is an operator-type user.
   */
  async getPortalMe(userId: string): Promise<PortalMeDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, include: { client: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.type !== 'client') {
      throw new ForbiddenException('This endpoint is for client-portal accounts only');
    }
    if (!user.client) {
      // Data-integrity bug (a client-type row with no Client), not a client
      // error — surfaced as 404 rather than a 500-shaped crash downstream.
      throw new NotFoundException('This login is not attached to a client account');
    }
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      type: 'client',
      mustChangePassword: user.mustChangePassword,
      client: { id: user.client.id, name: user.client.name, status: user.client.status },
      createdAt: user.createdAt.toISOString(),
    };
  }

  // ─── G01 — sessions ──────────────────────────────────────────────────

  /** Every live, unexpired session for the caller, most-recently-seen first. */
  async listSessions(userId: string, currentSessionId?: string): Promise<{ sessions: SessionDto[] }> {
    const rows = await this.prisma.userSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
    });
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        userAgent: r.userAgent,
        ipAddress: r.ipAddress,
        deviceLabel: r.deviceLabel,
        lastSeenAt: r.lastSeenAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        isCurrent: r.id === currentSessionId,
      })),
    };
  }

  /**
   * Revoke one session belonging to the caller (and the refresh token
   * currently correlated to it, so the revocation is immediate rather than
   * waiting for that refresh token to be presented and rejected).
   * @throws NotFoundException the session does not exist or belongs to someone else.
   */
  async revokeSession(userId: string, sessionId: string): Promise<{ revoked: boolean }> {
    const session = await this.prisma.userSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== userId) {
      throw new NotFoundException('Session not found');
    }
    if (session.revokedAt) return { revoked: false };

    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedvia: 'user-logout' },
    });
    if (session.refreshaudit) {
      await this.prisma.refreshToken.updateMany({
        where: { id: session.refreshaudit, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { revoked: true };
  }

  /**
   * Revoke every live session for the caller, optionally sparing one (the
   * session the calling access token belongs to, for `password/change`,
   * which signs the current device out of every OTHER session, not this
   * one). Also revokes each session's correlated refresh token.
   */
  async logoutAll(
    userId: string,
    exceptSessionId?: string,
    revokedVia: 'logout-all' | 'password-change' | 'admin-revoke' = 'logout-all',
  ): Promise<{ sessionsRevoked: number }> {
    const sessions = await this.prisma.userSession.findMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      select: { id: true, refreshaudit: true },
    });
    if (sessions.length === 0) return { sessionsRevoked: 0 };

    await this.prisma.userSession.updateMany({
      where: { id: { in: sessions.map((s) => s.id) } },
      data: { revokedAt: new Date(), revokedvia: revokedVia },
    });
    const refreshIds = sessions.map((s) => s.refreshaudit).filter((id): id is string => Boolean(id));
    if (refreshIds.length > 0) {
      await this.prisma.refreshToken.updateMany({
        where: { id: { in: refreshIds }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { sessionsRevoked: sessions.length };
  }

  // ─── G01 — password lifecycle ───────────────────────────────────────

  /**
   * `POST /api/auth/password/change` — authenticated, both user types.
   * Verifies the current password, sets the new one, clears
   * `mustChangePassword`, and revokes every OTHER live session (the current
   * one — identified by the access token's `sid` claim — survives, so the
   * caller isn't logged out of the request they're making).
   * @throws NotFoundException the user row is gone.
   * @throws UnauthorizedException `currentPassword` does not match.
   */
  async changePassword(
    userId: string,
    currentSessionId: string | undefined,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ sessionsRevoked: number }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const ok = await bcryptjs.compare(currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    const passwordHash = await bcryptjs.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });

    const { sessionsRevoked } = await this.logoutAll(userId, currentSessionId, 'password-change');
    this.logger.log(`Password changed (userId=${userId}, otherSessionsRevoked=${sessionsRevoked})`);
    return { sessionsRevoked };
  }

  /**
   * `POST /api/auth/password/forgot` — PUBLIC. Always returns the same
   * generic response, whether or not the email is registered, whether or not
   * the account is disabled, and even if the email send throws — the only
   * signal that leaves this method is "we accepted the request" (design_plan
   * G01: "generic reset response avoids email enumeration").
   */
  async forgotPassword(email: string): Promise<{ message: string }> {
    try {
      const normalized = email.trim().toLowerCase();
      const user = await this.prisma.user.findUnique({ where: { email: normalized } });
      if (!user || user.disabledAt) return GENERIC_FORGOT_RESPONSE;

      const rawToken = randomBytes(32).toString('hex');
      await this.prisma.authToken.create({
        data: {
          tokenHash: hashToken(rawToken),
          purpose: 'password-reset',
          userId: user.id,
          email: user.email,
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });
      await this.sendResetEmail(user.email, rawToken);
      this.logger.log(`Password reset requested (userId=${user.id})`);
    } catch (err) {
      // Never let a send/DB failure change the response shape or timing
      // enough to be a useful enumeration signal.
      this.logger.error('forgotPassword failed: ' + (err as Error).message);
    }
    return GENERIC_FORGOT_RESPONSE;
  }

  /**
   * `POST /api/auth/password/reset` — PUBLIC. Redeems a single-use reset
   * token: verifies purpose/expiry/unused/unrevoked, sets the new password,
   * marks the token used, and revokes every session (a reset implies the
   * account may have been compromised or the owner locked themselves out —
   * there is no "current session" to spare, unlike `changePassword`).
   * @throws UnauthorizedException token missing/expired/used/revoked, or
   *         points at a user that no longer exists or is disabled — all one
   *         error so a bad token can't be distinguished from an expired one.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<{ reset: boolean }> {
    const tokenHash = hashToken(rawToken);
    const record = await this.prisma.authToken.findUnique({ where: { tokenHash } });
    const invalid = () => new UnauthorizedException('Invalid or expired reset token');

    if (!record || record.purpose !== 'password-reset') throw invalid();
    if (record.usedAt || record.revokedAt) throw invalid();
    if (record.expiresAt.getTime() <= Date.now()) throw invalid();
    if (!record.userId) throw invalid();

    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user || user.disabledAt) throw invalid();

    const passwordHash = await bcryptjs.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, mustChangePassword: false },
      }),
      this.prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    await this.logoutAll(user.id, undefined, 'password-change');
    this.logger.log(`Password reset via token (userId=${user.id})`);
    return { reset: true };
  }

  /** Best-effort reset email via Plunk — mirrors clients.service.ts#sendLoginEmail. Never throws. */
  private async sendResetEmail(to: string, rawToken: string): Promise<void> {
    const apiKey = this.config.get<string>('PLUNK_SECRET_KEY');
    if (!apiKey) {
      this.logger.warn(`PLUNK_SECRET_KEY not configured — reset link for ${to} was not emailed`);
      return;
    }
    const appUrl = this.config.get<string>('APP_PUBLIC_URL', '');
    const resetUrl = `${appUrl}/reset/${rawToken}`;
    try {
      const res = await fetch('https://api.useplunk.com/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          to,
          subject: 'Reset your Rothenhall password',
          body: `<p>Reset your password: <a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour and can only be used once.</p>`,
        }),
      });
      if (!res.ok) this.logger.warn(`Plunk returned ${res.status} sending reset email to ${to}`);
    } catch (err) {
      this.logger.warn('Reset email send failed: ' + (err as Error).message);
    }
  }

  /**
   * Issue an access JWT plus a rotated opaque refresh token, and either
   * create a new UserSession (login/register) or reuse an existing one
   * (refresh, when `reuseSessionId` is given and still live).
   */
  private async issueTokens(
    claims: Omit<AccessTokenClaims, 'sid'>,
    meta?: SessionRequestMeta,
    reuseSessionId?: string,
  ): Promise<AuthTokens> {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m') as JwtSignOptions['expiresIn'];
    const refreshDays = Number(this.config.get<string>('JWT_REFRESH_TTL_DAYS', '30'));

    const refreshToken = randomBytes(48).toString('hex');
    const refreshExpiresAt = new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000);
    const refreshRow = await this.prisma.refreshToken.create({
      data: { userId: claims.sub, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiresAt },
    });

    let sessionId: string;
    if (reuseSessionId) {
      const updated = await this.prisma.userSession.update({
        where: { id: reuseSessionId },
        data: {
          lastSeenAt: new Date(),
          expiresAt: refreshExpiresAt,
          refreshaudit: refreshRow.id,
          ...(meta?.userAgent ? { userAgent: meta.userAgent } : {}),
          ...(meta?.ipAddress ? { ipAddress: meta.ipAddress } : {}),
        },
      });
      sessionId = updated.id;
    } else {
      const created = await this.prisma.userSession.create({
        data: {
          userId: claims.sub,
          userAgent: meta?.userAgent ?? null,
          ipAddress: meta?.ipAddress ?? null,
          deviceLabel: deviceLabelFrom(meta?.userAgent),
          expiresAt: refreshExpiresAt,
          refreshaudit: refreshRow.id,
        },
      });
      sessionId = created.id;
    }

    const accessToken = await this.jwt.signAsync(
      { ...claims, sid: sessionId },
      { secret: this.config.get<string>('JWT_SECRET'), expiresIn: accessTtl },
    );

    await this.pruneExpired(claims.sub);

    return { accessToken, refreshToken, sessionId };
  }

  /**
   * Prune this user's already-expired refresh tokens (housekeeping; keeps the
   * table small without a cron dependency). Never fails the token issuance.
   */
  private async pruneExpired(userId: string): Promise<void> {
    try {
      await this.prisma.refreshToken.deleteMany({
        where: { userId, expiresAt: { lt: new Date(Date.now() - TOKEN_GRACE_MS) } },
      });
    } catch (err) {
      this.logger.error('Refresh token pruning failed: ' + (err as Error).message);
    }
  }
}
