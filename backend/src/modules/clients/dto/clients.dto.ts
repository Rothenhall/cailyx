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

  @ApiPropertyOptional({ enum: ['active', 'paused', 'churned'] })
  @IsOptional()
  @IsIn(['active', 'paused', 'churned'])
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
