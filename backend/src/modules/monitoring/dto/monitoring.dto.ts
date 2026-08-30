/**
 * DTOs for the Monitoring module (PRD 6.12).
 *
 * @module monitoring.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

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

  @ApiPropertyOptional({ description: 'Max rows (1-200, default 50)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}