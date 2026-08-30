/**
 * Users Service — operator account administration (admin only).
 *
 * Separate from `auth` (which owns login/registration/token rotation). This
 * service is the CRUD surface behind the dashboard's User Management UI. It
 * never issues tokens and never returns password or token hashes.
 *
 * Guard rails: the last `admin` cannot be demoted or deleted, and an operator
 * cannot delete their own account here.
 *
 * @module users.service
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import * as bcryptjs from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { ROLES } from '../auth/auth.types';
import type { Role, SafeUserDto } from '../auth/auth.types';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every operator, newest first. */
  async list(): Promise<{ users: SafeUserDto[] }> {
    const rows = await this.prisma.user.findMany({ orderBy: { createdAt: 'desc' } });
    return { users: rows.map(toSafe) };
  }

  async get(id: string): Promise<SafeUserDto> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('User not found: ' + id);
    return toSafe(row);
  }

  /**
   * Create an operator with an explicit role.
   * @throws ConflictException email already registered.
   * @throws BadRequestException invalid role or short password.
   */
  async create(input: { email: string; password: string; name: string; role: string }): Promise<SafeUserDto> {
    const email = input.email.trim().toLowerCase();
    if (!isRole(input.role)) throw new BadRequestException('role must be one of: ' + ROLES.join(', '));
    if (input.password.length < 10) throw new BadRequestException('password must be at least 10 characters');
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('Email already registered: ' + email);
    }
    const passwordHash = await bcryptjs.hash(input.password, BCRYPT_ROUNDS);
    const row = await this.prisma.user.create({
      data: { email, name: input.name.trim(), role: input.role, passwordHash },
    });
    this.logger.log(`Operator created (email=${email}, role=${input.role})`);
    return toSafe(row);
  }

  /**
   * Update an operator's name and/or role. Cannot demote the last admin.
   */
  async update(id: string, patch: { name?: string; role?: string }): Promise<SafeUserDto> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('User not found: ' + id);

    const data: { name?: string; role?: string } = {};
    if (patch.name !== undefined) {
      if (patch.name.trim().length < 2) throw new BadRequestException('name must be at least 2 characters');
      data.name = patch.name.trim();
    }
    if (patch.role !== undefined) {
      if (!isRole(patch.role)) throw new BadRequestException('role must be one of: ' + ROLES.join(', '));
      if (row.role === 'admin' && patch.role !== 'admin' && (await this.adminCount()) <= 1) {
        throw new ConflictException('Cannot demote the last admin.');
      }
      data.role = patch.role;
    }
    if (Object.keys(data).length === 0) return toSafe(row);

    const updated = await this.prisma.user.update({ where: { id }, data });
    this.logger.log(`Operator updated (id=${id}, ${JSON.stringify(data)})`);
    return toSafe(updated);
  }

  /** Set a new password for an operator (admin-driven reset). Revokes their sessions. */
  async resetPassword(id: string, password: string): Promise<{ id: string; sessionsRevoked: number }> {
    if (password.length < 10) throw new BadRequestException('password must be at least 10 characters');
    const row = await this.prisma.user.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('User not found: ' + id);
    const passwordHash = await bcryptjs.hash(password, BCRYPT_ROUNDS);
    await this.prisma.user.update({ where: { id }, data: { passwordHash } });
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`Operator password reset (id=${id}, sessions revoked=${revoked.count})`);
    return { id, sessionsRevoked: revoked.count };
  }

  /**
   * Delete an operator. Cannot delete yourself here, or the last admin.
   */
  async remove(id: string, actingUserId: string): Promise<{ removed: string }> {
    const row = await this.prisma.user.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('User not found: ' + id);
    if (id === actingUserId) throw new BadRequestException('You cannot delete your own account here.');
    if (row.role === 'admin' && (await this.adminCount()) <= 1) {
      throw new ConflictException('Cannot delete the last admin.');
    }
    await this.prisma.user.delete({ where: { id } });
    this.logger.log(`Operator deleted (id=${id}, email=${row.email})`);
    return { removed: id };
  }

  /** Roles catalogue for the UI. */
  roles(): readonly Role[] {
    return ROLES;
  }

  private async adminCount(): Promise<number> {
    return this.prisma.user.count({ where: { role: 'admin' } });
  }
}

function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

function toSafe(u: { id: string; email: string; name: string; role: string; createdAt: Date }): SafeUserDto {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as Role,
    createdAt: u.createdAt.toISOString(),
  };
}
