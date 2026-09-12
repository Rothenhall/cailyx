/**
 * DTOs for the Digital Presence module.
 *
 * @module presence.dto
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ALL_APIFY_PLATFORMS, type ApifyPlatform } from '../presence.apify.service';

/** Add an account the crawler did not find, or correct one it got wrong. */
export class AddAccountDto {
  @ApiProperty({
    description:
      'The profile URL. The platform and handle are derived from it — paste the profile itself ' +
      '(https://instagram.com/yourbrand), not a post, a share link or a search result.',
    example: 'https://www.linkedin.com/company/acme',
  })
  @IsString()
  @IsUrl({ require_protocol: true }, { message: 'url must be a full URL including https://' })
  @MaxLength(2000)
  url: string;
}

/** Options for a discovery run. */
export class DiscoverDto {
  @ApiPropertyOptional({
    description:
      'Also search Google (DataForSEO) for accounts the site does not link. **Spends paid ' +
      'credits per platform searched** and is therefore opt-in: a free crawl is the default so ' +
      'nothing bills by accident, and the smoke harness stays zero-spend. Responses cache for ' +
      'seven days, and a cache hit is not a spend. Results land as `candidate` rows awaiting ' +
      'confirmation, never as accounts.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  searchWeb?: boolean;
}

/** Paging for the discovery-run history. */
export class RunHistoryQueryDto {
  @ApiPropertyOptional({ description: 'How many runs to return', default: 10, minimum: 1, maximum: 50 })
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  limit?: number;
}

/** Options for a business-profile pull (DataForSEO Business Data, wave-6 D2). */
export class BusinessProfileDto {
  @ApiPropertyOptional({
    description:
      'Business name to search for. Defaults to the project\'s client name / name — set this when neither ' +
      'matches what the business is listed under.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  businessName?: string;

  @ApiPropertyOptional({
    description:
      'Location to search in (DataForSEO location_name, e.g. "London,England,United Kingdom"). Defaults to ' +
      '`PRESENCE_BUSINESS_LOCATION` — a single generic fallback, not full market resolution.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  locationName?: string;
}

/**
 * Options for a social-activity pull (Apify, wave-6 D7).
 *
 * `confirmSpend` is required and must be `true` — mirrors `DiscoverDto.searchWeb`'s
 * opt-in, but stricter: this spends against a real account's $5/month usage
 * credit, so there is no default that runs it, only an explicit yes.
 */
export class SocialActivityDto {
  @ApiProperty({
    description:
      'Must be exactly `true` to run. This calls real Apify actors and spends real account credit — there is ' +
      'no default path that runs this, matching the opt-in `searchWeb` already used by /discover. Omitting it ' +
      '(or passing false) runs nothing and spends nothing.',
  })
  @IsBoolean()
  confirmSpend: boolean;

  @ApiPropertyOptional({
    description:
      'Platforms to pull. Defaults to `APIFY_PLATFORMS` (linkedin, instagram, facebook, twitter by default — ' +
      'youtube/tiktok are supported but off unless named here or enabled by config).',
    enum: ALL_APIFY_PLATFORMS,
    isArray: true,
  })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(ALL_APIFY_PLATFORMS.length)
  @IsIn(ALL_APIFY_PLATFORMS, { each: true })
  platforms?: ApifyPlatform[];

  @ApiPropertyOptional({
    description: 'Recent posts to pull per platform. Defaults to `APIFY_POSTS_PER_PLATFORM` (20 — D7\'s cost table).',
    minimum: 1,
    maximum: 100,
  })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  postsPerPlatform?: number;
}
