/**
 * Auth decorators — route-level access metadata.
 *
 * @Public()       — opt a route out of the global JWT guard (login, register, docs).
 * @Roles(...)     — restrict an OPERATOR route to specific roles; admin always allowed.
 * @ClientPortal() — mark a route as the client-portal surface: a client-type
 *                   user may access it (and ONLY routes marked this way);
 *                   an operator-type user may NOT. Default-deny, not
 *                   default-allow — see RolesGuard.
 *
 * @module auth.decorators
 */

import { SetMetadata } from '@nestjs/common';
import { Role } from '../../modules/auth/auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CLIENT_PORTAL_KEY = 'clientPortal';
export const ClientPortal = () => SetMetadata(CLIENT_PORTAL_KEY, true);