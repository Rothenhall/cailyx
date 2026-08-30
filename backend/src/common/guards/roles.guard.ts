/**
 * RolesGuard — role-based access via @Roles(). Runs after JwtAuthGuard
 * (registered next in APP_GUARD order). Admin passes every check.
 *
 * @module roles.guard
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/auth.decorators';
import type { AuthedRequestUser } from '../../modules/auth/strategies/jwt.strategy';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /**
   * Allow when no @Roles() metadata exists, the user role is listed, or the
   * user is admin. 403 (not 401) on role mismatch — the identity is valid.
   */
  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as AuthedRequestUser | undefined;
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (required.includes(user.role)) return true;

    throw new ForbiddenException(`Role '${user.role}' cannot access this resource`);
  }
}