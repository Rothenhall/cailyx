/**
 * CurrentUser decorator — injects the authenticated user from the request.
 *
 * Usage: `handler(@CurrentUser() user: AuthedRequestUser)` where
 * AuthedRequestUser = { userId, email, role }.
 *
 * @module current-user.decorator
 */

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequestUser } from '../../modules/auth/strategies/jwt.strategy';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedRequestUser | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthedRequestUser | undefined;
  },
);