/**
 * DTOs for the Scoring module.
 *
 * @module scoring.dto
 */

import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

/** One band row: a total ceiling mapped to a band name. */
export class RubricBandDto {
  @IsInt()
  @Min(0)
  @Max(100)
  max: number;

  @IsString()
  @MinLength(2)
  band: string;
}

export class CreateRubricDto {
  @IsInt()
  @Min(1)
  @IsOptional()
  version?: number;

  /**
   * Partial weights over the five §8 dimensions (unspecified keys keep PRD
   * defaults). Final weights must sum to 100 — enforced in the service.
   */
  @IsObject()
  @IsOptional()
  weights?: Record<string, number>;

  /** Band table, checked ascending in the service. Defaults to PRD §8 bands. */
  @IsOptional()
  @Type(() => RubricBandDto)
  bands?: RubricBandDto[];

  @IsBoolean()
  @IsOptional()
  activate?: boolean;

  @IsString()
  @IsOptional()
  @MinLength(3)
  note?: string;
}