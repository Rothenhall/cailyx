/**
 * DTOs for the Projects module.
 *
 * @module projects.dto
 */

import { IsString, IsNotEmpty, IsOptional, IsIn, IsUrl, MaxLength } from 'class-validator';

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