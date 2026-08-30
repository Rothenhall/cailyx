/**
 * Auth Service — operator registration, login, refresh rotation, logout.
 *
 * Security design:
 * - Passwords hashed with bcryptjs (cost 10) — pure JS, no native build.
 * - Access tokens: JWT HS256, short TTL (default 15m), carry sub/email/role.
 * - Refresh tokens: opaque 48-byte random strings; only their SHA-256 hash is
 *   stored; rotation on every refresh; revoked on logout; expired rows are
 *   pruned on each refresh cycle.
 * - Bootstrap: the first registered account becomes admin; afterwards
 *   registration requires a valid admin bearer token.
 *
 * @module auth.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'crypto';
import * as bcryptjs from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import type { AccessTokenClaims, AuthTokens, LoginResult, Role, SafeUserDto } from './auth.types';

/** Bcrypt cost factor — 10 is the 2026 baseline for interactive logins. */
const BCRYPT_ROUNDS = 10;
/** Refresh tokens are pruned when older than 7 days past expiry. */
const TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Convert a Prisma User row into its public DTO (drops secrets). */
function toSafeUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
}): SafeUserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    createdAt: user.createdAt.toISOString(),
  };
}

/** SHA-256 of a refresh token — what we persist, never the raw value. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
   * Register an operator. The FIRST account in the system always becomes
   * admin (bootstrap); later registrations must be pre-approved by an admin
   * (enforced upstream via {@link requireAdminBearer}).
   * @returns Tokens + safe user.
   * @throws ConflictException when the email is taken.
   */
  async register(input: { email: string; password: string; name: string; role?: string }): Promise<LoginResult> {
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

    const tokens = await this.issueTokens({ sub: user.id, email: user.email, role: user.role as Role });
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * Verify credentials and issue a fresh token pair.
   * @throws UnauthorizedException on bad email or password (identical error — no user enumeration).
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const ok = await bcryptjs.compare(password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const tokens = await this.issueTokens({ sub: user.id, email: user.email, role: user.role as Role });
    return { ...tokens, user: toSafeUser(user) };
  }

  /**
   * Rotate a refresh token: verify it exists, is unrevoked and unexpired,
   * revoke it, then issue a new pair. Reuse of a revoked token revokes the
   * user's whole refresh chain.
   * @throws UnauthorizedException on unknown, expired, revoked, or reused tokens.
   */
  async refresh(rawRefreshToken: string): Promise<AuthTokens> {
    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (stored.revokedAt) {
      // Token reuse after rotation/revocation — kill the whole family.
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Refresh token reuse detected (userId=${stored.userId}) — all sessions revoked`);
      throw new UnauthorizedException('Refresh token reuse detected — all sessions revoked');
    }
    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens({ sub: user.id, email: user.email, role: user.role as Role });
  }

  /**
   * Logout: revoke the presented refresh token (idempotent — an already
   * revoked or unknown token still returns success so clients can always log out).
   */
  async logout(rawRefreshToken: string): Promise<{ revoked: boolean }> {
    const tokenHash = hashToken(rawRefreshToken);
    const result = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count > 0 };
  }

  /**
   * Current user profile by id (used by `GET /auth/me`).
   * @throws NotFoundException when the user row is gone (deleted while token valid).
   */
  async getMe(userId: string): Promise<SafeUserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return toSafeUser(user);
  }

  /**
   * Issue an access JWT plus a rotated opaque refresh token.
   */
  private async issueTokens(claims: AccessTokenClaims): Promise<AuthTokens> {
    const accessTtl = this.config.get<string>('JWT_ACCESS_TTL', '15m') as JwtSignOptions['expiresIn'];
    const refreshDays = Number(this.config.get<string>('JWT_REFRESH_TTL_DAYS', '30'));

    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.config.get<string>('JWT_SECRET'),
      expiresIn: accessTtl,
    });

    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId: claims.sub,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + refreshDays * 24 * 60 * 60 * 1000),
      },
    });
    await this.pruneExpired(claims.sub);

    return { accessToken, refreshToken };
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