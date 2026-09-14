/**
 * DTOs for the Client Portal module.
 *
 * @module client-portal.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class PostPortalMessageDto {
  @ApiPropertyOptional({ description: 'Scope the message to one of this client\'s own projects. Rejected with 404 if it is not one of theirs.' })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;
}
