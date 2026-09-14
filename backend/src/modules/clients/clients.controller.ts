/**
 * Clients Controller — operator/admin REST API.
 *
 * @module clients.controller
 */

import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../common/decorators/auth.decorators';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ClientsService } from './clients.service';
import {
  CreateClientDto,
  UpdateClientDto,
  CreateClientProjectDto,
  CreateClientLoginDto,
  PostClientMessageDto,
} from './dto/clients.dto';

@ApiTags('Clients')
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @ApiOperation({ summary: 'List clients with a progress overview (score, band, open gaps, onboarding state)' })
  @ApiResponse({ status: 200, description: '{ clients: ClientOverviewDto[] }' })
  async list() {
    return this.clients.listClients();
  }

  @Post()
  @Roles('delivery-lead')
  @ApiOperation({ summary: 'Create a client' })
  @ApiBody({ type: CreateClientDto })
  @ApiResponse({ status: 201, description: 'The created client' })
  async create(@Body() body: CreateClientDto) {
    return this.clients.createClient(body);
  }

  @Get(':clientId')
  @ApiOperation({ summary: 'Get a client with its projects (status, score/band, onboarding progress)' })
  @ApiResponse({ status: 200, description: 'The client detail' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async get(@Param('clientId') clientId: string) {
    return this.clients.getClient(clientId);
  }

  @Patch(':clientId')
  @Roles('delivery-lead')
  @ApiOperation({ summary: 'Update a client (name, contact, status, owner, notes)' })
  @ApiBody({ type: UpdateClientDto })
  @ApiResponse({ status: 200, description: 'The updated client' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async update(@Param('clientId') clientId: string, @Body() body: UpdateClientDto) {
    return this.clients.updateClient(clientId, body);
  }

  /**
   * "Add client -> run the pipeline" — creates a Project under this client
   * and starts the Day-1 pipeline (technical-audit -> digital-presence ->
   * tech-stack -> competitors -> gap-analysis -> strategy -> report) in the
   * background. Returns immediately; poll GET .../projects/:projectId (via
   * GET /clients/:clientId, which lists every project with its current
   * onboardingStatus/onboardingStep) for progress.
   */
  @Post(':clientId/projects')
  @Roles('delivery-lead')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Add a project for this client and run the Day-1 pipeline',
    description:
      'Creates the project and starts the full audit-to-report pipeline in the background. Returns immediately with onboardingStatus "running" — poll GET /clients/:clientId for progress.',
  })
  @ApiBody({ type: CreateClientProjectDto })
  @ApiResponse({ status: 201, description: 'The created project (onboardingStatus: "running")' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 409, description: 'A project for this domain already exists' })
  async createProject(@Param('clientId') clientId: string, @Body() body: CreateClientProjectDto) {
    return this.clients.createProject(clientId, body);
  }

  @Post(':clientId/login')
  @Roles('delivery-lead')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary: 'Create a client-portal login for this client',
    description:
      'Generates a temporary password, creates a type="client" User row, and best-effort emails it via Plunk. The password is returned exactly once in the response — relay it by hand if emailSent is false.',
  })
  @ApiBody({ type: CreateClientLoginDto })
  @ApiResponse({ status: 201, description: 'The created login, including the one-time temporary password' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async createLogin(@Param('clientId') clientId: string, @Body() body: CreateClientLoginDto) {
    return this.clients.createClientLogin(clientId, body);
  }

  @Get(':clientId/messages')
  @ApiOperation({ summary: 'List the message thread with this client' })
  @ApiResponse({ status: 200, description: '{ messages: ClientMessageDto[] }' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async listMessages(@Param('clientId') clientId: string) {
    return this.clients.listMessages(clientId);
  }

  @Post(':clientId/messages')
  @ApiOperation({ summary: 'Post a message to this client (visible to them in the client portal)' })
  @ApiBody({ type: PostClientMessageDto })
  @ApiResponse({ status: 201, description: 'The posted message' })
  @ApiResponse({ status: 404, description: 'Client not found' })
  async postMessage(@Param('clientId') clientId: string, @Body() body: PostClientMessageDto, @Req() req: Request) {
    const user = req.user as AuthedRequestUser;
    return this.clients.postMessage(clientId, user.userId, body);
  }
}
