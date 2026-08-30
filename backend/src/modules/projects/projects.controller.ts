/**
 * Projects Controller — REST API for the backbone entity.
 *
 * Endpoints: /api/projects (root-level, not nested under other projects).
 *
 * @module projects.controller
 */

import { Controller, Get, Post, Put, Patch, Delete, Param, Body, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ProjectsService } from './projects.service';
import { CreateProjectDto, UpdateProjectDto } from './dto/projects.dto';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import type { EngagementStatus } from './projects.types';

@ApiTags('Projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  /**
   * Create a project. Domain must be unique. Stamps the creating operator as owner.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Create a project', description: 'Creates a project record. Domain is unique — one project per domain. Owner = creating operator.' })
  @ApiBody({ type: CreateProjectDto })
  @ApiResponse({ status: 201, description: 'Project created' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 409, description: 'Project for this domain already exists' })
  async create(@Body() body: CreateProjectDto, @CurrentUser() user: AuthedRequestUser) {
    return this.projectsService.create(body, user.userId);
  }

  /**
   * List projects with optional status filter and text search.
   */
  @Get()
  @ApiOperation({ summary: 'List projects', description: 'Filter by status, search across name/domain/clientName.' })
  @ApiQuery({ name: 'status', required: false, enum: ['scorecard', 'diagnostic', 'sprint', 'retainer', 'archived'] })
  @ApiQuery({ name: 'search', required: false })
  async list(@Query('status') status?: string, @Query('search') search?: string) {
    return this.projectsService.list({ status, search });
  }

  /**
   * Get project detail with artifact stats.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get project by ID' })
  @ApiResponse({ status: 200, description: 'Project with artifact stats' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getById(@Param('id') id: string) {
    return this.projectsService.getById(id);
  }

  /**
   * Update a project.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update project fields' })
  @ApiBody({ type: UpdateProjectDto })
  @ApiResponse({ status: 200, description: 'Project updated' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async update(@Param('id') id: string, @Body() body: UpdateProjectDto) {
    return this.projectsService.update(id, body);
  }

  /**
   * Lifecycle transition (scorecard → diagnostic → sprint → retainer).
   */
  @Put(':id/transition')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transition engagement lifecycle', description: 'scorecard → diagnostic → sprint → retainer. Archived is reachable from any status.' })
  @ApiResponse({ status: 200, description: 'Lifecycle transitioned' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  @ApiResponse({ status: 409, description: 'Invalid transition for current status' })
  async transition(@Param('id') id: string, @Body() body: { status: EngagementStatus }) {
    return this.projectsService.transition(id, body.status);
  }

  /**
   * Delete a project. Destructive — admin only (global RolesGuard).
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles('admin')
  @ApiOperation({ summary: 'Delete a project (admin only)' })
  @ApiResponse({ status: 204, description: 'Project deleted' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async delete(@Param('id') id: string) {
    await this.projectsService.delete(id);
  }
}