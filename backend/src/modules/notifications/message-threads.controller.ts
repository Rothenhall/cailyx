/**
 * MessageThreadsController — G08. Cursor-paginated reads over a client's
 * message thread, plus marking a read cursor. Does not write messages
 * (posting stays owned by `clients`/`client-portal` — see README.md); this
 * only adds pagination, safe author names and real read state on top.
 *
 * @module message-threads.controller
 */

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { MessageThreadsService } from './message-threads.service';
import { MarkReadCursorDto, ThreadQueryDto } from './dto/notifications.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('clients/:clientId/messages')
export class MessageThreadsController {
  constructor(private readonly threads: MessageThreadsService) {}

  @Get('thread')
  @ApiOperation({ summary: 'Cursor-paginated message thread for this client, with safe author display names (never operator emails)' })
  @ApiResponse({ status: 200, description: '{ messages, nextCursor, unreadCount }' })
  async read(@Param('clientId') clientId: string, @Query() query: ThreadQueryDto, @CurrentUser() user: AuthedRequestUser) {
    return this.threads.forOperator(clientId, user, query);
  }

  @Post('read-cursor')
  @ApiOperation({ summary: "Advance the caller's real read position for this client's thread" })
  @ApiBody({ type: MarkReadCursorDto })
  @ApiResponse({ status: 200, description: 'The updated read cursor' })
  async markRead(@Param('clientId') clientId: string, @Body() body: MarkReadCursorDto, @CurrentUser() user: AuthedRequestUser) {
    return this.threads.markRead(clientId, user.userId, body.lastReadMessageId);
  }
}

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('portal/messages')
@ClientPortal()
export class PortalMessageThreadsController {
  constructor(private readonly threads: MessageThreadsService) {}

  @Get('thread')
  @ApiOperation({ summary: "This client's own message thread, cursor-paginated. Internal notes are excluded at the query level." })
  @ApiResponse({ status: 200, description: '{ messages, nextCursor, unreadCount }' })
  async read(@Query() query: ThreadQueryDto, @CurrentUser() user: AuthedRequestUser) {
    return this.threads.forClient(this.clientId(user), user, query);
  }

  @Post('read-cursor')
  @ApiOperation({ summary: "Advance this client's real read position" })
  @ApiBody({ type: MarkReadCursorDto })
  @ApiResponse({ status: 200, description: 'The updated read cursor' })
  async markRead(@Body() body: MarkReadCursorDto, @CurrentUser() user: AuthedRequestUser) {
    return this.threads.markRead(this.clientId(user), user.userId, body.lastReadMessageId);
  }

  private clientId(user: AuthedRequestUser): string {
    if (!user.clientId) throw new Error('Client-portal route reached by a user with no clientId — guard bug, not a client error.');
    return user.clientId;
  }
}
