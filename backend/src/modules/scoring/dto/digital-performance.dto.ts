/**
 * DTOs for the Cailyx digital-performance score family (plan §5.2–§5.5, P14).
 *
 * @module digital-performance.dto
 */

import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One band row — only used when a methodology version defines bands. */
export class MethodologyBandDto {
  @IsInt()
  @Min(0)
  @Max(100)
  max: number;

  @IsString()
  @MinLength(2)
  band: string;
}

/**
 * One bucket's configuration. Thresholds and scope are free-form on purpose:
 * they are the part of the rubric that must stay configurable per metric version
 * (§5.4), and a shape-locked DTO would push every threshold change into a code
 * change. The service validates the parts that must hold (known key, non-negative
 * weight, positive max age, declared metric version).
 */
export class MethodologyBucketDto {
  @IsString()
  @MinLength(3)
  key: string;

  @IsString()
  @MinLength(2)
  label: string;

  @IsInt()
  @Min(0)
  @Max(100)
  weight: number;

  @IsString()
  @MinLength(3)
  metricVersion: string;

  @IsInt()
  @Min(1)
  maxAgeDays: number;

  @IsInt()
  @Min(0)
  minSample: number;

  @IsString()
  @IsOptional()
  detailPath?: string;

  @IsString()
  @IsOptional()
  detailQuery?: string;

  @IsObject()
  @IsOptional()
  scope?: Record<string, unknown>;

  @IsObject()
  @IsOptional()
  thresholds?: Record<string, unknown>;
}

export class MethodologyConfigDto {
  @IsString()
  @IsOptional()
  rounding?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MethodologyBucketDto)
  buckets: MethodologyBucketDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MethodologyBandDto)
  bands?: MethodologyBandDto[];
}

export class CreateMethodologyDto {
  @IsString()
  @IsOptional()
  family?: string;

  @IsInt()
  @Min(1)
  @IsOptional()
  version?: number;

  @IsString()
  @IsOptional()
  label?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MethodologyConfigDto)
  config?: MethodologyConfigDto;

  @IsBoolean()
  @IsOptional()
  activate?: boolean;

  @IsString()
  @IsOptional()
  note?: string;
}

/** An applicability decision. `reason` is optional in the DTO because an
 * `applicable` decision that just clears an earlier exclusion still needs one;
 * the service enforces the real rule (a `not-applicable` decision without a
 * reason is a 400) so the error message can explain why.
 */
export class SetApplicabilityDto {
  @IsString()
  @MinLength(3)
  bucketKey: string;

  @IsBoolean()
  applicable: boolean;

  @IsString()
  @IsOptional()
  reason?: string;
}
