/**
 * PrismaService — Wrapper around Prisma Client for database access.
 *
 * Prisma 5 with SQLite file (no adapter needed). Works without Docker.
 * For PostgreSQL in production, update schema.prisma datasource to postgresql
 * and switch to @prisma/adapter-pg with Prisma 6+.
 *
 * @module database.prisma-service
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}