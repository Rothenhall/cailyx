/**
 * DTOs for attaching a project to a client and correcting its domain —
 * `/api/clients/:clientId/projects/:projectId/attach` and `.../domain`.
 *
 * `clientId` is never a body field on any of these: it comes from the URL
 * (checked by the caller) or from the JWT. A body-supplied `clientName` is a
 * display label and is documented as such on the field itself, because the
 * legacy `Project.clientName` column is exactly the thing that must never be
 * mistaken for ownership.
 *
 * @module dto/attach.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AttachProjectDto {
  @ApiPropertyOptional({
    description:
      'Optional optimistic guard: the clientId the caller believes the project currently has. Pass `null` explicitly to assert "currently unattached". Mismatch is a 409, so a stale wizard screen cannot silently detach somebody else’s project.',
  })
  @IsOptional()
  @IsString()
  expectedCurrentClientId?: string | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'Required `true` when the project currently belongs to a DIFFERENT client. Moving a project between clients is an explicit act, never a side effect of a routine attach call.',
  })
  @IsOptional()
  @IsBoolean()
  reassign?: boolean;

  @ApiPropertyOptional({
    description:
      'Display label written to the legacy `Project.clientName` column. This is a LABEL ONLY — it establishes no ownership and is never resolved into a client. Omit to leave the column as it is; the owning client’s name is what the UI should show.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientName?: string;

  @ApiPropertyOptional({ description: 'Recorded in the audit trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CorrectDomainDto {
  @ApiProperty({
    description:
      'The corrected domain. Normalized before comparison and storage: scheme, `www.`, port, path and case are presentation differences, so they are stripped; anything that is not a hostname is rejected with 400.',
    example: 'https://www.Example.com/pricing',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  domain: string;

  @ApiProperty({
    description:
      'Required. A domain change redirects every later crawl, audit and report, so the reason is part of the change, not an optional comment.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}
