/**
 * Auth Controller — registration, login, refresh, logout, profile, sessions,
 * and password lifecycle (G01).
 *
 * Routes:
 *   POST /api/auth/register             — first account bootstraps to admin; afterwards admin-only
 *   POST /api/auth/login                — email + password → token pair
 *   POST /api/auth/refresh              — rotate refresh token → new pair
 *   POST /api/auth/logout               — revoke refresh token
 *   GET  /api/auth/me                   — current operator profile
 *   POST /api/auth/password/change      — currentPassword/newPassword (authenticated)
 *   POST /api/auth/password/forgot      — email → always-generic response
 *   POST /api/auth/password/reset       — single-use token/newPassword
 *   GET  /api/auth/sessions             — the caller's active sessions
 *   DELETE /api/auth/sessions/:sessionId — revoke one session
 *   POST /api/auth/logout-all           — revoke every session
 *
 * `GET /api/portal/me` (the client-portal identity equivalent of `/auth/me`)
 * lives in {@link PortalController} — same module, separate controller,
 * because it is a `@ClientPortal()` route and must never share a controller
 * class with operator-only routes.
 *
 * @module auth.controller
 */

import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import type { SessionRequestMeta } from './auth.service';
import { LoginDto, RegisterDto, RefreshDto, ChangePasswordDto, ForgotPasswordDto, ResetPasswordDto } from './dto/auth.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from './strategies/jwt.strategy';

/** Best-effort session metadata off the raw request — never throws. */
function sessionMeta(req: Request): SessionRequestMeta {
  return {
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip ?? req.socket?.remoteAddress ?? undefined,
  };
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * AU06 — bootstrap-state discovery.
   *
   * The setup screen has to know whether it is showing "create the first
   * administrator" or "this installation is already set up", and it must know
   * that *before* anyone is authenticated — that is the whole point of a
   * bootstrap screen. G01 asks for this explicitly.
   *
   * Deliberately minimal: it answers one boolean and nothing else. It does not
   * report how many users exist, when the last one signed in, or anything that
   * would let an unauthenticated caller enumerate the deployment. Knowing that
   * a Cailyx instance is unconfigured is the least it can disclose to be
   * useful, and it is already observable by attempting registration.
   */
  @Public()
  @Get('bootstrap-state')
  @ApiOperation({
    summary: 'Whether this installation still needs its first administrator',
    description: 'Public by necessity — the setup screen runs before any account exists. Returns only a boolean.',
  })
  @ApiResponse({ status: 200, description: '{ needsSetup: boolean }' })
  async bootstrapState() {
    return { needsSetup: !(await this.authService.hasUsers()) };
  }

  /**
   * Register an operator. Bootstrap: the first account becomes admin.
   * After that, only admin can register further operators.
   *
   * `@Public()` is load-bearing: without it the global JwtAuthGuard rejects the
   * unauthenticated request, and the first administrator can never be created,
   * which makes the whole installation unbootstrappable. The service still
   * enforces the real rule — after any user exists, an admin bearer is required.
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
  async register(@Body() body: RegisterDto, @Req() req: Request, @Headers('authorization') authorization?: string) {
    if (await this.authService.hasUsers()) {
      await this.authService.requireAdminBearer(authorization);
    }
    return this.authService.register(body, sessionMeta(req));
  }

  /**
   * Login with email + password.
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Login', description: 'Returns access + refresh tokens and the safe user profile. Both operator and client-portal accounts use this route.' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Logged in' })
  @ApiResponse({ status: 401, description: 'Invalid credentials, or the account is disabled' })
  async login(@Body() body: LoginDto, @Req() req: Request) {
    return this.authService.login(body.email, body.password, sessionMeta(req));
  }

  /**
   * Rotate a refresh token into a new pair (old token revoked).
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Refresh tokens', description: 'Rotates the refresh token, reusing the same session. Reusing a revoked token revokes all of the user\'s sessions.' })
  @ApiBody({ type: RefreshDto })
  @ApiResponse({ status: 200, description: 'New token pair' })
  @ApiResponse({ status: 401, description: 'Invalid, expired, or reused refresh token; or the account is now disabled' })
  async refresh(@Body() body: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(body.refreshToken, sessionMeta(req));
  }

  /**
   * Revoke a refresh token (idempotent).
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout', description: 'Revokes the presented refresh token and its session. Always succeeds, so clients can clear state unconditionally.' })
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
  @ApiOperation({ summary: 'Get current operator profile', description: 'Operator accounts only — a client-portal login must use GET /api/portal/me.' })
  @ApiResponse({ status: 200, description: 'Safe user profile (id, email, name, role, mustChangePassword)' })
  @ApiResponse({ status: 401, description: 'Missing/invalid access token' })
  @ApiResponse({ status: 403, description: 'Caller is a client-portal account' })
  async me(@CurrentUser() user: AuthedRequestUser) {
    return this.authService.getMe(user.userId);
  }

  /**
   * Change the caller's own password (G01, AU05). Revokes every other live
   * session; the session making this request survives.
   */
  @Post('password/change')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Change password', description: 'Requires the current password. Revokes every other session; clears the forced first-login flag.' })
  @ApiBody({ type: ChangePasswordDto })
  @ApiResponse({ status: 200, description: '{ sessionsRevoked }' })
  @ApiResponse({ status: 401, description: 'currentPassword is incorrect' })
  async changePassword(@CurrentUser() user: AuthedRequestUser, @Body() body: ChangePasswordDto) {
    return this.authService.changePassword(user.userId, user.sessionId, body.currentPassword, body.newPassword);
  }

  /**
   * Request a password reset link (G01, AU03). Public — always the same
   * generic response, so the response itself never confirms an email exists.
   */
  @Public()
  @Post('password/forgot')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Request a password reset', description: 'Always returns the same generic message — this endpoint never reveals whether the email is registered.' })
  @ApiBody({ type: ForgotPasswordDto })
  @ApiResponse({ status: 200, description: '{ message }' })
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.forgotPassword(body.email);
  }

  /**
   * Redeem a password reset token (G01, AU03). Public, single-use, expiring.
   */
  @Public()
  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Reset password with a token', description: 'Single-use, expiring. Revokes every session on success.' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({ status: 200, description: '{ reset: true }' })
  @ApiResponse({ status: 401, description: 'Token is invalid, expired, already used, or the account is disabled' })
  async resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body.token, body.newPassword);
  }

  /**
   * The caller's active sessions (G01, AU05).
   */
  @Get('sessions')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions', description: 'Live, unexpired sessions for the calling account, most-recently-seen first.' })
  @ApiResponse({ status: 200, description: '{ sessions: SessionDto[] }' })
  async sessions(@CurrentUser() user: AuthedRequestUser) {
    return this.authService.listSessions(user.userId, user.sessionId);
  }

  /**
   * Revoke one of the caller's own sessions.
   */
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke one session', description: 'Immediately revokes the session and its currently-correlated refresh token.' })
  @ApiResponse({ status: 200, description: '{ revoked: boolean }' })
  @ApiResponse({ status: 404, description: 'Session not found, or belongs to another account' })
  async revokeSession(@CurrentUser() user: AuthedRequestUser, @Param('sessionId') sessionId: string) {
    return this.authService.revokeSession(user.userId, sessionId);
  }

  /**
   * Sign out everywhere (G01, AU05 "sign out everywhere"). Unlike
   * password/change, this revokes ALL sessions including the current one.
   */
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out everywhere', description: 'Revokes every live session for the calling account, including the one making this request.' })
  @ApiResponse({ status: 200, description: '{ sessionsRevoked }' })
  async logoutAll(@CurrentUser() user: AuthedRequestUser) {
    return this.authService.logoutAll(user.userId);
  }
}
