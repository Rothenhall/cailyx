/**
 * NotificationsController — G08. Operator's own notification inbox and
 * preferences. `@CurrentUser()` supplies the recipient — never a
 * client-supplied userId, so one user can never read or mark another's
 * notifications.
 *
 * @module notifications.controller
 */

import { Body, Controller, Get, Param, Patch, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { NotificationsService } from './notifications.service';
import { ListNotificationsQueryDto, PutNotificationPreferencesDto } from './dto/notifications.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(protected readonly service: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "The caller's own notification inbox, newest first" })
  @ApiResponse({ status: 200, description: '{ notifications, nextCursor, unreadCount }' })
  async list(@CurrentUser() user: AuthedRequestUser, @Query() query: ListNotificationsQueryDto) {
    return this.service.list(user.userId, query);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification read (idempotent — re-marking an already-read row is a no-op)' })
  @ApiResponse({ status: 200, description: 'The updated notification' })
  @ApiResponse({ status: 404, description: 'Not found, or belongs to another user' })
  async markRead(@Param('id') id: string, @CurrentUser() user: AuthedRequestUser) {
    return this.service.markRead(user.userId, id);
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notification-preferences')
export class NotificationPreferencesController {
  constructor(protected readonly service: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "The caller's per-kind notification preferences" })
  @ApiResponse({ status: 200, description: '{ preferences: NotificationPreferenceDto[] }' })
  async get(@CurrentUser() user: AuthedRequestUser) {
    return this.service.getPreferences(user.userId);
  }

  @Put()
  @ApiOperation({ summary: 'Replace the caller\'s notification preferences' })
  @ApiBody({ type: PutNotificationPreferencesDto })
  @ApiResponse({ status: 200, description: '{ preferences: NotificationPreferenceDto[] }' })
  async put(@CurrentUser() user: AuthedRequestUser, @Body() body: PutNotificationPreferencesDto) {
    return this.service.putPreferences(user.userId, body.preferences);
  }
}
