import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsObject, IsOptional, IsString } from 'class-validator';

const FORMALITY_VALUES = ['casual', 'conversational', 'neutral', 'formal'] as const;

export class SaveWritingStyleDraftDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() summary?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() tone?: string;
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() preferredWords?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() avoidWords?: string[];
  @ApiPropertyOptional({ type: [String] }) @IsOptional() @IsArray() exampleSentences?: string[];
  @ApiPropertyOptional() @IsOptional() @IsString() ctaPreferences?: string;
  @ApiPropertyOptional({ enum: FORMALITY_VALUES }) @IsOptional() @IsIn(FORMALITY_VALUES) formality?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() audience?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() channelDifferences?: Record<string, { tone?: string; notes?: string }>;
  /** Set when this draft starts from an accepted PresenceBrandVoice suggestion. */
  @ApiPropertyOptional() @IsOptional() @IsString() suggestionSourceId?: string;
}

export class ConfirmWritingStyleDto {
  /** Confirm this exact draft version; omitted = confirm the latest unconfirmed draft. */
  @ApiPropertyOptional() @IsOptional() version?: number;
}
