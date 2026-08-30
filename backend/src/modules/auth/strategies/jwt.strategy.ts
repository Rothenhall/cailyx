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
import type { Role } from '../auth.types';

export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface AuthedRequestUser {
  userId: string;
  email: string;
  role: Role;
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
   * Passport calls this after signature verification. Also verifies the user
   * still exists so a deleted operator's outstanding access token dies early.
   */
  async validate(payload: JwtPayload): Promise<AuthedRequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true },
    });
    if (!user) throw new UnauthorizedException('User no longer exists');
    return { userId: payload.sub, email: payload.email, role: payload.role };
  }
}