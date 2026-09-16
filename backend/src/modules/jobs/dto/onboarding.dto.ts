/**
 * DTOs for the onboarding run — `/api/projects/:projectId/onboarding`.
 *
 * The onboarding run is a `JobRun` with `taskKind: 'onboarding'` whose steps
 * are the Day-1 pipeline stages, so "where did onboarding get to, and what
 * failed" is answered by the same durable ledger as every other run.
 *
 * @module dto/onboarding.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for creating the onboarding run for a project. */
export class CreateOnboardingRunDto {
  @ApiPropertyOptional({
    description:
      'De-duplication key. Defaults to `onboarding:<projectId>`, so the Day-1 pipeline is started once per project: a repeated POST returns the existing run instead of starting a second one. Pass an explicit key only to deliberately re-run onboarding after the previous run finished.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;

  @ApiPropertyOptional({ description: 'Run parameters (target URL override, skip flags) recorded on the run and reused by a retry.' })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}

/** Body for resuming a stalled onboarding run. */
export class ResumeOnboardingRunDto {
  @ApiPropertyOptional({
    description:
      'Re-attempt stages that already succeeded, instead of resuming from the first incomplete one. Off by default because re-running a stage re-spends on it.',
  })
  @IsOptional()
  @IsObject()
  force?: { restartSucceededStages?: boolean };
}
