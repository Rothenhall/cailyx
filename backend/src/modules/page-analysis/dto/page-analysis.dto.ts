/**
 * DTOs for the Page Analysis module (SOP-6).
 *
 * @module page-analysis.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

/** Body for POST /page-analysis/analyze. */
export class AnalyzePageDto {
  @ApiProperty({ description: 'Absolute http(s) URL of the page to analyze (protocol validated in the service)', example: 'https://example.com/guides/ai-visibility' })
  @IsString()
  @MinLength(9)
  @MaxLength(2000)
  @Matches(/^https?:\/\//i, { message: 'url must start with http(s)://' })
  url: string;

  @ApiPropertyOptional({ description: 'Add a Claude refinement pass (stored as llmNotes, never scored). 503 without ANTHROPIC_API_KEY.', default: false })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  useLlm?: boolean;
}