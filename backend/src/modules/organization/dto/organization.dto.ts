/**
 * DTOs for organization settings, branding, report templates and program
 * templates — `/api/organization/*`. Every route that uses these is
 * `@Roles('admin')`.
 *
 * @module dto/organization.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PROGRAM_TEMPLATE_KINDS, REPORT_TYPES, SERVICE_TIERS } from '../organization.types';

// ── Settings ────────────────────────────────────────────────────────

/**
 * A settings write is a NEW VERSION, not a patch: the row it reads is never
 * modified, so a report that pinned the previous version keeps reading the
 * values it was published under. Every field is optional and omitted fields
 * carry forward from the version in force.
 */
export class WriteOrganizationSettingsDto {
  @ApiPropertyOptional({ description: 'Shown in the app chrome and on released documents.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Absolute URL to the logo used on released documents. Send `null` to clear a previously set logo.',
  })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2000)
  logoUrl?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Hex colour applied as a CSS custom property override. Validated as hex — named colours and rgb()/hsl() are refused. Send `null` to clear it and fall back to the application default.',
    example: '#0a7c1e',
  })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  primaryColor?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Send `null` to clear.' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  supportEmail?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Send `null` to clear.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  supportName?: string | null;

  @ApiPropertyOptional({ description: 'IANA zone. Validated against Intl, not a hard-coded list.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ enum: SERVICE_TIERS, description: 'Default service tier for a new engagement.' })
  @IsOptional()
  @IsIn(SERVICE_TIERS as unknown as string[])
  defaultTier?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 720, description: 'Hours a review is expected to take.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  reviewSlaHours?: number;

  @ApiPropertyOptional({
    description:
      'Whether operators may create anyone-with-the-link report shares. This is a policy switch other modules consult before minting a share link — it is not a UI toggle.',
  })
  @IsOptional()
  @IsBoolean()
  allowPublicShare?: boolean;
}

export class GetSettingsQueryDto {
  @ApiPropertyOptional({ description: 'Read one exact version. Omit for the version in force.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}

// ── Report templates ────────────────────────────────────────────────

export class ReportTemplateSectionDto {
  @ApiProperty({ description: 'Stable key the renderer switches on.' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  key: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiProperty({ description: 'False keeps the section configured but out of the document.' })
  @IsBoolean()
  include: boolean;

  @ApiProperty({ description: 'Rendering order, lowest first.' })
  @Type(() => Number)
  @IsInt()
  order: number;
}

export class CreateReportTemplateDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType: string;

  @ApiPropertyOptional({ type: [ReportTemplateSectionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReportTemplateSectionDto)
  sections?: ReportTemplateSectionDto[];

  @ApiPropertyOptional({
    default: false,
    description: 'Make this the template in force for its report type. Setting it clears the previous default of the same type.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateReportTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: REPORT_TYPES })
  @IsOptional()
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType?: string;

  @ApiPropertyOptional({ type: [ReportTemplateSectionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReportTemplateSectionDto)
  sections?: ReportTemplateSectionDto[];
}

export class ResolveReportTemplateQueryDto {
  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType: string;
}

// ── Program templates ───────────────────────────────────────────────

export class ProgramTemplateItemDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @ApiPropertyOptional({ enum: ['fix', 'build', 'influence'] })
  @IsOptional()
  @IsIn(['fix', 'build', 'influence'])
  category?: string;

  @ApiPropertyOptional({ enum: ['technical', 'content', 'authority', 'research', 'reporting', 'access'] })
  @IsOptional()
  @IsIn(['technical', 'content', 'authority', 'research', 'reporting', 'access'])
  discipline?: string;

  @ApiPropertyOptional({ description: 'Role name, or a ClientMember/User id once applied.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  estimateHours?: number;

  @ApiPropertyOptional({ description: 'Days from the apply date. Only becomes a due date when the apply call supplies `startOn`.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offsetDays?: number;
}

export class CreateProgramTemplateDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: PROGRAM_TEMPLATE_KINDS })
  @IsIn(PROGRAM_TEMPLATE_KINDS as unknown as string[])
  kind: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ type: [ProgramTemplateItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ProgramTemplateItemDto)
  items?: ProgramTemplateItemDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateProgramTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: PROGRAM_TEMPLATE_KINDS })
  @IsOptional()
  @IsIn(PROGRAM_TEMPLATE_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ type: [ProgramTemplateItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ProgramTemplateItemDto)
  items?: ProgramTemplateItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ApplyProgramTemplateDto {
  @ApiProperty({ description: 'Project the rows are copied into.' })
  @IsString()
  @MinLength(1)
  projectId: string;

  @ApiPropertyOptional({
    description:
      'Required for a `cycle` template: the cycle the copied work items go into. A committed cycle also requires `scopeChangeReason` — the copy cannot silently change a frozen scope denominator.',
  })
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Required when `cycleId` is an already-committed cycle. Recorded in Cycle.scopeChanges.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  scopeChangeReason?: string;

  @ApiPropertyOptional({
    description:
      'Date the schedule is measured from, for `offsetDays`. When omitted, NO due dates are set — a template cannot invent a start date it was not given.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  startOn?: string;

  @ApiPropertyOptional({ default: false, description: 'Report what would be copied without writing anything.' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ description: 'Recorded in the audit trail alongside the copy.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class ListProgramTemplatesQueryDto {
  @ApiPropertyOptional({ enum: PROGRAM_TEMPLATE_KINDS })
  @IsOptional()
  @IsIn(PROGRAM_TEMPLATE_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'], description: 'Filter by the template’s active flag.' })
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: string;
}

export class ListReportTemplatesQueryDto {
  @ApiPropertyOptional({ enum: REPORT_TYPES })
  @IsOptional()
  @IsIn(REPORT_TYPES as unknown as string[])
  reportType?: string;
}
