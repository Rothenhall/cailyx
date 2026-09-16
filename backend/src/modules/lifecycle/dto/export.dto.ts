/**
 * DTOs for export request/status/download — `/api/projects/:projectId/exports`
 * and `/api/clients/:clientId/exports`.
 *
 * @module dto/export.dto
 */

import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { EXPORT_FORMATS, EXPORT_SECTIONS } from '../lifecycle.types';
import { DEFAULT_EXPORT_TTL_HOURS, MAX_EXPORT_TTL_HOURS } from '../lifecycle.types';

export class CreateExportDto {
  @ApiPropertyOptional({
    enum: EXPORT_SECTIONS,
    isArray: true,
    description:
      'Sections to include. Defaults to the documented bundle, which deliberately excludes `leads` (Cailyx\'s own sales pipeline, personal contact data) and `activity` (the audit trail). Both are exportable on request — nothing is silently included.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXPORT_SECTIONS.length)
  @IsIn(EXPORT_SECTIONS as unknown as string[], { each: true })
  sections?: string[];

  @ApiPropertyOptional({
    enum: EXPORT_FORMATS,
    default: 'json',
    description:
      '`json` writes one bundle for all requested sections. `csv` renders exactly one section as CSV — a bundle cannot be represented in a spreadsheet, and this service does not invent an archive format it cannot produce.',
  })
  @IsOptional()
  @IsIn(EXPORT_FORMATS as unknown as string[])
  format?: string;

  @ApiPropertyOptional({
    default: DEFAULT_EXPORT_TTL_HOURS,
    description: `Download-link lifetime in hours (1-${MAX_EXPORT_TTL_HOURS}, default ${DEFAULT_EXPORT_TTL_HOURS}). An export is scoped and expiring, not a permalink.`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_EXPORT_TTL_HOURS)
  ttlHours?: number;

  @ApiPropertyOptional({ description: 'Why this export was requested. Recorded on the row and in the audit trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
