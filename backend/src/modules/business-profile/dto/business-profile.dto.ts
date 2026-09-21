/**
 * DTOs for the versioned business profile — `/api/projects/:projectId/business-profile`
 * (operator) and `/api/portal/projects/:projectId/business-profile` (client).
 *
 * Every property is optional on `SaveBusinessProfileDto` because the write is
 * a merge onto the current draft, not a replacement: a client filling in
 * "markets" from the welcome checklist must not silently blank the services an
 * operator entered on the call. Omitted means "leave as it is"; to clear a
 * scalar, send `null` on the field where the type allows it.
 *
 * @module dto/business-profile.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { BUSINESS_INFO_FIELDS, REBUILD_TARGETS } from '../business-profile.types';

export class IcpDto {
  @ApiPropertyOptional({ type: [String], description: 'Who the business sells to.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  segments?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Buying roles/titles.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @ApiPropertyOptional({ type: [String], description: 'Problems the buyer arrives with.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  painPoints?: string[];
}

export class FactDto {
  @ApiProperty({ description: 'A statement the client stands behind.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  fact: string;

  @ApiPropertyOptional({ description: 'Where the claim can be verified. Omit when the client asserted it uncovered.' })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2000)
  evidenceUrl?: string;
}

export class CompetitorDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ description: 'Bare host or URL. Normalized on write.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  domain?: string;
}

export class ApproverDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  role?: string;
}

/**
 * One structured target market (P04, plan §10.1). `country` is the only
 * required field — it is the one unit every provider adapter read for this
 * phase can genuinely target (see `market-provider-support.ts`).
 */
export class MarketTargetDto {
  @ApiProperty({ description: 'ISO-3166 alpha-2 country code, e.g. "US".' })
  @IsString()
  @MinLength(2)
  @MaxLength(2)
  country: string;

  @ApiPropertyOptional({ description: 'State/province, free text.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  region?: string;

  @ApiPropertyOptional({ description: 'City. Narrower than most provider adapters can prove they targeted — see the provider-support preview.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  city?: string;

  @ApiPropertyOptional({ description: 'BCP-47 language tag for this target, when it differs from the profile-wide languages.' })
  @IsOptional()
  @IsString()
  @MaxLength(35)
  language?: string;

  @ApiPropertyOptional({ default: 0, description: 'Lower = higher priority.' })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ default: true, description: 'False keeps the target on file but excludes it from measurement scope and cost estimates.' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Which services/products this target applies to. Empty = all of them.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productApplicability?: string[];
}

export class PublishingDto {
  @ApiPropertyOptional({ description: 'e.g. "WordPress", "HubSpot", "Webflow".' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cms?: string;

  @ApiPropertyOptional({ description: 'What the CMS/legal review will not allow.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  constraints?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  styleNotes?: string;
}

/**
 * A merge onto the current draft. All fields optional — see the module note.
 */
export class SaveBusinessProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  brandName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({
    description:
      'Business category / type ("SaaS", "local plumbing services", etc). C2 (`docs/analysis/client-portal.md` §12). Distinct from Project.category.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  category?: string;

  @ApiPropertyOptional({ type: [String], description: 'Services offered.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  services?: string[];

  @ApiPropertyOptional({ type: IcpDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => IcpDto)
  icp?: IcpDto;

  @ApiPropertyOptional({ type: [String], description: 'Geographic markets, ISO-3166 alpha-2 or names as the client says them.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  markets?: string[];

  @ApiPropertyOptional({ type: [String], description: 'BCP-47 language tags.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  @ApiPropertyOptional({
    type: [MarketTargetDto],
    description:
      'Structured target markets (P04, plan §10.1) — replaces the whole array on write, same merge semantics as every other field here: omitted leaves it as it is.',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarketTargetDto)
  targets?: MarketTargetDto[];

  @ApiPropertyOptional({ type: [FactDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FactDto)
  facts?: FactDto[];

  @ApiPropertyOptional({ type: [CompetitorDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompetitorDto)
  competitors?: CompetitorDto[];

  @ApiPropertyOptional({ type: [String], description: 'Commercial goals in the client’s own words.' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  goals?: string[];

  @ApiPropertyOptional({ type: [ApproverDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApproverDto)
  approvers?: ApproverDto[];

  @ApiPropertyOptional({ type: PublishingDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PublishingDto)
  publishing?: PublishingDto;

  @ApiPropertyOptional({
    description:
      'Optional note on this draft, recorded in the audit trail. It is not stored on the profile row — the row holds facts, not commentary.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Read one specific version, or the newest confirmed one. */
export class GetBusinessProfileQueryDto {
  @ApiPropertyOptional({ description: 'Exact version to return. Omit for the latest version of any state.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({
    enum: ['latest', 'confirmed'],
    default: 'latest',
    description:
      '`latest` returns the newest version whatever its state; `confirmed` returns the newest version a human stood behind, and 404s when nothing has ever been confirmed. Use `confirmed` for anything that must not cite a draft.',
  })
  @IsOptional()
  @IsIn(['latest', 'confirmed'])
  state?: 'latest' | 'confirmed';
}

/** Confirm a draft: this writes a NEW version row carrying confirmedBy/confirmedAt. */
export class ConfirmBusinessProfileDto {
  @ApiPropertyOptional({
    description:
      'The draft version being confirmed. Defaults to the newest draft. Must name a version that is NOT already confirmed — confirming a confirmed row would mutate history.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({ description: 'Recorded in the audit trail alongside the confirmation.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/**
 * "Keep current" on one field's suggestion — plan §9.2's rejection memory.
 *
 * The value being rejected is NOT taken from the request body: the server
 * reads the field's current suggestion (the newest `SiteContext`'s value for
 * `field`) itself and records a rejection of exactly that, so a caller cannot
 * fabricate a rejection of a value nothing ever suggested.
 */
export class RejectBusinessProfileSuggestionDto {
  @ApiProperty({ enum: BUSINESS_INFO_FIELDS, description: 'Which field suggestion to decline.' })
  @IsIn(BUSINESS_INFO_FIELDS as unknown as string[])
  field: string;
}

/** Explicit propagation of confirmed facts to the artifacts they directly feed. */
export class RebuildFromProfileDto {
  @ApiPropertyOptional({
    description:
      'The profile version to propagate. Defaults to the newest CONFIRMED version — a draft is never a source, so with no confirmed version and no explicit `version` this is refused.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;

  @ApiProperty({
    enum: REBUILD_TARGETS,
    isArray: true,
    description:
      'Exactly what to propagate. Required and non-empty: nothing moves unless the caller names it, which is the whole point of an explicit rebuild.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(REBUILD_TARGETS as unknown as string[], { each: true })
  targets: string[];

  @ApiProperty({ description: 'Why the rebuild is being run. Stored in the audit trail and echoed back.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Report what would change without writing anything.',
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
