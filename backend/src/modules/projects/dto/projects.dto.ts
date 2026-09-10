/**
 * DTOs for the Projects module.
 *
 * @module projects.dto
 */

import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsUrl,
  MaxLength,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  domain: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  category?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  clientName?: string;

  @IsIn(['scorecard', 'diagnostic', 'sprint', 'retainer', 'archived'])
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateProjectDto {
  @IsString()
  @IsOptional()
  @MaxLength(120)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  category?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  clientName?: string;

  @IsIn(['scorecard', 'diagnostic', 'sprint', 'retainer', 'archived'])
  @IsOptional()
  status?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

/** One named competitor on the project's benchmark list. */
export class CompetitorDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsOptional()
  @MaxLength(253)
  domain?: string;

  /** where it came from: manual | intake | serp */
  @IsString()
  @IsOptional()
  @MaxLength(24)
  source?: string;
}

/** Replace the whole competitor list. */
export class SetCompetitorsDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CompetitorDto)
  competitors: CompetitorDto[];
}
