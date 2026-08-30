/**
 * JwtAuthGuard — global bearer guard. Every route requires a valid access
 * token unless marked @Public().
 *
 * Registered globally via APP_GUARD in AppModule.
 *
 * @module jwt-auth.guard
 */

import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  /**
   * Skip auth for @Public() routes.
   */
  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Swagger routes stay open (in-code docs, no data exposure).
    const req = context.switchToHttp().getRequest<Request>();
    if (req.originalUrl.startsWith('/api/docs')) return true;

    return super.canActivate(context);
  }
}