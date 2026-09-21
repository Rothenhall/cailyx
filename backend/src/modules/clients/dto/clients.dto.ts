/**
 * DTOs for the Clients module.
 *
 * @module clients.dto
 */

import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateClientDto {
  @ApiProperty({ example: 'Rothenhall Test Co.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ description: 'User.id of the operator (delivery lead) who owns this client.' })
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    enum: ['starter', 'growth', 'scale', 'enterprise'],
    description: 'Defaults to "starter" when omitted.',
  })
  @IsOptional()
  @IsIn(['starter', 'growth', 'scale', 'enterprise'])
  planTier?: string;
}

export class UpdateClientDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({
    enum: ['active', 'paused', 'churned', 'suspended'],
    description:
      '"suspended" is accepted here for backward compatibility, but is not how suspension is meant to be triggered — use POST /clients/:clientId/suspend instead, which also revokes Google access (§5/§23) and writes an audit event.',
  })
  @IsOptional()
  @IsIn(['active', 'paused', 'churned', 'suspended'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({
    enum: ['starter', 'growth', 'scale', 'enterprise'],
    description:
      'Drives the refresh-cadence module\'s automatic measurement/scoring cadence (C7): starter=weekly, growth/scale=daily, enterprise=daily.',
  })
  @IsOptional()
  @IsIn(['starter', 'growth', 'scale', 'enterprise'])
  planTier?: string;
}

/** "Add client → run the pipeline" — the exact call the onboarding flow described. */
export class CreateClientProjectDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name: string;

  @ApiProperty({ description: 'Bare domain, e.g. "example.com" — matches Project.domain elsewhere.', example: 'example.com' })
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  domain: string;

  @ApiPropertyOptional({
    description: 'Opt-in: also run a full AEO (answer-engine) audit as part of the Day-1 pipeline. Costs real Cloro/LLM credits per run — off by default.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  runAeoAudit?: boolean;

  @ApiPropertyOptional({
    description: 'Opt-in: also pull keyword research (search volume/CPC/related terms) seeded from the enrichment category. Costs DataForSEO credits — off by default.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  runKeywordResearch?: boolean;

  @ApiPropertyOptional({
    description: 'Opt-in: also generate growth-execution asset briefs from the Strategy stage output. Off by default.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  runGrowthExecution?: boolean;

  @ApiPropertyOptional({
    description: 'Opt-in: also pull a fresh backlinks profile from DataForSEO. Costs DataForSEO credits — off by default.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  runBacklinksRefresh?: boolean;
}

export class CreateClientLoginDto {
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

/** C1 — §15's admin "waive Google-connect gate" action. */
export class WaiveOnboardingWizardDto {
  @ApiPropertyOptional({
    description: 'Free-text reason recorded on the audit event (e.g. "agency handoff pending, IT ticket open").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/** C5 (§5/§23/§30) — admin (or the payment-failure sweep) suspending a client. */
export class SuspendClientDto {
  @ApiPropertyOptional({
    description: 'Free-text reason recorded on the audit event (e.g. "non-payment, grace period elapsed" or "client requested pause").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/** C5 (§5/§23) — admin reactivating a suspended client. Does NOT restore Google access — the client reconnects from scratch. */
export class ReactivateClientDto {
  @ApiPropertyOptional({ description: 'Free-text reason recorded on the audit event.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

/**
 * C5 (§32) — reassign which seat/contact is this Client's primary contact.
 * Either name an existing client seat (`memberId`, whose User row's
 * name/email become the new primary contact) or supply raw
 * `contactName`/`contactEmail` directly — exactly one path, never both.
 */
export class TransferOwnershipDto {
  @ApiPropertyOptional({ description: "A ClientMember.id belonging to this client — that seat's user becomes the new primary contact." })
  @IsOptional()
  @IsString()
  memberId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ description: 'Free-text reason recorded on the audit event (e.g. "previous contact left the company").' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class PostClientMessageDto {
  @ApiPropertyOptional({
    description:
      "Scope the message to one of the client's projects. Must be a project owned by the :clientId in the path — a foreign project id is rejected with 403. Omit for a client-wide message.",
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}
