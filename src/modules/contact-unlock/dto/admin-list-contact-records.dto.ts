import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ContactRecordOrigin } from '@prisma/client';

/** CSV or repeated query param → string[]. Mirrors the other admin list DTOs. */
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

export class AdminListContactRecordsDto {
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
    description: 'Search in employer name, worker name, job title',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description:
      'MISSION (through a job offer) or DIRECT (recommendation, no job)',
    enum: ContactRecordOrigin,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(ContactRecordOrigin, { each: true })
  origin?: ContactRecordOrigin[];

  @ApiPropertyOptional({ description: 'Filter by employer profile ID' })
  @IsOptional()
  @IsString()
  employer_id?: string;

  @ApiPropertyOptional({ description: 'Filter by worker profile ID' })
  @IsOptional()
  @IsString()
  worker_id?: string;

  @ApiPropertyOptional({ description: 'Filter by job offer ID (MISSION only)' })
  @IsOptional()
  @IsString()
  job_offer_id?: string;

  @ApiPropertyOptional({
    description: 'Only contacts paid for at or after this date (ISO 8601)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  since?: Date;

  @ApiPropertyOptional({
    description: 'Only contacts paid for before this date (ISO 8601)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  until?: Date;
}
