/**
 * DTOs for the Prompt Requests module (client-portal.md §13, §20).
 *
 * @module prompt-requests.dto
 */

import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePromptRequestDto {
  @IsIn(['add', 'remove'])
  action: 'add' | 'remove';

  /** Required for action=add. */
  @IsString()
  @IsOptional()
  @MinLength(5)
  @MaxLength(500)
  prompt?: string;

  /** Optional persona hint for action=add (one of PromptPersona). */
  @IsIn(['problem-aware', 'solution-aware', 'product-aware', 'most-aware'])
  @IsOptional()
  persona?: string;

  /** Required for action=remove — the QuerySetItem.id being flagged. */
  @IsString()
  @IsOptional()
  targetItemId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  note?: string;
}

export class DecidePromptRequestDto {
  @IsIn(['approved', 'declined'])
  decision: 'approved' | 'declined';

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  decisionNote?: string;

  /** The QuerySetItem.id produced by the admin's add action, if applicable. */
  @IsString()
  @IsOptional()
  resultQuerySetItemId?: string;
}
