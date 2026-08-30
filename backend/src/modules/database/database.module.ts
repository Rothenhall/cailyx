/**
 * Database Module — Provides PrismaService to all modules.
 *
 * This is a global module — PrismaService is available everywhere without explicit import.
 *
 * @module database.module
 */

import { Module, Global } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}