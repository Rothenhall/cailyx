/**
 * DTOs for the Content Requests module (client-portal.md §14, §22).
 *
 * @module content-requests.dto
 */

import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CONTENT_WORKSPACE_ASSET_TYPES } from '../../content-workspace/content-workspace.types';

export class CreateContentRequestDto {
  @IsIn(CONTENT_WORKSPACE_ASSET_TYPES as unknown as string[])
  contentType: string;

  /** Target keyword or topic, free text. */
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(300)
  topic: string;

  @IsIn(['low', 'normal', 'high'])
  @IsOptional()
  priority?: 'low' | 'normal' | 'high';

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  note?: string;
}
