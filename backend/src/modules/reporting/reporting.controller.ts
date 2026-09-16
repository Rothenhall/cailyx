/**
 * Reporting Controller — REST API for diagnostic reports and (G05) their
 * editorial lifecycle.
 *
 * Three route groups, all in this file because they share one subject and one
 * service pair:
 *
 *   /api/projects/:projectId/reports      — generate, read, review, release,
 *                                           share links, delivery attempts
 *   /api/reports/classify-legacy          — the one-shot pre-G05 migration
 *   /api/reports/shared/:token            — the token-only public render
 *
 * Every operator handler validates project access and resolves the report
 * *within* the URL's `:projectId` before touching a row (AGENT-BRIEF rule 1;
 * design_plan G03 — the previous version of this controller resolved a slug
 * with no project check at all).
 *
 * The client-facing released reads stay in the `client-portal` module's own
 * routes (`GET /api/portal/reports`, `GET /api/portal/reports/:slug`), which
 * now delegate to this module's release-gated service methods rather than to
 * the live report row.
 *
 * @module reporting.controller
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { ScopeValidationService } from '../../common/guards/scope-validation.service';
import { AuthService } from '../auth/auth.service';
import { ReportingService } from './reporting.service';
import { ReportLifecycleService } from './report-lifecycle.service';
import type { ReportPdfArtifact } from './report-pdf';
import {
  ApproveReportDto,
  ClassifyLegacyReportsDto,
  CreateShareLinkDto,
  DeliverReportDto,
  GenerateReportDto,
  ListDeliveryAttemptsQueryDto,
  ListShareLinksQueryDto,
  PublishReportDto,
  ReviewReportDto,
  SetVisibilityDto,
  WithdrawReportDto,
} from './dto/reporting.dto';

/** §2.2: submitting a report for review is the author's action; deciding and releasing are the delivery lead's. */
const REVIEW_ROLES = ['admin', 'delivery-lead', 'content', 'technical', 'outreach'] as const;
const RELEASE_ROLES = ['admin', 'delivery-lead'] as const;
/** §2.2 "Publish client report → Sales: deliver approved report only". */
const DELIVER_ROLES = ['admin', 'delivery-lead', 'sales'] as const;

@ApiTags('Reporting')
@ApiBearerAuth()
@Throttle({ default: { ttl: 60000, limit: 100 } })
@Controller('projects/:projectId/reports')
export class ReportingController {
  constructor(
    private readonly reportingService: ReportingService,
    private readonly lifecycle: ReportLifecycleService,
    private readonly auth: AuthService,
    private readonly scope: ScopeValidationService,
  ) {}

  // ─── Creation and reads ─────────────────────────────────────────

  /**
   * Generate a diagnostic report for a project (PRD FR-10.1).
   * Aggregates the latest technical-audit, entity-audit, and gap-analysis data.
   *
   * The new report is a **draft**: since G05 it is no longer automatically
   * readable by the client's portal. It reaches the client only through
   * review → approve → release (§5.10 step 5).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary: 'Generate a diagnostic report',
    description: 'Aggregates technical-audit findings, entity-audit schema checks, and gap-analysis roadmap into a scored, branded report. Requires a technical audit to have been run first. The result is an unreleased draft.',
  })
  @ApiBody({ type: GenerateReportDto })
  @ApiResponse({ status: 201, description: 'Report generated as an unreleased draft' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  @ApiResponse({ status: 404, description: 'No technical audit found for project' })
  @ApiResponse({ status: 429, description: 'Rate limited to 3/minute' })
  async generate(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Body() body: GenerateReportDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reportingService.generateReport(projectId, body.targetUrl, body.title, {
      periodId: body.periodId,
      cohortId: body.cohortId,
    });
  }

  /** List a project's reports with both axes: `visibility` (public link) and `status`/`releasedRevision` (editorial state). */
  @Get()
  @ApiOperation({ summary: 'List reports for a project' })
  @ApiResponse({ status: 200, description: 'Array of report summaries carrying visibility, editorial status and released revision' })
  @ApiResponse({ status: 403, description: 'Caller is not assigned to this project' })
  async list(@CurrentUser() user: AuthedRequestUser, @Param('projectId') projectId: string) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reportingService.listReports(projectId);
  }

  /** Full report JSON for an operator — the live row, including drafts and unreleased work. */
  @Get(':slug/view')
  @ApiOperation({ summary: 'Get report JSON by slug' })
  @ApiResponse({ status: 200, description: 'Full report data (live row, drafts included)' })
  @ApiResponse({ status: 404, description: 'Report not found for this project' })
  async getBySlug(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    // includePrivate: this is the operator surface (RolesGuard already rejects
    // client JWTs here). `visibility` gates the unauthenticated HTML link, not
    // an operator reading their own project's report.
    return this.reportingService.getBySlug(slug, { includePrivate: true, projectId });
  }

  /**
   * Render the branded HTML report (FR-10.1, FR-10.3).
   * `?view=detailed` for the detailed register; default is the executive one-pager.
   *
   * `@Public()` — this is the "public/private per visibility" link: a report
   * marked `visibility: "public"` opens for anyone with the URL, no login
   * required. A logged-in operator can still preview their own private
   * (default) reports by sending a bearer token — verified here manually
   * (best-effort, never throws) since the route itself skips the auth guard.
   *
   * Since G05 the page renders the report's **released revision** when it has
   * one, so a published page cannot change under a reader when the report is
   * regenerated afterwards (§6.4: published reports are frozen snapshots).
   */
  @Public()
  @Get(':slug/render')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: 'Render branded HTML report' })
  @ApiResponse({ status: 200, description: 'HTML report page — public reports need no auth; private reports need an operator bearer token' })
  @ApiResponse({ status: 404, description: 'Report not found, or private and no valid operator token was sent' })
  async renderHtml(
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Query('view') view?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const isOperator = await this.auth.isValidBearer(authorization);
    return this.reportingService.renderHtml(slug, view === 'detailed' ? 'detailed' : 'executive', {
      includePrivate: isOperator,
      projectId,
    });
  }

  /**
   * The same report as a PDF file, for a client who needs a document rather
   * than a page.
   *
   * **Same gating as `:slug/render`, literally**: both routes call
   * `ReportingService`'s one document path (`documentFor`), so the project
   * scoping, the `visibility`/`includePrivate` rule and the frozen
   * released-revision resolution cannot differ between them. A PDF is not a
   * looser surface than the HTML page at the same URL — it is the same report
   * with a different layout.
   *
   * `@Public()` for the same reason the HTML route is: a report marked
   * `visibility: "public"` opens for anyone with the URL, while an operator
   * bearer token previews a private (default) report. `?view=detailed` selects
   * the full register.
   */
  @Public()
  @Get(':slug/render.pdf')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Render the report as a PDF (same gating as the HTML render)',
    description: 'A real PDF artifact generated server-side from the same document model as the HTML page: the released revision\'s frozen snapshot, or the live row for an operator previewing a draft. Content-Disposition is inline with the report slug and revision number as the filename.',
  })
  @ApiResponse({ status: 200, description: 'application/pdf — public reports need no auth; private reports need an operator bearer token' })
  @ApiResponse({ status: 404, description: 'Report not found, or private and no valid operator token was sent' })
  @ApiResponse({ status: 429, description: 'Rate limited to 20/minute' })
  async renderPdf(
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Query('view') view?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<StreamableFile> {
    const isOperator = await this.auth.isValidBearer(authorization);
    const artifact = await this.reportingService.renderPdf(slug, view === 'detailed' ? 'detailed' : 'executive', {
      includePrivate: isOperator,
      projectId,
    });
    return pdfResponse(artifact);
  }

  /**
   * Turn the report's public "anyone with the URL" flag on or off (FR-10.5).
   *
   * **This is not a QA state.** Editorial release is `POST :slug/publish`;
   * this flag only governs the unauthenticated HTML link (§6.4, G19/D10).
   * Role-restricted to admin/delivery-lead (G03: "report visibility ... does
   * not have specialist-role enforcement today").
   */
  @Put(':slug/visibility')
  @HttpCode(HttpStatus.OK)
  @Roles(...RELEASE_ROLES)
  @ApiOperation({ summary: 'Set report visibility (private/public) — the public link flag, not the editorial state' })
  @ApiBody({ type: SetVisibilityDto })
  @ApiResponse({ status: 200, description: 'Visibility updated' })
  @ApiResponse({ status: 403, description: 'Role cannot change report visibility' })
  async setVisibility(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: SetVisibilityDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.reportingService.setVisibility(projectId, slug, body.visibility);
  }

  // ─── G05 — editorial lifecycle ──────────────────────────────────

  /**
   * Both axes for one report, plus the release gate's current verdict.
   *
   * RP04 reads this to render the state machine without inferring any of it:
   * `status`/`releasedRevision` is the editorial axis, `visibility` the public
   * one, `inFlightRevision` the version being prepared while an older one is
   * live, and `publishBlocked` says — before anyone presses the button — what
   * would refuse a release right now.
   */
  @Get(':slug/lifecycle')
  @ApiOperation({ summary: 'Editorial lifecycle, revision history and release-gate status' })
  @ApiResponse({ status: 200, description: 'ReportLifecycleDto' })
  @ApiResponse({ status: 404, description: 'Report not found for this project' })
  async getLifecycle(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.getLifecycle(projectId, slug);
  }

  /** Every revision of a report, newest first (metadata only — no snapshot bodies). */
  @Get(':slug/revisions')
  @ApiOperation({ summary: 'List report revisions (newest first)' })
  @ApiResponse({ status: 200, description: '{ revisions: ReportRevisionDto[] }' })
  async listRevisions(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.listRevisions(projectId, slug);
  }

  /** One revision with its frozen snapshot — exactly what a reviewer approves and a client later reads. */
  @Get(':slug/revisions/:revision')
  @ApiParam({ name: 'revision', type: Number })
  @ApiOperation({ summary: 'One revision including its frozen snapshot' })
  @ApiResponse({ status: 200, description: 'ReportRevisionDetailDto' })
  @ApiResponse({ status: 404, description: 'Revision not found for this report' })
  async getRevision(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Param('revision', ParseIntPipe) revision: number,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.getRevision(projectId, slug, revision);
  }

  /**
   * Lock the report's current content for review (§8.3 "InReview: Snapshot
   * locked"). Creates the first revision, re-locks a draft sent back with
   * changes requested, or opens a new revision when the previous one is
   * settled.
   */
  @Post(':slug/review')
  @HttpCode(HttpStatus.OK)
  @Roles(...REVIEW_ROLES)
  @ApiOperation({
    summary: 'Lock the snapshot for review',
    description: 'Creates revision N+1 (or re-locks the current draft) and freezes its snapshot. Any pending approval request bound to an older revision is invalidated.',
  })
  @ApiBody({ type: ReviewReportDto })
  @ApiResponse({ status: 200, description: 'The revision now in review, with its frozen snapshot' })
  @ApiResponse({ status: 409, description: 'The newest revision is already in review or approved' })
  async review(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: ReviewReportDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.review(projectId, slug, user.userId, body);
  }

  /** Record the QA decision against the revision in review: `approved`, or `changes-requested` which returns it to draft. */
  @Post(':slug/approve')
  @HttpCode(HttpStatus.OK)
  @Roles(...RELEASE_ROLES)
  @ApiOperation({ summary: 'Decide the revision in review (approved | changes-requested)' })
  @ApiBody({ type: ApproveReportDto })
  @ApiResponse({ status: 200, description: 'The decided revision' })
  @ApiResponse({ status: 409, description: 'Nothing is in review, or the revision is not decidable' })
  async approve(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: ApproveReportDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.approve(projectId, slug, user.userId, body);
  }

  /**
   * Release an approved revision to the client (§8.3 "Approved →
   * PublishedToClient").
   *
   * The G10 release gate runs first and its refusal is propagated: unresolved
   * approvals on this exact revision and blocked claims linked to it both
   * refuse. Releasing does not send anything and does not mint a public link —
   * delivery and public sharing are separate actions.
   */
  @Post(':slug/publish')
  @HttpCode(HttpStatus.OK)
  @Roles(...RELEASE_ROLES)
  @ApiOperation({ summary: 'Release an approved revision to the client' })
  @ApiBody({ type: PublishReportDto })
  @ApiResponse({ status: 200, description: 'The released revision' })
  @ApiResponse({ status: 409, description: 'Not approved, or the publish gate refused (unresolved approval / blocked claim)' })
  async publish(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: PublishReportDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.publish(projectId, slug, user.userId, body.note);
  }

  /** Pull a released report back from the client, with a recorded reason (§8.3, terminal). Every share link stops resolving. */
  @Post(':slug/withdraw')
  @HttpCode(HttpStatus.OK)
  @Roles(...RELEASE_ROLES)
  @ApiOperation({ summary: 'Withdraw the released revision from the client' })
  @ApiBody({ type: WithdrawReportDto })
  @ApiResponse({ status: 200, description: 'The withdrawn revision' })
  @ApiResponse({ status: 409, description: 'Nothing is released for this report' })
  async withdraw(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: WithdrawReportDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.withdraw(projectId, slug, user.userId, body);
  }

  // ─── G05 — share links (the public axis) ────────────────────────

  /** Every share link for a report. Tokens are never returned — only that a link exists, and whether it still resolves. */
  @Get(':slug/share-links')
  @ApiOperation({ summary: 'List share links for a report (no tokens)' })
  @ApiResponse({ status: 200, description: '{ links: ShareLinkDto[] }' })
  async listShareLinks(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Query() query: ListShareLinksQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.listShareLinks(projectId, slug, query.includeRevoked !== false);
  }

  /**
   * Mint an expiring public link for a **released** report. The raw token is
   * returned once and never stored — only its sha256 is.
   */
  @Post(':slug/share-links')
  @HttpCode(HttpStatus.CREATED)
  @Roles(...RELEASE_ROLES)
  @ApiOperation({
    summary: 'Create an expiring, revocable public share link',
    description: 'Only a released report can be shared (§6.4 excludes unpublished drafts from the public projection). Returns the raw token exactly once.',
  })
  @ApiBody({ type: CreateShareLinkDto })
  @ApiResponse({ status: 201, description: 'ShareLinkCreatedDto — includes the raw token and its path, this once' })
  @ApiResponse({ status: 409, description: 'Report is not released' })
  async createShareLink(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: CreateShareLinkDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.createShareLink(projectId, slug, user.userId, body);
  }

  /** Revoke a share link. It stops resolving immediately; the report's release state is untouched. */
  @Delete(':slug/share-links/:linkId')
  @HttpCode(HttpStatus.OK)
  @Roles(...RELEASE_ROLES)
  @ApiOperation({ summary: 'Revoke a share link (idempotent)' })
  @ApiResponse({ status: 200, description: 'The revoked link' })
  @ApiResponse({ status: 404, description: 'Link not found for this report' })
  async revokeShareLink(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Param('linkId') linkId: string,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.revokeShareLink(projectId, slug, linkId, user.userId);
  }

  // ─── G05 — delivery attempts ────────────────────────────────────

  /** The send attempts recorded for a report. `sent` means the provider accepted the message — never that it was read. */
  @Get(':slug/delivery-attempts')
  @ApiOperation({ summary: 'Delivery attempts for a report (newest first)' })
  @ApiResponse({ status: 200, description: '{ attempts: DeliveryAttemptDto[] }' })
  async listDeliveryAttempts(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Query() query: ListDeliveryAttemptsQueryDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.listDeliveryAttempts(projectId, slug, query.limit ?? 50);
  }

  /**
   * Record a delivery attempt (and, for `email`, attempt it).
   *
   * Responds 200 with the attempt row either way: a failed send is a recorded
   * outcome, not a failed request, and it never changes the report's release
   * state — the client can still read the report in their portal.
   */
  @Post(':slug/delivery-attempts')
  @HttpCode(HttpStatus.OK)
  @Roles(...DELIVER_ROLES)
  @ApiOperation({
    summary: 'Record (and for email, attempt) a delivery of a released report',
    description: 'Requires a released report. Records the attempt before the provider is called, so an interrupted send is visible as "queued". A failed send does not roll back the release.',
  })
  @ApiBody({ type: DeliverReportDto })
  @ApiResponse({ status: 200, description: 'DeliveryAttemptDto — status "sent" | "failed" | "queued"' })
  @ApiResponse({ status: 400, description: 'Email channel without a reportUrl (the link the recipient opens)' })
  @ApiResponse({ status: 409, description: 'Report is not released, or the recipient is not an email address' })
  async deliver(
    @CurrentUser() user: AuthedRequestUser,
    @Param('projectId') projectId: string,
    @Param('slug') slug: string,
    @Body() body: DeliverReportDto,
  ) {
    await this.scope.assertProjectAccess(user, projectId);
    return this.lifecycle.deliver(projectId, slug, user.userId, body);
  }
}

// ─── Pre-G05 migration (D11 / G05 "Migration") ────────────────────

@ApiTags('Reporting')
@ApiBearerAuth()
@Controller('reports')
export class ReportMigrationController {
  constructor(private readonly lifecycle: ReportLifecycleService) {}

  /**
   * Classify the reports that predate G05.
   *
   * Admin-only, idempotent, and dry-runnable. See
   * {@link ReportLifecycleService.classifyLegacyReports} for the policy and
   * the module README for why "keep them visible, and label them" was chosen
   * over "hide everything until reviewed".
   */
  @Post('classify-legacy')
  @HttpCode(HttpStatus.OK)
  @Roles('admin')
  @ApiOperation({
    summary: 'Classify pre-G05 reports as released-at-existing-content (idempotent)',
    description: 'Reports created before the editorial lifecycle existed were visible to their clients already. This freezes each one as revision 1, status "released", decision "grandfathered", reviewedBy null, so nothing a client may have read disappears and no review that did not happen is claimed. Accepts a global admin, not a project scope.',
  })
  @ApiBody({ type: ClassifyLegacyReportsDto })
  @ApiResponse({ status: 200, description: '{ dryRun, classified, skipped, reports[] }' })
  @ApiResponse({ status: 403, description: 'Admin role required' })
  async classifyLegacy(@Body() body: ClassifyLegacyReportsDto) {
    return this.lifecycle.classifyLegacyReports(body);
  }

  /** Preview the classification without writing anything. */
  @Get('classify-legacy/preview')
  @Roles('admin')
  @ApiOperation({ summary: 'Preview the pre-G05 classification (writes nothing)' })
  @ApiResponse({ status: 200, description: '{ dryRun: true, skipped, reports[] }' })
  async previewClassifyLegacy() {
    return this.lifecycle.classifyLegacyReports({ dryRun: true });
  }
}

// ─── Public share-link render ─────────────────────────────────────

@ApiTags('Reporting')
@Controller('reports/shared')
export class SharedReportController {
  constructor(
    private readonly lifecycle: ReportLifecycleService,
    private readonly reporting: ReportingService,
  ) {}

  /**
   * Open a shared report as a PDF, by the same token.
   *
   * Declared **before** `:token` deliberately. A token never contains a dot
   * (43 base64url characters), so the two cannot collide in practice, but the
   * order makes the intent explicit rather than dependent on Express matching
   * `:token` greedily.
   *
   * Same release gate as the HTML share render: the token must be live and the
   * report must be released — a withdrawn report serves nothing here either,
   * and the resolution (`resolveShareToken`) is the same call, so the two
   * formats cannot disagree about whether a link still works.
   */
  @Public()
  @Get(':token.pdf')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiParam({ name: 'token', description: 'The raw share token. Only its sha256 is stored server-side.' })
  @ApiProduces('application/pdf')
  @ApiOperation({
    summary: 'Render a shared report as a PDF (public, token-only)',
    description: 'The currently released revision as a PDF file. Same 404 for unknown, revoked, expired, or a report with nothing released.',
  })
  @ApiResponse({ status: 200, description: 'application/pdf for the currently released revision' })
  @ApiResponse({ status: 404, description: 'Link unknown, revoked, expired, or nothing is released' })
  @ApiResponse({ status: 429, description: 'Rate limited to 20/minute' })
  async renderSharedPdf(@Param('token') token: string, @Query('view') view?: string): Promise<StreamableFile> {
    const { report, revision } = await this.lifecycle.resolveShareToken(token);
    const artifact = await this.reporting.renderReleasedPdf(
      report,
      revision,
      view === 'detailed' ? 'detailed' : 'executive',
    );
    return pdfResponse(artifact);
  }

  /**
   * Open a shared report by its token — the only unauthenticated route in this
   * module that resolves content from a capability rather than from a
   * `visibility` flag.
   *
   * Always serves the report's **current released revision**: never a draft,
   * never the mutable row, and nothing at all when the report has been
   * withdrawn or the link revoked or expired. `noindex` is forced on, because
   * a capability URL that search engines index is a capability URL that leaks.
   */
  @Public()
  @Get(':token')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiParam({ name: 'token', description: 'The raw share token. Only its sha256 is stored server-side.' })
  @ApiOperation({ summary: 'Render a shared report (public, token-only)' })
  @ApiResponse({ status: 200, description: 'HTML report page for the currently released revision' })
  @ApiResponse({ status: 404, description: 'Link unknown, revoked, expired, or nothing is released' })
  async renderShared(@Param('token') token: string, @Query('view') view?: string) {
    const { report, revision } = await this.lifecycle.resolveShareToken(token);
    return this.reporting.renderReleasedHtml(report, revision, view === 'detailed' ? 'detailed' : 'executive');
  }
}

/**
 * Wrap rendered PDF bytes as a response.
 *
 * `inline` rather than `attachment`: an operator previewing a report before
 * release should see it in the browser's viewer, and a client opening a
 * delivered link should be able to read it without first finding a download.
 * The filename still carries the slug and revision, so saving it produces a
 * name that says which version it is.
 */
function pdfResponse(artifact: ReportPdfArtifact): StreamableFile {
  return new StreamableFile(artifact.bytes, {
    type: 'application/pdf',
    disposition: `inline; filename="${artifact.filename}"`,
    length: artifact.bytes.length,
  });
}
