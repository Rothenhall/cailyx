/**
 * DTOs for the Authority module (Agent #6, Swarm layer).
 *
 * @module authority.dto
 */

import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AUTHORITY_LIMITS } from '../authority.types';

export class RunScanDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsIn(['serp', 'llm', 'citations', 'combined'])
  method?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AUTHORITY_LIMITS.maxListicleQueries)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  listicleQueries?: string[];

  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}

export class UpdateCandidateDto {
  @IsIn(['new', 'promoted', 'dismissed'])
  status: string;
}
