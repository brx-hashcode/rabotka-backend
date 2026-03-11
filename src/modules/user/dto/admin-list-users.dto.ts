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
import { UserRole } from '@prisma/client';

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export class AdminListUsersDto {
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
    description: 'Search in first_name, last_name, email',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by role',
    enum: UserRole,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(UserRole, { each: true })
  role?: UserRole[];
}
