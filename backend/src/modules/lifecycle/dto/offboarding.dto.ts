/**
 * DTOs for offboarding preview / execute — `/api/clients/:clientId/offboarding`.
 *
 * @module dto/offboarding.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { SHARE_LINK_POLICIES } from '../lifecycle.types';
import { RESOURCE_CLASSES } from '../lifecycle.policy';

/** Body for the preview. A preview never changes anything, so every field is optional. */
export class PreviewOffboardingDto {
  @ApiPropertyOptional({
    enum: SHARE_LINK_POLICIES,
    default: 'revoke',
    description:
      'What happens to public report links. `revoke` stamps `revokedAt` and makes the reports private again; `keep` leaves them live and says so. `keep` is not the default because retaining a public link past offboarding is the one effect a client cannot undo.',
  })
  @IsOptional()
  @IsIn(SHARE_LINK_POLICIES as unknown as string[])
  shareLinkPolicy?: string;

  @ApiPropertyOptional({
    description:
      'Per-resource-type action overrides, e.g. `{ "observations": "delete", "client-messages": "delete" }`. ' +
      'Only resource types whose policy is overridable accept one, and only for an action the policy lists — ' +
      'an override for the audit trail or for a credential is refused rather than ignored.',
  })
  @IsOptional()
  @IsObject()
  overrides?: Record<string, string>;

  @ApiPropertyOptional({
    enum: RESOURCE_CLASSES,
    isArray: true,
    description: 'Narrow the preview to these classes. Omitted means every class — the preview is never narrowed for the caller by default, because an unreported cascade is the failure this endpoint exists to prevent.',
  })
  @IsOptional()
  @IsString({ each: true })
  classes?: string[];
}

/**
 * Body for the execute.
 *
 * Three separate confirmations, because each answers a different question:
 * `previewRunId` (which plan), `confirm` (yes, now), and `confirmationPhrase`
 * (the client's name, typed). The phrase is the one that catches a call
 * assembled by a script against the wrong client id.
 */
export class ExecuteOffboardingDto {
  @ApiProperty({ description: 'The OffboardingRun id returned by the preview. Its counts are re-verified at execute time; if the client\'s data moved since, the execute is refused (409) and a fresh preview is required.' })
  @IsString()
  previewRunId: string;

  @ApiProperty({ description: 'Must be literally true. The execute refuses without it.' })
  @IsBoolean()
  confirm: boolean;

  @ApiProperty({ description: 'The client\'s exact name, typed out. Mismatches are refused (400).' })
  @IsString()
  @MaxLength(200)
  confirmationPhrase: string;

  @ApiPropertyOptional({ enum: SHARE_LINK_POLICIES, description: 'Overrides the preview\'s choice. The applied policy is recorded on the run and reported back.' })
  @IsOptional()
  @IsIn(SHARE_LINK_POLICIES as unknown as string[])
  shareLinkPolicy?: string;

  @ApiPropertyOptional({ description: 'An already-ready ExportRequest covering this client, recorded on the run as the copy taken before destruction. Not required — but if it is named, it must be a ready export for this same client.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  exportRequestId?: string;

  @ApiPropertyOptional({
    description:
      'Required only when the plan would delete rows that a pinned EvidenceManifest names. The preview reports those conflicts by id; a frozen snapshot whose sources are removed can no longer be resolved, so the acknowledgement is explicit.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeFrozenSnapshots?: boolean;
}

/** Body for cancelling a preview that will not be executed. */
export class CancelOffboardingDto {
  @ApiPropertyOptional({ description: 'Why the plan was abandoned. Recorded on the run.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
