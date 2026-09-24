/**
 * DTOs for WorkItem CRUD and the submit/verify/block actions —
 * `/api/projects/:projectId/work-items`.
 *
 * @module dto/work-item.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PROGRESS_TARGET_KINDS } from '../../progress/progress.types';
import {
  ACCEPTANCE_CHECK_STATUSES,
  VERIFICATION_DECISIONS,
  WORK_CATEGORIES,
  WORK_DISCIPLINES,
  WORK_ITEM_STATUSES,
  WORK_PRIORITIES,
} from '../delivery-plan.types';

const TARGETS_DESCRIPTION =
  'What this work is aimed at moving in the AEO audit. A result change is credited to the work as "targeted" on the ' +
  'progress page only when it names that exact slice: a question type (dimension key), an engine (surface key), a ' +
  'competitor name, or a market (ISO code).';

export class WorkItemTargetDto {
  @ApiProperty({ enum: PROGRESS_TARGET_KINDS })
  @IsIn(PROGRESS_TARGET_KINDS as unknown as string[])
  kind: (typeof PROGRESS_TARGET_KINDS)[number];

  @ApiProperty({ description: 'Dimension key, surface key, competitor name, or ISO market code.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  value: string;
}

export class CreateWorkItemDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @ApiPropertyOptional({ enum: WORK_CATEGORIES, default: 'fix' })
  @IsOptional()
  @IsIn(WORK_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({ enum: WORK_DISCIPLINES, default: 'technical' })
  @IsOptional()
  @IsIn(WORK_DISCIPLINES as unknown as string[])
  discipline?: string;

  @ApiPropertyOptional({ enum: WORK_PRIORITIES, default: 'medium' })
  @IsOptional()
  @IsIn(WORK_PRIORITIES as unknown as string[])
  priority?: string;

  @ApiPropertyOptional({ description: 'Attach directly to a cycle. If that cycle is already committed, `scopeChangeReason` is required.' })
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiPropertyOptional({ description: 'Required when `cycleId` targets an already-committed cycle — recorded in Cycle.scopeChanges.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  scopeChangeReason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewerId?: string;

  @ApiPropertyOptional({ description: 'Bare date (YYYY-MM-DD, resolved end-of-day in the engagement/project timezone) or a full ISO timestamp.' })
  @IsOptional()
  @IsString()
  dueOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimateHours?: number;

  @ApiPropertyOptional({ description: 'Provenance — e.g. a Gap.id, Finding.id or Alert.id.' })
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceId?: string;

  @ApiPropertyOptional({ type: [String], description: 'WorkItem ids that must finish before this one. Rejected with 409 if it would create a dependency cycle.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  dependsOn?: string[];

  @ApiPropertyOptional({ default: false, description: 'Visible in the client portal. Server-controlled — not inferred from any UI state.' })
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;

  @ApiPropertyOptional({ description: 'Never returned on a client-scoped route.' })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  internalNotes?: string;

  @ApiPropertyOptional({ type: [String], description: 'Initial acceptance checklist item descriptions.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  acceptanceChecklist?: string[];

  @ApiPropertyOptional({ type: () => [WorkItemTargetDto], description: TARGETS_DESCRIPTION })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WorkItemTargetDto)
  targets?: WorkItemTargetDto[];
}

export class UpdateWorkItemDto {
  @ApiPropertyOptional({ type: () => [WorkItemTargetDto], description: `${TARGETS_DESCRIPTION} Send [] to clear.` })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WorkItemTargetDto)
  targets?: WorkItemTargetDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @ApiPropertyOptional({ enum: WORK_CATEGORIES })
  @IsOptional()
  @IsIn(WORK_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({ enum: WORK_DISCIPLINES })
  @IsOptional()
  @IsIn(WORK_DISCIPLINES as unknown as string[])
  discipline?: string;

  @ApiPropertyOptional({ enum: WORK_PRIORITIES })
  @IsOptional()
  @IsIn(WORK_PRIORITIES as unknown as string[])
  priority?: string;

  @ApiPropertyOptional({ description: 'Moving into/out of an already-committed cycle requires `scopeChangeReason`.' })
  @IsOptional()
  @IsString()
  cycleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  scopeChangeReason?: string;

  @ApiPropertyOptional({ enum: WORK_ITEM_STATUSES, description: 'Direct transitions only — backlog/committed/active/cancelled. Use /submit, /verify, /block, /unblock for the rest.' })
  @IsOptional()
  @IsIn(WORK_ITEM_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reviewerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  dueOn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  estimateHours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  actualHours?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  dependsOn?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  clientVisible?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  internalNotes?: string;
}

export class SubmitWorkItemDto {
  @ApiPropertyOptional({ description: 'What was delivered — the exact deliverable, per design_plan §5.7.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @ApiPropertyOptional({ description: 'Live URL where the change is visible, if applicable.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  sourceUrl?: string;
}

export class VerifyWorkItemDto {
  @ApiProperty({ enum: VERIFICATION_DECISIONS })
  @IsIn(VERIFICATION_DECISIONS as unknown as string[])
  decision: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  sourceUrl?: string;

  @ApiPropertyOptional({ description: 'The audit/measurement run that observed the change.' })
  @IsOptional()
  @IsString()
  runId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  runType?: string;

  @ApiPropertyOptional({ description: 'Exactly what was checked.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  artifact?: string;

  @ApiPropertyOptional({ description: 'When the evidence was observed. Defaults to now.' })
  @IsOptional()
  @IsString()
  observedAt?: string;

  @ApiPropertyOptional({ description: 'Required on rejection — what reopened the work.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class BlockWorkItemDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  blockedReason: string;

  @ApiPropertyOptional({ description: 'Who the client (or a third party) must respond for this to move.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  blockedOn?: string;
}

export class AddAcceptanceCheckDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description: string;
}

export class SetAcceptanceCheckDto {
  @ApiProperty({ enum: ACCEPTANCE_CHECK_STATUSES })
  @IsIn(ACCEPTANCE_CHECK_STATUSES as unknown as string[])
  status: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** Client-portal evidence submission — the assignee (when they are the
 * client-side implementation owner, §7.2) records what they did. Persisted
 * as a timestamped entry appended to the work item's evidence log; a
 * WorkItem has no dedicated evidence table in this schema, so it does not
 * fabricate a Verification (which records the *reviewer's* observation,
 * not the submitter's claim). Moves active -> review, same as /submit.
 */
export class PortalEvidenceDto {
  @ApiProperty({ description: 'What was done, on the client\'s side.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  note: string;

  @ApiPropertyOptional({ description: 'Live URL supporting the evidence, if applicable.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  sourceUrl?: string;
}
