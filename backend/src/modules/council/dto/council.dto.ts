/**
 * DTOs for the Council module (Agent #10, Swarm layer).
 *
 * @module council.dto
 */

import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, ArrayMaxSize, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AGENT_ROLES, COUNCIL_LIMITS } from '../council.types';

const ROLES = AGENT_ROLES as unknown as string[];

export class RunCouncilDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  question?: string;

  @IsOptional()
  @IsInt()
  @Min(COUNCIL_LIMITS.rounds.min)
  @Max(COUNCIL_LIMITS.rounds.max)
  rounds?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(ROLES, { each: true })
  agentRoles?: string[];

  @IsOptional()
  @IsBoolean()
  useLlm?: boolean;
}
