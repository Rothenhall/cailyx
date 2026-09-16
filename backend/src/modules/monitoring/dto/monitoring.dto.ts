/**
 * DTOs for the Monitoring module (PRD 6.12) and its G07 alert triage surface.
 *
 * @module monitoring.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsIn, IsString, MaxLength, Min, Max, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ALERT_TRIAGE_STATUSES } from '../monitoring.types';

/** Query params for listing alerts. */
export class ListAlertsQueryDto {
  @ApiPropertyOptional({ description: 'Filter by alert kind', enum: ['score-drop', 'mention-drop', 'scheduled-run-failed'] })
  @IsOptional()
  @IsIn(['score-drop', 'mention-drop', 'scheduled-run-failed'])
  kind?: 'score-drop' | 'mention-drop' | 'scheduled-run-failed';

  @ApiPropertyOptional({ description: 'Filter by severity', enum: ['info', 'warning', 'critical'] })
  @IsOptional()
  @IsIn(['info', 'warning', 'critical'])
  severity?: 'info' | 'warning' | 'critical';

  @ApiPropertyOptional({
    enum: ALERT_TRIAGE_STATUSES,
    description:
      'Filter by triage state. An alert with no lifecycle row yet reads as `new`, so `?status=new` includes never-triaged alerts.',
  })
  @IsOptional()
  @IsIn(ALERT_TRIAGE_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ description: 'Max rows (1-200, default 50)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Body for assigning an alert to an operator. */
export class AssignAlertDto {
  @ApiProperty({ description: 'Operator user id. Client logins and disabled users are refused.' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  assigneeId: string;
}

/**
 * Body for resolving an alert.
 *
 * The resolution text is required: closing an alert with no statement of what
 * was decided leaves the next reader unable to tell a fix from a decision to
 * accept the regression.
 */
export class ResolveAlertDto {
  @ApiProperty({ description: 'What was decided or done. Required — "resolved" alone is not a record.' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  resolution: string;

  @ApiPropertyOptional({ description: 'WorkItem opened in response, if any. Must belong to this project.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  workItemId?: string;
}
