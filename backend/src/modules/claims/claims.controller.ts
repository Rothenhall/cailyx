/**
 * Claims Controller — claims-discipline guardrail API (FR-9.4).
 *
 * Routes:
 *   POST /api/projects/:projectId/claims/check     discipline-check arbitrary copy
 *   POST /api/projects/:projectId/claims           register a claim (auto-discipline-checked)
 *   GET  /api/projects/:projectId/claims?status=   list claims
 *   GET  /api/projects/:projectId/claims/:claimId  claim detail + full check report
 *   POST /api/projects/:projectId/claims/:claimId/approve  hard-gated approval
 *   POST /api/projects/:projectId/claims/:claimId/sources  attach external source (raises C->B)
 *
 * @module claims.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ClaimsService } from './claims.service';
import { AttachSourceDto, CheckCopyDto, CreateClaimDto } from './dto/claims.dto';

@ApiTags('Claims')
@Controller('projects/:projectId/claims')
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Post('check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary: 'Discipline-check arbitrary copy',
    description: 'Deterministic FR-9.4 filter: banned phrases, ungraded numbers, single-run-rate phrasing. Used by findings generation and reporting.',
  })
  @ApiResponse({ status: 200, description: 'Check report (result, banned hits, numeric claims, violations)' })
  async checkCopy(@Body() body: CheckCopyDto) {
    return this.claimsService.checkCopy(body.copy, { allowRates: body.allowRates });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Register a claim', description: 'Stored blocked when it hits banned phrases or states a rate without provenance; otherwise draft until approved with a grade.' })
  async createClaim(@Param('projectId') projectId: string, @Body() body: CreateClaimDto) {
    return this.claimsService.createClaim(projectId, body);
  }

  @Get()
  @ApiOperation({ summary: 'List claims', description: 'Optional ?status=draft|approved|blocked' })
  async listClaims(@Param('projectId') projectId: string, @Query('status') status?: string) {
    return this.claimsService.listClaims(projectId, status);
  }

  @Get(':claimId')
  @ApiOperation({ summary: 'Claim detail with full discipline report' })
  async getClaim(@Param('projectId') projectId: string, @Param('claimId') claimId: string) {
    return this.claimsService.getClaim(projectId, claimId);
  }

  @Post(':claimId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a claim (hard gate)', description: 'Requires a grade; banned-phrase and single-run-rate claims can never be approved — they 400.' })
  @ApiResponse({ status: 400, description: 'Fails discipline or ungraded' })
  async approveClaim(@Param('projectId') projectId: string, @Param('claimId') claimId: string) {
    return this.claimsService.approveClaim(projectId, claimId);
  }

  @Post(':claimId/sources')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Attach an external source', description: 'Two independent sources raise the grade to B automatically.' })
  async attachSource(@Param('projectId') projectId: string, @Param('claimId') claimId: string, @Body() body: AttachSourceDto) {
    return this.claimsService.attachSource(projectId, claimId, body);
  }
}