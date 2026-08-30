/**
 * Auth Controller — registration, login, refresh, logout, profile.
 *
 * Routes:
 *   POST /api/auth/register — first account bootstraps to admin; afterwards admin-only
 *   POST /api/auth/login    — email + password → token pair
 *   POST /api/auth/refresh  — rotate refresh token → new pair
 *   POST /api/auth/logout   — revoke refresh token
 *   GET  /api/auth/me       — current operator profile
 *
 * @module auth.controller
 */

import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, RefreshDto } from './dto/auth.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public, Roles } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from './strategies/jwt.strategy';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Register an operator. Bootstrap: the first account becomes admin.
   * After that, only admin can register further operators.
   */
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Register an operator',
    description: 'The first registered account becomes admin (bootstrap). Afterwards this endpoint requires an admin token.',
  })
  @ApiBody({ type: RegisterDto })
  @ApiResponse({ status: 201, description: 'Registered — returns tokens + user' })
  @ApiResponse({ status: 400, description: 'Invalid input (password min 10 chars)' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(@Body() body: RegisterDto, @Headers('authorization') authorization?: string) {
    if (await this.authService.hasUsers()) {
      await this.authService.requireAdminBearer(authorization);
    }
    return this.authService.register(body);
  }

  /**
   * Login with email + password.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Login', description: 'Returns access + refresh tokens and the safe user profile.' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Logged in' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(@Body() body: LoginDto) {
    return this.authService.login(body.email, body.password);
  }

  /**
   * Rotate a refresh token into a new pair (old token revoked).
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Refresh tokens', description: 'Rotates the refresh token. Reusing a revoked token revokes all of the user\'s sessions.' })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({ status: 200, description: 'New token pair' })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or reused refresh token' })
  async refresh(@Body() body: RefreshDto) {
    return this.authService.refresh(body.refreshToken);
  }

  /**
   * Revoke a refresh token (idempotent).
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout', description: 'Revokes the presented refresh token. Always succeeds, so clients can clear state unconditionally.' })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({ status: 200, description: 'Revoked (or already revoked)' })
  async logout(@Body() body: RefreshDto) {
    return this.authService.logout(body.refreshToken);
  }

  /**
   * Current operator profile.
   */
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current operator profile' })
  @ApiResponse({ status: 200, description: 'Safe user profile (id, email, name, role)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid access token' })
  async me(@CurrentUser() user: AuthedRequestUser) {
    return this.authService.getMe(user.userId);
  }
}