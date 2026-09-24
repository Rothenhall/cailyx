/**
 * Progress Controller — operator review of each audit's progress page.
 *
 * Routes (all under `/api/projects/:projectId/progress`, operator-only — no
 * `@ClientPortal()`, so RolesGuard's default-deny keeps client accounts out):
 *   GET  /reviews                       every review for the project, newest audit first
 *   GET  /reviews/:reviewId             one review, with the page exactly as a report would draw it
 *   POST /audits/:auditId/generate      (re)build the review for a completed audit — resets it to draft
 *   POST /reviews/:reviewId/approve     make it eligible for the client's report
 *   POST /reviews/:reviewId/reject      keep it out of the report, with a reason
 *
 * Every handler runs the same `assertProjectAccess` preamble as the results
 * and reporting controllers: being an operator is not enough, the caller must
 * be an admin or assigned to this project — approving a page puts it in front
 * of that project's client.
 *
 * Clients never read a review directly: an approved review reaches them only
 * inside a report, where the report lifecycle freezes it.
 *
 * @module progress.controller
 */

import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { PrismaService } from '../database/prisma.service';
import { ProgressService } from './progress.service';
import { ApproveProgressReviewDto, RejectProgressReviewDto } from './dto/progress.dto';

@ApiTags('Progress')
@ApiBearerAuth()
@Controller('projects/:projectId/progress')
export class ProgressController {
  constructor(
    private readonly progress: ProgressService,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeValidationService,
  ) {}

  @Get('reviews')
  @ApiOperation({ summary: "A project's progress reviews, newest audit first" })
  @ApiResponse({ status: 200, description: '{ reviews: ProgressReviewDto[] }' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.progress.list(projectId);
  }

  @Get('reviews/:reviewId')
  @ApiOperation({ summary: 'One progress review, including the page preview a report would draw' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 404, description: 'Review not found in this project' })
  async get(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string, @Param('reviewId') reviewId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.progress.get(projectId, reviewId);
  }

  @Post('audits/:auditId/generate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Build or rebuild the progress review for a completed audit',
    description:
      'Compares the audit with every earlier audit that asked the same questions on the same engines and markets, ' +
      'joins the changes to verified client-visible work, and writes the page. Resets an approved or rejected review ' +
      'to draft. A first audit, an audit with no comparable predecessor, or one with no material improvement is ' +
      'recorded as not-applicable with the reason.',
  })
  @ApiResponse({ status: 400, description: 'Audit has not completed yet' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 404, description: 'Audit not found in this project' })
  async generate(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string, @Param('auditId') auditId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    const audit = await this.prisma.aeoAudit.findUnique({ where: { id: auditId }, select: { projectId: true } });
    if (!audit || audit.projectId !== projectId) throw new NotFoundException('Audit not found: ' + auditId);
    return this.progress.generateForAudit(auditId, { preserveReviewed: false });
  }

  @Post('reviews/:reviewId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Approve a review — it then appears in this audit's client report" })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 409, description: 'Review is not in a state that can be approved' })
  async approve(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: ApproveProgressReviewDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.progress.approve(projectId, reviewId, user.userId, dto?.note);
  }

  @Post('reviews/:reviewId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a review — it stays out of the client report' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 409, description: 'Review is not in a state that can be rejected' })
  async reject(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: RejectProgressReviewDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.progress.reject(projectId, reviewId, user.userId, dto.note);
  }
}
