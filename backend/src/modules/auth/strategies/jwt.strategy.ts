/**
 * JWT Passport Strategy — validates the bearer access token on every
 * non-`@Public()` request and attaches { userId, email, role } to the request.
 *
 * @module jwt.strategy
 */

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../database/prisma.service';
import type { Role, UserType } from '../auth.types';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  type: UserType;
  clientId?: string;
  /** G01 — UserSession.id this token belongs to. See auth.types.ts AccessTokenClaims. */
  sid?: string;
}

export interface AuthedRequestUser {
  userId: string;
  email: string;
  role: Role;
  type: UserType;
  clientId?: string;
  /** G01 — the UserSession this request's access token belongs to, if the token carries one. */
  sessionId?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  /**
   * Passport calls this after signature verification. Re-derives role/type/
   * clientId/disabled state from the database on EVERY request rather than
   * trusting the token-carried claims — G03's "token role changes must take
   * effect under a defined immediate revocation policy" requirement. Before
   * this, a demoted/re-typed/disabled user's still-valid access token kept
   * its old privileges (or kept working at all) until it naturally expired
   * (JWT_ACCESS_TTL, default 15m); now a role change, a client reassignment,
   * or `disabledAt` being set takes effect on the very next request, without
   * waiting for expiry or forcing a logout.
   * @throws UnauthorizedException the user row is gone, or `disabledAt` is set.
   */
  async validate(payload: JwtPayload): Promise<AuthedRequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, type: true, clientId: true, disabledAt: true },
    });
    if (!user) throw new UnauthorizedException('User no longer exists');
    if (user.disabledAt) throw new UnauthorizedException('This account has been disabled');
    return {
      userId: payload.sub,
      email: payload.email,
      role: user.role as Role,
      type: user.type as UserType,
      clientId: user.clientId ?? undefined,
      sessionId: payload.sid,
    };
  }
}