/**
 * DTOs for the Reporting module.
 *
 * @module reporting.dto
 */

import { IsString, IsNotEmpty, IsOptional, IsIn, IsUrl } from 'class-validator';

export class GenerateReportDto {
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  targetUrl: string;

  @IsString()
  @IsNotEmpty()
  title: string;
}

export class SetVisibilityDto {
  @IsIn(['private', 'public'])
  visibility: 'private' | 'public';
}