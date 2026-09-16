/**
 * Query DTOs for the comparable-results read —
 * `GET /api/projects/:projectId/results`.
 *
 * @module dto/results.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Every field is optional and every field is a *narrowing*: with none of them
 * the service serves a documented rolling window and says in the response that
 * the window is not reproducible. Naming `periodId` is the strong form — it
 * replaces the bounds entirely with a stored one.
 *
 * `from`/`to` are validated as ISO 8601 by class-validator and additionally
 * accepted as bare `YYYY-MM-DD` dates, which the service resolves against
 * `timezone`. `@IsISO8601` alone would reject the bare form, so the check is
 * relaxed to `@IsString` plus a length cap and the service does the real
 * parsing — it has to parse them anyway to resolve them against a timezone.
 */
export class ResultsQueryDto {
  @ApiPropertyOptional({
    description:
      'Stored ReportPeriod id. When present it replaces from/to entirely: the period\'s own startsOn/endsOn/timezone are used, so an old report reproduces exactly.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  periodId?: string;

  @ApiPropertyOptional({ description: 'Window start — `YYYY-MM-DD` (resolved against `timezone`) or a full ISO 8601 timestamp.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @ApiPropertyOptional({ description: 'Window end, inclusive — `YYYY-MM-DD` (resolved against `timezone`) or a full ISO 8601 timestamp.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  @ApiPropertyOptional({
    description:
      'The period to compare against. A ReportPeriod id; the service also accepts a MeasurementCohort id, in which case that cohort\'s baseline is used. Omit for no comparison (the response says so rather than inventing a baseline).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baselineId?: string;

  @ApiPropertyOptional({ description: 'MeasurementCohort id to resolve the window\'s methodology key from. Defaults to the period\'s own cohort, then the project\'s most recent cohort (reported as `cohortSource`).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cohortId?: string;

  @ApiPropertyOptional({ description: 'IANA timezone the window bounds are resolved in. Defaults to the project\'s own timezone.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

/**
 * Query DTO for listing evidence manifests. `subjectType`/`subjectId` narrow to
 * one subject so a report page can find the manifest it pinned.
 */
export class ListManifestsQueryDto {
  @ApiPropertyOptional({ description: 'report | result-set' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  subjectType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  subjectId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  periodId?: string;

  @ApiPropertyOptional({ description: 'Max rows (1-100, default 25).' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  limit?: string;
}

/** Body for building and pinning an evidence manifest. */
export class CreateManifestDto {
  @ApiPropertyOptional({ enum: ['report', 'result-set'], default: 'result-set', description: 'What this manifest is evidence for. `report` is what a frozen report revision pins.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  subjectType?: string;

  @ApiPropertyOptional({ description: 'The report/revision id this manifest belongs to. Required when `subjectType` is `report`, because a manifest that names no subject cannot be checked against one.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  subjectId?: string;

  @ApiPropertyOptional({ description: 'Stored ReportPeriod id. Supplies the exact window; without it the request bounds are used and the manifest is marked as built from a moving window.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  periodId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cohortId?: string;

  @ApiPropertyOptional({ description: 'Window start, used only when `periodId` is absent.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  from?: string;

  @ApiPropertyOptional({ description: 'Window end (inclusive), used only when `periodId` is absent.' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  to?: string;

  /**
   * No `rubricVersion` field: the rubric version is read off the pinned
   * ScoreRun. Accepting one from the request would let a caller label a score
   * with a rubric it was not computed under — the version is evidence, not
   * input.
   */
  @ApiPropertyOptional({ description: 'Pin the ScoreRun used, rather than resolving the latest in-window run. An explicit pin is what makes a score reproducible.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scoreRunId?: string;
}
