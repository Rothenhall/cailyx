/**
 * Users Module — operator administration (admin only).
 *
 * CRUD behind the dashboard User Management UI. Depends on DatabaseModule
 * (PrismaService). Login / registration / token rotation stay in `auth`.
 *
 * @module users.module
 */

import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
