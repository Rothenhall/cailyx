/**
 * DTOs for the Approvals module (G10).
 *
 * @module approvals.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsString, IsNotEmpty, IsOptional, IsIn, IsInt, Min, IsISO8601 } from 'class-validator';
import type { ApprovalArtifactType, ApprovalReviewerType } from '../approvals.types';

const ARTIFACT_TYPES: ApprovalArtifactType[] = ['report', 'content', 'plan', 'cycle', 'claim'];
const REVIEWER_TYPES: ApprovalReviewerType[] = ['operator', 'client'];

export class CreateApprovalRequestDto {
  @ApiProperty({ enum: ARTIFACT_TYPES })
  @IsIn(ARTIFACT_TYPES)
  artifactType: ApprovalArtifactType;

  @ApiProperty({ description: 'ID of the row under review (e.g. Report.id).' })
  @IsString()
  @IsNotEmpty()
  artifactId: string;

  @ApiProperty({ description: 'The exact revision number this request binds to. A later revision invalidates it.' })
  // Query strings arrive as strings; without this every request
  // carrying the field fails @IsInt validation.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  artifactRevision: number;

  @ApiPropertyOptional({ description: 'The specific revision row id, when the artifact tracks one (e.g. ReportRevision.id).' })
  @IsOptional()
  @IsString()
  revisionId?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  detail?: string;

  @ApiPropertyOptional({ enum: REVIEWER_TYPES, default: 'client' })
  @IsOptional()
  @IsIn(REVIEWER_TYPES)
  reviewerType?: ApprovalReviewerType;

  @ApiPropertyOptional({ description: 'Restrict the decision to one specific user id.' })
  @IsOptional()
  @IsString()
  requiredReviewerId?: string;

  @ApiPropertyOptional({ description: 'Client this request is scoped to. Required when reviewerType is "client"; validated against the project.' })
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}

export class DecideApprovalDto {
  @ApiProperty({ enum: ['approved', 'changes-requested'] })
  @IsIn(['approved', 'changes-requested'])
  decision: 'approved' | 'changes-requested';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiProperty({
    description:
      'The exact artifactRevision the decider is confirming they reviewed. Must match the request\'s current artifactRevision — proves the decision was made against the live version, not a stale cached screen, and is rejected otherwise.',
  })
  // Query strings arrive as strings; without this every request
  // carrying the field fails @IsInt validation.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  revision: number;
}

export class CancelApprovalDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

export class ListApprovalsQueryDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'changes-requested', 'cancelled', 'invalidated'] })
  @IsOptional()
  @IsIn(['pending', 'approved', 'changes-requested', 'cancelled', 'invalidated'])
  status?: string;

  @ApiPropertyOptional({ enum: ARTIFACT_TYPES })
  @IsOptional()
  @IsIn(ARTIFACT_TYPES)
  artifactType?: ApprovalArtifactType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  artifactId?: string;
}
