/**
 * DTOs for the Claims module (FR-9.4).
 *
 * @module claims.dto
 */

import { IsBoolean, IsIn, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class CheckCopyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  copy: string;

  /** Set true for copy that legitimately states rates with n>=5 provenance. */
  @IsOptional()
  @IsBoolean()
  allowRates?: boolean;
}

export class CreateClaimDto {
  @IsString()
  @MinLength(5)
  @MaxLength(2000)
  statement: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  sourceUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceName?: string;

  @IsOptional()
  @IsIn(['a', 'b', 'c', 'A', 'B', 'C'])
  grade?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  gradeReason?: string;
}

export class AttachSourceDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  url?: string;
}