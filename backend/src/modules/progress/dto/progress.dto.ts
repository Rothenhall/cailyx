import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ApproveProgressReviewDto {
  @ApiPropertyOptional({ description: 'Optional reviewer note, internal only.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class RejectProgressReviewDto {
  @ApiProperty({ description: 'Why the page should not reach the client — internal only.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note: string;
}
