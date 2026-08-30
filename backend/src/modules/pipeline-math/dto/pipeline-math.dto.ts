/**
 * DTOs for the Pipeline Math module (GTM Playbook qualification arithmetic).
 *
 * @module pipeline-math.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

export class SavePipelineMathDto {
  @ApiProperty({ description: 'Revenue the plan commits to (same currency as ACV)', example: 500000 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  revenueTarget: number;

  @ApiProperty({ description: 'Average contract value per deal', example: 25000 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  acv: number;

  @ApiProperty({ description: 'Win rate: fraction of SQLs that close', example: 0.2 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(1)
  winRate: number;

  @ApiProperty({ description: 'Fraction of booked meetings that become SQLs', example: 0.5 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(1)
  meetingToSql: number;

  @ApiProperty({ description: 'Fraction of leads that book a meeting', example: 0.1 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.001)
  @Max(1)
  leadToMeeting: number;

  @ApiProperty({ description: 'Fraction of visitors that become leads', example: 0.02 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0001)
  @Max(1)
  visitorToLead: number;

  @ApiPropertyOptional({ description: 'Addressable market in visitors for the plan period; verdict becomes fiction when required visitors exceed 1.5× this', example: 100000 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  marketSize?: number;
}