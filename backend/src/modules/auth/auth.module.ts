/**
 * Auth Module — operator accounts, JWT access/refresh, role guards (Wave 0).
 *
 * Registers:
 * - AuthController/AuthService (register/login/refresh/logout/me)
 * - JwtStrategy (passport-jwt bearer verification)
 * - JwtAuthGuard + RolesGuard as GLOBAL guards via APP_GUARD — every other
 *   module's endpoints require a valid token unless marked @Public().
 *
 * Depends on: DatabaseModule (PrismaService)
 *
 * @module auth.module
 */

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}), // signing config read per-call from ConfigService (secret/TTL)
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}