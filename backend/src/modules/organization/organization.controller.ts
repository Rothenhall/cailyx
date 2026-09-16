/**
 * OrganizationController — G20's HTTP surface.
 *
 * Three controller classes, one per resource group, all admin-only:
 *
 *   Admin  /api/organization/settings          — versioned, append-only
 *   Admin  /api/organization/branding          — the client-facing projection
 *   Admin  /api/organization/report-templates  — versioned layouts
 *   Admin  /api/organization/program-templates — versioned checklists
 *
 * Every route is `@Roles('admin')`. RolesGuard's default-deny for client-type
 * users means a client login cannot reach any of it even without the decorator,
 * but the decorator is what stops a non-admin OPERATOR (a delivery lead, say)
 * from rewriting the branding on every client's documents.
 *
 * `GET .../report-templates/resolve` is declared before `GET .../:id` on
 * purpose: Express matches in declaration order, so the literal path wins and
 * a template whose id happened to be "resolve" could not shadow it.
 *
 * @module organization.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/auth.decorators';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthedRequestUser } from '../auth/strategies/jwt.strategy';
import { OrganizationService } from './organization.service';
import {
  ApplyProgramTemplateDto,
  CreateProgramTemplateDto,
  CreateReportTemplateDto,
  GetSettingsQueryDto,
  ListProgramTemplatesQueryDto,
  ListReportTemplatesQueryDto,
  ResolveReportTemplateQueryDto,
  UpdateProgramTemplateDto,
  UpdateReportTemplateDto,
  WriteOrganizationSettingsDto,
} from './dto/organization.dto';

// ── Settings and branding ───────────────────────────────────────────────

@ApiTags('organization: settings')
@ApiBearerAuth()
@Roles('admin')
@Controller('organization')
export class OrganizationController {
  constructor(protected readonly service: OrganizationService) {}

  @Get('settings')
  @ApiOperation({
    summary: 'The organization settings, by default the version in force',
    description:
      'Settings rows are append-only: every write inserts a new version and modifies nothing, so "the version in force" is the highest version. When no row has ever been written the response is the schema’s declared defaults with `persisted: false` and `version: null` — running on defaults is a real state, not a missing row.',
  })
  @ApiResponse({ status: 200, description: 'OrganizationSettingsDto' })
  @ApiResponse({ status: 404, description: 'The requested version does not exist' })
  async getSettings(@Query() query: GetSettingsQueryDto) {
    return this.service.getSettings(query.version);
  }

  @Get('settings/versions')
  @ApiOperation({
    summary: 'Every settings version, newest first',
    description: 'There is no update path, so this is the complete history of what the branding and policy have been.',
  })
  @ApiResponse({ status: 200, description: '{ versions, versionInForce }' })
  async listSettingsVersions() {
    return this.service.listSettingsVersions();
  }

  @Put('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Write a new settings version',
    description:
      'Applies the patch on top of the version in force and INSERTS the result. The row it read is never modified, which is what lets a released report keep reading the values it was published under. Omitted fields carry forward; send `null` on a nullable field to clear it.',
  })
  @ApiBody({ type: WriteOrganizationSettingsDto })
  @ApiResponse({ status: 200, description: 'The new settings version' })
  @ApiResponse({ status: 400, description: 'Invalid timezone, or primaryColor is not a hex colour' })
  async writeSettings(@CurrentUser() user: AuthedRequestUser, @Body() dto: WriteOrganizationSettingsDto) {
    return this.service.writeSettings(dto, user.userId);
  }

  @Get('branding')
  @ApiOperation({
    summary: 'Branding in the shape a released document needs',
    description:
      'Wrapped with the settings version it came from, plus `cssVariables` holding the primary-colour custom property override. Shaped like the reporting module’s own BrandingConfig so adopting it is a swap rather than a mapping. No `tagline` is returned — OrganizationSettings has no column for one.',
  })
  @ApiResponse({ status: 200, description: 'BrandingSnapshot' })
  async branding() {
    return this.service.getBrandingForRelease();
  }

  @Get('release-snapshot')
  @ApiOperation({
    summary: 'Everything a release must pin: settings version, branding, policy and template',
    description:
      'The method a report release should call. A later settings edit creates a new version and a later template edit bumps that template’s version, so neither can retroactively change a document that recorded what it was published under. `templateUnavailableReason` is populated rather than silently returning null when the report type has no template.',
  })
  @ApiResponse({ status: 200, description: 'ReleaseSnapshot' })
  async releaseSnapshot(@Query() query: ResolveReportTemplateQueryDto) {
    return this.service.getReleaseSnapshot(query.reportType);
  }

  @Get('policy/public-share')
  @ApiOperation({
    summary: 'Whether public (anyone-with-the-link) shares may be minted',
    description:
      'A read of the policy in force. Modules that must not mint a public link consult `assertPublicShareAllowed` in-process rather than branching on this read alone — a boolean a caller can ignore is not a gate.',
  })
  @ApiResponse({ status: 200, description: '{ allowPublicShare, settingsVersion, persisted }' })
  async publicSharePolicy() {
    const settings = await this.service.getSettingsVersionInForce();
    return {
      allowPublicShare: settings.allowPublicShare,
      settingsVersion: settings.version,
      persisted: settings.persisted,
    };
  }
}

// ── Report templates ────────────────────────────────────────────────────

@ApiTags('organization: report templates')
@ApiBearerAuth()
@Roles('admin')
@Controller('organization/report-templates')
export class ReportTemplatesController {
  constructor(private readonly service: OrganizationService) {}

  @Get()
  @ApiOperation({ summary: 'Report templates, optionally filtered by report type' })
  @ApiResponse({ status: 200, description: '{ templates }' })
  async list(@Query() query: ListReportTemplatesQueryDto) {
    return this.service.listReportTemplates(query.reportType);
  }

  /** Declared before `:id` so the literal path cannot be shadowed. */
  @Get('resolve')
  @ApiOperation({
    summary: 'The template in force for a report type',
    description:
      'The default template of that type if it has one, otherwise the most recently updated one. Returns `{ template: null, reason }` — not a 404 — when the type has no template at all, because "not configured" is a state a release has to disclose.',
  })
  @ApiResponse({ status: 200, description: '{ template | null, reason }' })
  async resolve(@Query() query: ResolveReportTemplateQueryDto) {
    const template = await this.service.resolveReportTemplate(query.reportType);
    return {
      template,
      reason: template
        ? null
        : `No report template is configured for report type "${query.reportType}".`,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One report template, with its sections and version' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async get(@Param('id') id: string) {
    return this.service.getReportTemplate(id);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a report template (starts at version 1)',
    description:
      'Section keys must be unique — a renderer keyed on them cannot tell two sections with the same key apart. Setting `isDefault` clears the previous default of the same report type in the same transaction, so a type never has two.',
  })
  @ApiBody({ type: CreateReportTemplateDto })
  @ApiResponse({ status: 201, description: 'The created template' })
  @ApiResponse({ status: 409, description: 'Duplicate section key' })
  async create(@CurrentUser() user: AuthedRequestUser, @Body() dto: CreateReportTemplateDto) {
    return this.service.createReportTemplate(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a report template — a content change bumps its version',
    description:
      'A released document carries its own copy of the sections and the version it copied, so the bump is what keeps the pin checkable afterwards. `isDefault` is not changed here — it goes through the dedicated route so it cannot be flipped as a side effect of an edit. A save with no content change does not bump.',
  })
  @ApiBody({ type: UpdateReportTemplateDto })
  @ApiResponse({ status: 200, description: 'The updated template' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'Duplicate section key' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateReportTemplateDto,
  ) {
    return this.service.updateReportTemplate(id, dto, user.userId);
  }

  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make this the default template for its report type',
    description: 'Clears the previous default of the same type in one transaction. Does not bump the version — the layout did not change, only which one is chosen.',
  })
  @ApiResponse({ status: 200, description: 'The template, now the default' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async setDefault(@CurrentUser() user: AuthedRequestUser, @Param('id') id: string) {
    return this.service.setDefaultReportTemplate(id, user.userId);
  }
}

// ── Program templates ───────────────────────────────────────────────────

@ApiTags('organization: program templates')
@ApiBearerAuth()
@Roles('admin')
@Controller('organization/program-templates')
export class ProgramTemplatesController {
  constructor(private readonly service: OrganizationService) {}

  @Get()
  @ApiOperation({ summary: 'Program templates, optionally filtered by kind and active flag' })
  @ApiResponse({ status: 200, description: '{ templates }' })
  async list(@Query() query: ListProgramTemplatesQueryDto) {
    return this.service.listProgramTemplates({
      kind: query.kind,
      active: query.active === undefined ? undefined : query.active === 'true',
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'One program template, with its items and version' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async get(@Param('id') id: string) {
    return this.service.getProgramTemplate(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a program template (starts at version 1)' })
  @ApiBody({ type: CreateProgramTemplateDto })
  @ApiResponse({ status: 201, description: 'The created template' })
  async create(@CurrentUser() user: AuthedRequestUser, @Body() dto: CreateProgramTemplateDto) {
    return this.service.createProgramTemplate(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit a program template — a content change bumps its version',
    description:
      'Rows already copied from earlier versions are not touched: they are copies, not references, so this edit cannot reach a committed cycle’s scope.',
  })
  @ApiBody({ type: UpdateProgramTemplateDto })
  @ApiResponse({ status: 200, description: 'The updated template' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async update(
    @CurrentUser() user: AuthedRequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateProgramTemplateDto,
  ) {
    return this.service.updateProgramTemplate(id, dto, user.userId);
  }

  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Copy a template’s rows into a project — copies, never links',
    description:
      '`cycle` copies WorkItems through the delivery-plan service, so a committed cycle still demands `scopeChangeReason` and records the addition in Cycle.scopeChanges rather than silently moving a frozen denominator. `onboarding` copies OnboardingRequests; fields with no target column are reported in `notCarried`. `offboarding` has no target table and comes back as an explicit unavailable state. Editing the template afterwards cannot reach rows it already produced. `dryRun` previews without writing.',
  })
  @ApiBody({ type: ApplyProgramTemplateDto })
  @ApiResponse({ status: 200, description: 'ApplyProgramTemplateResult' })
  @ApiResponse({ status: 400, description: 'A cycle template without cycleId, or an unparseable startOn' })
  @ApiResponse({ status: 404, description: 'Template, project or cycle not found' })
  @ApiResponse({ status: 409, description: 'The template is inactive' })
  async apply(
    @CurrentUser() user: AuthedRequestUser,
    @Param('id') id: string,
    @Body() dto: ApplyProgramTemplateDto,
  ) {
    return this.service.applyProgramTemplate(id, dto, user.userId);
  }
}
