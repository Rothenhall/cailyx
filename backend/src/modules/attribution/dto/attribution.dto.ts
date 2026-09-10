/**
 * DTOs for self-report attribution.
 *
 * @module attribution.dto
 */

import { IsString, IsIn, IsOptional, MaxLength, IsEmail } from 'class-validator';
import { ATTRIBUTION_SOURCES } from '../attribution.types';

/**
 * The public capture body. Every field is length-capped because this endpoint
 * is unauthenticated — it is written to by a form on the client's own site.
 */
export class CaptureAttributionDto {
  @IsString()
  @IsIn(ATTRIBUTION_SOURCES as unknown as string[])
  source: string;

  @IsString()
  @IsOptional()
  @MaxLength(400)
  prompt?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  note?: string;

  @IsEmail()
  @IsOptional()
  @MaxLength(254)
  contactEmail?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  page?: string;
}
