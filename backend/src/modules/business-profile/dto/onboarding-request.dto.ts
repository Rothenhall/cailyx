/**
 * DTOs for onboarding/access requests and the checklist —
 * `/api/projects/:projectId/onboarding/*` (operator) and
 * `/api/portal/projects/:projectId/onboarding/*` (client).
 *
 * `blockedWork` is the field that makes a request actionable rather than
 * nagging: it names the work items this ask is holding up, and the service
 * validates every id belongs to the same project before storing it.
 *
 * @module dto/onboarding-request.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ONBOARDING_REQUEST_KINDS, ONBOARDING_REQUEST_STATUSES } from '../business-profile.types';

export class CreateOnboardingRequestDto {
  @ApiProperty({ enum: ONBOARDING_REQUEST_KINDS })
  @IsIn(ONBOARDING_REQUEST_KINDS as unknown as string[])
  kind: string;

  @ApiProperty({ description: 'What is being asked for, in one line.' })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @ApiPropertyOptional({ description: 'How to do it / what exactly is needed, so the client is not guessing.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  @ApiPropertyOptional({ description: 'Person or role the ask is directed at — free text or a ClientMember userId.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestedOf?: string;

  @ApiPropertyOptional({ description: 'Due date. A bare date is accepted.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  dueAt?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'WorkItem ids this request is blocking. Every id must belong to this project; a foreign or unknown id is rejected with 404 rather than stored.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  blockedWork?: string[];
}

export class UpdateOnboardingRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestedOf?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @ApiPropertyOptional({ enum: ONBOARDING_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(ONBOARDING_REQUEST_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Replaces the blocked-work list. Omit to leave it unchanged — an empty array clears it.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  blockedWork?: string[];

  @ApiPropertyOptional({ description: 'Recorded in the audit trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/**
 * The client's own action on a request directed at them.
 *
 * Deliberately narrower than the operator's: a client can say "I've done this"
 * or "I've started it", and can undo either. They cannot waive an ask (that is
 * the operator choosing not to need it), rename it, or re-point it.
 */
export class PortalUpdateOnboardingRequestDto {
  @ApiProperty({ enum: ['in-progress', 'done', 'open'] })
  @IsIn(['in-progress', 'done', 'open'])
  status: string;

  @ApiPropertyOptional({
    description:
      'Free-text note recorded in the audit trail — e.g. which account was granted. Not stored on the request row.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class ListOnboardingRequestsQueryDto {
  @ApiPropertyOptional({ enum: ONBOARDING_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(ONBOARDING_REQUEST_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: ONBOARDING_REQUEST_KINDS })
  @IsOptional()
  @IsIn(ONBOARDING_REQUEST_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional({ default: false, description: 'Return only requests still outstanding (open or in-progress).' })
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'])
  outstanding?: string;
}
