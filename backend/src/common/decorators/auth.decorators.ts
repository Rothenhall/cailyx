/**
 * Auth decorators — route-level access metadata.
 *
 * @Public()    — opt a route out of the global JWT guard (login, register, docs).
 * @Roles(...)  — restrict a route to specific roles; admin always allowed.
 *
 * @module auth.decorators
 */

import { SetMetadata } from '@nestjs/common';
import { Role } from '../../modules/auth/auth.types';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);