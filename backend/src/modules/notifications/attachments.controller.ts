/**
 * AttachmentsController — G08. Operator-side upload/list/download/delete,
 * scoped to a project. A client-portal download counterpart lives in
 * `PortalAttachmentsController` below — kept in the same file since both
 * are thin wrappers over the same authorized `AttachmentsService.download`.
 *
 * @module attachments.controller
 */

import { Body, Controller, Delete, Get, Header, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClientPortal } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { AttachmentsService } from './attachments.service';
import { UploadAttachmentDto } from './dto/notifications.dto';

@ApiTags('attachments')
@ApiBearerAuth()
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Post('projects/:projectId/attachments')
  @ApiOperation({ summary: 'Upload a file scoped to this project (base64 body — no multipart upload backend is wired up)' })
  @ApiBody({ type: UploadAttachmentDto })
  @ApiResponse({ status: 201, description: 'The created attachment (metadata only, no content)' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async upload(@Param('projectId') projectId: string, @Body() body: UploadAttachmentDto, @CurrentUser() user: AuthedRequestUser) {
    return this.attachments.uploadForProject(projectId, user, body);
  }

  @Get('projects/:projectId/attachments')
  @ApiOperation({ summary: 'List attachments for this project' })
  @ApiResponse({ status: 200, description: '{ attachments: AttachmentDto[] }' })
  async list(@Param('projectId') projectId: string) {
    return this.attachments.listForProject(projectId);
  }

  @Get('attachments/:id/download')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Download a file by id — authorized against Attachment.visibility and the caller\'s scope on every call' })
  @ApiResponse({ status: 200, description: 'Raw file bytes' })
  @ApiResponse({ status: 403, description: 'Not visible to this caller' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async download(@Param('id') id: string, @CurrentUser() user: AuthedRequestUser, @Res() res: Response) {
    const file = await this.attachments.download(id, user);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.send(file.buffer);
  }

  @Delete('attachments/:id')
  @ApiOperation({ summary: 'Soft-delete an attachment (operator only)' })
  @ApiResponse({ status: 200, description: 'Deleted' })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthedRequestUser) {
    await this.attachments.softDelete(id, user);
    return { deleted: true };
  }
}

@ApiTags('attachments')
@ApiBearerAuth()
@Controller('portal/attachments')
@ClientPortal()
export class PortalAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/download')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Download a client-visible file by id — an operator-only attachment 403s here even with a guessed id' })
  @ApiResponse({ status: 200, description: 'Raw file bytes' })
  @ApiResponse({ status: 403, description: 'Not visible to this client, or belongs to another client' })
  @ApiResponse({ status: 404, description: 'Not found' })
  async download(@Param('id') id: string, @CurrentUser() user: AuthedRequestUser, @Res() res: Response) {
    const file = await this.attachments.download(id, user);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.send(file.buffer);
  }
}
