/**
 * DTOs for the Persona module (Agent #1, Swarm layer).
 *
 * @module persona.dto
 */

import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ArrayMaxSize,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { PERSONA_AWARENESS, PERSONA_COMPANY_STAGE, PERSONA_ROLES, PERSONA_SENIORITY } from '../persona.types';

const ROLES = PERSONA_ROLES as unknown as string[];
const SENIORITY = PERSONA_SENIORITY as unknown as string[];
const STAGE = PERSONA_COMPANY_STAGE as unknown as string[];
const AWARENESS = PERSONA_AWARENESS as unknown as string[];

/** Bounded string[] — every free-text list on a persona shares these limits. */
const MAX_LIST = 20;
const MAX_ITEM = 240;

export class GeneratePersonasDto {
  /** Number of personas to create this call. Server clamps to the remaining project budget. */
  @IsInt()
  @Min(1)
  @Max(100)
  count: number;

  /** Restrict generation to these roles (round-robin). Omit for the full catalogue. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(ROLES, { each: true })
  roles?: string[];

  /** Refine each deterministic draft with an LLM pass. Requires ANTHROPIC_API_KEY. */
  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}

export class CreatePersonaDto {
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  label: string;

  @IsIn(ROLES)
  role: string;

  @IsOptional()
  @IsIn(SENIORITY)
  seniority?: string;

  @IsOptional()
  @IsIn(STAGE)
  companyStage?: string;

  @IsOptional()
  @IsIn(AWARENESS)
  awareness?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(400)
  primaryGoal: string;

  @IsString()
  @MinLength(5)
  @MaxLength(400)
  researchObjective: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  painPoints?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  buyingTriggers?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  objections?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  vocabulary?: string[];
}

export class UpdatePersonaDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  label?: string;

  @IsOptional()
  @IsIn(SENIORITY)
  seniority?: string;

  @IsOptional()
  @IsIn(STAGE)
  companyStage?: string;

  @IsOptional()
  @IsIn(AWARENESS)
  awareness?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(400)
  primaryGoal?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(400)
  researchObjective?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  painPoints?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  buyingTriggers?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  objections?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LIST)
  @IsString({ each: true })
  @MaxLength(MAX_ITEM, { each: true })
  vocabulary?: string[];
}
