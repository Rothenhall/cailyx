/**
 * RolesGuard — role-based access via @Roles(), plus the operator/client split
 * via @ClientPortal(). Runs after JwtAuthGuard (registered next in APP_GUARD
 * order). Admin passes every operator-role check.
 *
 * The client/operator split is checked FIRST and is default-deny, not
 * default-allow — the opposite of @Roles()'s "no metadata = open" shape.
 * A client-type user must be rejected from every route that is not
 * explicitly marked @ClientPortal(), including ones with no @Roles()
 * metadata at all, or a client login would have full access to every
 * undecorated operator endpoint in the system. Client-portal routes
 * themselves are only for clients — an operator hitting one is rejected
 * too, matching client-portal.md's "no shared component renders both
 * operator and client data" rule at the API layer, not just the UI.
 *
 * @module roles.guard
 */

import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, CLIENT_PORTAL_KEY, IS_PUBLIC_KEY } from '../decorators/auth.decorators';
import type { AuthedRequestUser } from '../../modules/auth/strategies/jwt.strategy';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // @Public() routes never reach Passport (JwtAuthGuard skips it), so
    // req.user is never set on them — must be checked here too, or every
    // public route (login, register, health, docs) 403s below.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const user = context.switchToHttp().getRequest().user as AuthedRequestUser | undefined;
    if (!user) return false;

    const isClientPortalRoute = this.reflector.getAllAndOverride<boolean>(CLIENT_PORTAL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (user.type === 'client') {
      if (isClientPortalRoute) return true;
      throw new ForbiddenException('Client accounts cannot access this resource');
    }
    if (isClientPortalRoute) {
      throw new ForbiddenException('Operator accounts must use the operator API, not the client portal');
    }

    // Existing operator @Roles() behavior, unchanged.
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    if (user.role === 'admin') return true;
    if (required.includes(user.role)) return true;

    throw new ForbiddenException(`Role '${user.role}' cannot access this resource`);
  }
}