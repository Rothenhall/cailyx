/**
 * DTOs for the Journey module (Agent #2, Swarm layer).
 *
 * @module journey.dto
 */

import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ArrayMaxSize,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { JOURNEY_LIMITS, JOURNEY_SURFACES } from '../journey.types';
import { PERSONA_ROLES } from '../../persona/persona.types';

const SURFACES = JOURNEY_SURFACES as unknown as string[];
const ROLES = PERSONA_ROLES as unknown as string[];
const D = JOURNEY_LIMITS;

export class PlanJourneyDto {
  @IsString()
  @MinLength(3)
  personaId: string;

  @IsOptional()
  @IsIn(SURFACES)
  surface?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  geo?: string;

  @IsOptional()
  @IsInt()
  @Min(D.maxDepth.min)
  @Max(D.maxDepth.max)
  maxDepth?: number;

  @IsOptional()
  @IsInt()
  @Min(D.maxBranches.min)
  @Max(D.maxBranches.max)
  maxBranches?: number;

  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}

export class CreateCampaignDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsIn(SURFACES)
  surface?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  geo?: string;

  @IsInt()
  @Min(D.journeyTarget.min)
  @Max(D.journeyTarget.max)
  journeyTarget: number;

  @IsOptional()
  @IsInt()
  @Min(D.maxDepth.min)
  @Max(D.maxDepth.max)
  maxDepth?: number;

  @IsOptional()
  @IsInt()
  @Min(D.maxBranches.min)
  @Max(D.maxBranches.max)
  maxBranches?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(ROLES, { each: true })
  personaRoles?: string[];

  @IsNumber()
  @Min(D.budgetUsd.min)
  @Max(D.budgetUsd.max)
  budgetUsd: number;

  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;

  @IsOptional()
  @IsBoolean()
  autoRun?: boolean;
}
