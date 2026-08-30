/**
 * Users Controller — operator administration. Admin only (global RolesGuard
 * + `@Roles('admin')`).
 *
 *   GET    /api/users            — list operators
 *   GET    /api/users/roles      — role catalogue
 *   POST   /api/users            — create operator
 *   GET    /api/users/:id        — one operator
 *   PATCH  /api/users/:id        — update name / role
 *   POST   /api/users/:id/password — reset password (revokes sessions)
 *   DELETE /api/users/:id        — delete operator
 *
 * @module users.controller
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto, ResetPasswordDto } from './dto/users.dto';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';

@ApiTags('Users')
@ApiBearerAuth()
@Roles('admin')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List operators (admin only)' })
  @ApiResponse({ status: 200, description: '{ users: SafeUser[] }' })
  @ApiResponse({ status: 403, description: 'Not an admin' })
  async list() {
    return this.users.list();
  }

  @Get('roles')
  @ApiOperation({ summary: 'Role catalogue for the UI' })
  @ApiResponse({ status: 200, description: '{ roles: string[] }' })
  async roles() {
    return { roles: this.users.roles() };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Create an operator with a role' })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: 'SafeUser' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async create(@Body() body: CreateUserDto) {
    return this.users.create(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one operator' })
  @ApiResponse({ status: 200, description: 'SafeUser' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update an operator name and/or role' })
  @ApiBody({ type: UpdateUserDto })
  @ApiResponse({ status: 200, description: 'Updated SafeUser' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'Cannot demote the last admin' })
  async update(@Param('id') id: string, @Body() body: UpdateUserDto) {
    return this.users.update(id, body);
  }

  @Post(':id/password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Reset an operator password (revokes their sessions)' })
  @ApiBody({ type: ResetPasswordDto })
  @ApiResponse({ status: 200, description: '{ id, sessionsRevoked }' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async resetPassword(@Param('id') id: string, @Body() body: ResetPasswordDto) {
    return this.users.resetPassword(id, body.password);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an operator' })
  @ApiResponse({ status: 200, description: '{ removed: id }' })
  @ApiResponse({ status: 400, description: 'Cannot delete your own account' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 409, description: 'Cannot delete the last admin' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthedRequestUser) {
    return this.users.remove(id, user.userId);
  }
}
