/**
 * DTOs for the Operations module (G14) — portfolio filters, pagination and
 * saved views. Every list endpoint shares the same page/pageSize contract so
 * totals and filters are always evaluated together (never a client-computed
 * total against a server-filtered page).
 *
 * @module operations.dto
 */

import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

const MAX_PAGE_SIZE = 100;

/** Shared page/pageSize + search fields every portfolio list accepts. */
export class PortfolioListQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number = 25;

  @ApiPropertyOptional({ description: 'Free-text search — matches name/title/email depending on surface.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class ClientsHealthQueryDto extends PortfolioListQueryDto {
  @ApiPropertyOptional({ enum: ['active', 'paused', 'churned'] })
  @IsOptional()
  @IsIn(['active', 'paused', 'churned'])
  status?: string;

  @ApiPropertyOptional({ description: 'Only clients owned by this operator User.id.' })
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @ApiPropertyOptional({ description: 'Only clients with at least one overdue work item.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  hasOverdueWork?: boolean;

  @ApiPropertyOptional({ description: 'Only clients with at least one decision awaiting review.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  hasAwaitingDecisions?: boolean;

  @ApiPropertyOptional({ description: 'Only clients with at least one stale (unsynced) source.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  hasStaleSources?: boolean;
}

export class WorkQueryDto extends PortfolioListQueryDto {
  @ApiPropertyOptional({ enum: ['backlog', 'committed', 'active', 'review', 'blocked', 'verified', 'cancelled'] })
  @IsOptional()
  @IsIn(['backlog', 'committed', 'active', 'review', 'blocked', 'verified', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({ enum: ['fix', 'build', 'influence'] })
  @IsOptional()
  @IsIn(['fix', 'build', 'influence'])
  category?: string;

  @ApiPropertyOptional({ enum: ['technical', 'content', 'authority', 'research', 'reporting', 'access'] })
  @IsOptional()
  @IsIn(['technical', 'content', 'authority', 'research', 'reporting', 'access'])
  discipline?: string;

  @ApiPropertyOptional({ enum: ['low', 'medium', 'high', 'critical'] })
  @IsOptional()
  @IsIn(['low', 'medium', 'high', 'critical'])
  priority?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiPropertyOptional({ description: 'Only work items past dueAt that are not verified/cancelled.' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  overdue?: boolean;
}

export class ReportsQueryDto extends PortfolioListQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'in-review', 'approved', 'released', 'withdrawn'] })
  @IsOptional()
  @IsIn(['draft', 'in-review', 'approved', 'released', 'withdrawn'])
  status?: string;

  @ApiPropertyOptional({ enum: ['private', 'public'] })
  @IsOptional()
  @IsIn(['private', 'public'])
  visibility?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  clientId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class SalesLeadsQueryDto extends PortfolioListQueryDto {
  @ApiPropertyOptional({ enum: ['new', 'reached', 'booked', 'won', 'lost'] })
  @IsOptional()
  @IsIn(['new', 'reached', 'booked', 'won', 'lost'])
  status?: string;

  @ApiPropertyOptional({ enum: ['bulk', 'api', 'form', 'scorecard'] })
  @IsOptional()
  @IsIn(['bulk', 'api', 'form', 'scorecard'])
  source?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectId?: string;
}

const SAVED_VIEW_SURFACES = ['clients', 'projects', 'work', 'reports', 'leads', 'alerts'] as const;

export class CreateSavedViewDto {
  @ApiProperty({ enum: SAVED_VIEW_SURFACES })
  @IsIn(SAVED_VIEW_SURFACES as unknown as string[])
  surface: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ description: 'The filter/sort/column query state — stored verbatim, never a snapshot of result rows.' })
  // Without a validator here the global whitelist + forbidNonWhitelisted pipe
  // rejects every request that carries `filters`, which silently made saved
  // views store an empty object.
  @IsObject()
  filters: Record<string, unknown>;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateSavedViewDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
