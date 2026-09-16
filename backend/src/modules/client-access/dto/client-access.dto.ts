/**
 * DTOs for the ClientAccess module (G02).
 *
 * @module client-access.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { CLIENT_MEMBER_ROLES, type ClientMemberRole } from '../client-access.types';

/** Add an EXISTING client-type User (already logged in at least once via
 *  `POST /clients/:id/login`) as a scoped seat. Invitations (below) are for
 *  people who do not have a login yet. */
export class CreateMemberDto {
  @ApiProperty({ description: 'User.id of an existing type="client" login belonging to this client.' })
  @IsString()
  userId!: string;

  @ApiPropertyOptional({ enum: CLIENT_MEMBER_ROLES, default: 'client-collaborator' })
  @IsOptional()
  @IsIn(CLIENT_MEMBER_ROLES as unknown as string[])
  role?: ClientMemberRole;

  @ApiPropertyOptional({ description: 'Project ids this seat may see. Omit/empty = every project of this client.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  projectIds?: string[];
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ enum: CLIENT_MEMBER_ROLES })
  @IsOptional()
  @IsIn(CLIENT_MEMBER_ROLES as unknown as string[])
  role?: ClientMemberRole;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  projectIds?: string[];

  @ApiPropertyOptional({ enum: ['active', 'suspended'] })
  @IsOptional()
  @IsIn(['active', 'suspended'])
  status?: 'active' | 'suspended';
}

export class CreateInviteDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({ enum: CLIENT_MEMBER_ROLES, default: 'client-collaborator' })
  @IsOptional()
  @IsIn(CLIENT_MEMBER_ROLES as unknown as string[])
  role?: ClientMemberRole;

  @ApiPropertyOptional({ description: 'Project ids this invite grants. Omit/empty = every project of this client.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  projectIds?: string[];
}

export class AcceptInviteDto {
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

const GOOGLE_SERVICES = ['search-console', 'analytics'] as const;

export class GoogleAuthorizeDto {
  @ApiProperty({ enum: GOOGLE_SERVICES })
  @IsIn(GOOGLE_SERVICES as unknown as string[])
  service!: 'search-console' | 'analytics';
}

export class GoogleResourceQueryDto {
  @ApiProperty({ enum: GOOGLE_SERVICES })
  @IsIn(GOOGLE_SERVICES as unknown as string[])
  service!: 'search-console' | 'analytics';
}

export class SetGoogleResourceDto {
  @ApiProperty({ enum: GOOGLE_SERVICES })
  @IsIn(GOOGLE_SERVICES as unknown as string[])
  service!: 'search-console' | 'analytics';

  @ApiProperty({ description: 'GSC siteUrl, or GA4 "properties/123456789" — must be one of the options returned by the resources list, never a free-typed id.' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  resourceId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  resourceLabel?: string;
}

const ACCESS_LEVELS = ['read', 'read-write'] as const;

export class CreateDelegationDto {
  @ApiProperty({ description: 'User.id of the person being granted access. Must already be a seat/operator with reach into this project — never an arbitrary id.' })
  @IsString()
  granteeUserId!: string;

  @ApiPropertyOptional({ enum: ACCESS_LEVELS, default: 'read' })
  @IsOptional()
  @IsIn(ACCESS_LEVELS as unknown as string[])
  accessLevel?: 'read' | 'read-write';
}
