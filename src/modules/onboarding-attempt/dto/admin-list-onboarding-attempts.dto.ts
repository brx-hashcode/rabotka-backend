import { ApiPropertyOptional } from '@nestjs/swagger';
import { OnboardingStage } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBooleanString,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class AdminListOnboardingAttemptsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Matches the phone, the email or the name.',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: OnboardingStage, isArray: true })
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  @IsEnum(OnboardingStage, { each: true })
  stage?: OnboardingStage[];

  @ApiPropertyOptional({
    enum: ['whatsapp', 'business'],
    description: 'business: email sign-ups of organisations only.',
  })
  @IsOptional()
  @IsIn(['whatsapp', 'business'])
  entry?: 'whatsapp' | 'business';

  @ApiPropertyOptional({
    description: 'Only attempts that never became an account.',
  })
  @IsOptional()
  @IsBooleanString()
  incomplete?: string;

  @ApiPropertyOptional({ description: 'true: reached out to; false: not yet.' })
  @IsOptional()
  @IsBooleanString()
  contacted?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  started_from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  started_to?: string;
}

export class AdminOnboardingStatsDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  started_from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  started_to?: string;
}
