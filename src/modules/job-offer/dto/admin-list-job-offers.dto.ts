import { Transform, Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsInt,
  IsNumber,
  Min,
  Max,
  IsArray,
  IsEnum,
  IsBoolean,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EmploymentType, JobOfferStatus, PaymentFlow } from '@prisma/client';
import { ToBoolean } from '../../../common/utils/query-boolean.util';

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

export class AdminListJobOffersDto {
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
    description: 'Search in title, description, address',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by job offer status',
    enum: JobOfferStatus,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(JobOfferStatus, { each: true })
  status?: JobOfferStatus[];

  @ApiPropertyOptional({
    description: 'Filter by kind of engagement',
    enum: EmploymentType,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(EmploymentType, { each: true })
  employment_type?: EmploymentType[];

  @ApiPropertyOptional({
    description: 'Filter by how the offer pays',
    enum: PaymentFlow,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(PaymentFlow, { each: true })
  payment_flow?: PaymentFlow[];

  @ApiPropertyOptional({
    description:
      'Lowest amount to include, inclusive. Offers with no amount set are ' +
      'excluded as soon as either bound is given — a null amount is not zero, ' +
      'and it cannot honestly be said to fall inside a range.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount_min?: number;

  @ApiPropertyOptional({
    description: 'Highest amount to include, inclusive.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount_max?: number;

  @ApiPropertyOptional({
    description:
      'When true, list archived (soft-deleted) rows instead of active',
  })
  @IsOptional()
  @ToBoolean(false)
  @IsBoolean()
  deleted?: boolean;
}
