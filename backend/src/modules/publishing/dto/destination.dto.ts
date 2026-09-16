/**
 * DTOs for publish destinations — `/api/projects/:projectId/publish-destinations`.
 *
 * There is deliberately **no credential field**. A destination names a secret
 * (`credentialRef`) and never carries one; the service rejects anything
 * secret-shaped in `config` as well, so the two ways a credential could be
 * persisted on the row are both closed before the row is written.
 *
 * `permissions` is required on create and must be a subset of the one provider's
 * own declared scopes: a connection is authorized for a named scope set on a
 * named provider, never for "everything the connect button could ask for".
 *
 * @module publishing/dto/destination.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { CREDENTIAL_REF_RE, DESTINATION_STATUSES, PUBLISH_PROVIDERS } from '../publishing.types';

const PROVIDER_LIST = PUBLISH_PROVIDERS as unknown as string[];

export class CreateDestinationDto {
  @ApiProperty({
    enum: PROVIDER_LIST,
    description: 'Exactly one provider. CMS, social, email and ads are separate integrations — one connection never spans them.',
  })
  @IsIn(PROVIDER_LIST)
  provider: string;

  @ApiProperty({ description: 'What this connection is called in the UI.', example: 'Acme blog (production)' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional({
    description: 'Non-secret settings the provider adapter reads (e.g. `endpoint` for custom-webhook). Secret-shaped keys are rejected.',
    type: Object,
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Name of the secret-store entry holding this destination\'s credential (e.g. `acme-webhook` → `PUBLISH_CREDENTIAL_ACME_WEBHOOK`). A short lowercase slug — never the credential itself.',
    example: 'acme-webhook',
  })
  @IsOptional()
  @IsString()
  @Matches(CREDENTIAL_REF_RE, {
    message: 'credentialRef must be a short lowercase slug naming a secret-store entry — a credential value cannot be stored here',
  })
  credentialRef?: string;

  @ApiProperty({
    description: 'Scopes to authorize, a subset of this provider\'s declared scopes. Unknown scopes are rejected.',
    type: [String],
    example: ['content:write'],
  })
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  permissions: string[];

  @ApiPropertyOptional({ description: 'The remote resource to publish into, if already chosen.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  resourceId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  resourceLabel?: string;
}

export class UpdateDestinationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Change the secret reference. The value it names is never stored here.' })
  @IsOptional()
  @IsString()
  @Matches(CREDENTIAL_REF_RE, { message: 'credentialRef must be a short lowercase slug naming a secret-store entry' })
  credentialRef?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  permissions?: string[];
}

export class SelectResourceDto {
  @ApiProperty({ description: 'The resource id from the provider\'s resource list.' })
  @IsString()
  @MaxLength(200)
  resourceId: string;

  @ApiPropertyOptional({ description: 'Human label for the picked resource, for display.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  resourceLabel?: string;
}

export class RevokeDestinationDto {
  @ApiProperty({ description: 'Why it is being revoked. Recorded on the audit trail, not on the row.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class ListDestinationsQueryDto {  @ApiPropertyOptional({ enum: PROVIDER_LIST })
  @IsOptional()
  @IsIn(PROVIDER_LIST)
  provider?: string;

  @ApiPropertyOptional({ enum: DESTINATION_STATUSES as unknown as string[] })
  @IsOptional()
  @IsIn(DESTINATION_STATUSES as unknown as string[])
  status?: string;
}
