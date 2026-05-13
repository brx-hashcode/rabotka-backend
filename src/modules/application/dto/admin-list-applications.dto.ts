import { Transform, Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsArray,
  IsEnum,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ApplicationStatus } from '@prisma/client';

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export class AdminListApplicationsDto {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Search in worker name, job title',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by application status',
    enum: ApplicationStatus,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(ApplicationStatus, { each: true })
  status?: ApplicationStatus[];

  @ApiPropertyOptional({
    description: 'Filter by penalty applied',
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  penalty_applied?: string[];

  @ApiPropertyOptional({ description: 'Filter by worker profile ID' })
  @IsOptional()
  @IsString()
  worker_id?: string;

  @ApiPropertyOptional({ description: 'Filter by employer profile ID' })
  @IsOptional()
  @IsString()
  employer_id?: string;
}
