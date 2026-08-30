/**
 * DTOs for the Intake module.
 *
 * @module intake.dto
 */

import { IsString, IsNotEmpty, IsOptional, IsIn, IsEmail, MaxLength } from 'class-validator';

export class PublicIntakeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  domain: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  company?: string;

  @IsString()
  @IsOptional()
  @MaxLength(120)
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  phone?: string;

  @IsString()
  @IsOptional()
  @MaxLength(300)
  description?: string;

  @IsIn(['public-form', 'operator-console', 'bulk-csv', 'api'])
  @IsOptional()
  source?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  notes?: string;
}

export class BulkIntakeItem {
  @IsString()
  @IsNotEmpty()
  domain: string;

  @IsString()
  @IsOptional()
  company?: string;
}

export class BulkIntakeRequest {
  @IsIn(['bulk-csv'])
  source: string;

  items: BulkIntakeItem[];
}
