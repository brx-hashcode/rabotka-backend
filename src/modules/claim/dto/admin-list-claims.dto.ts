import { Transform, Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsArray,
  IsUUID,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

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

export class AdminListClaimsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  status?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  profile_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_user_id?: string;
}
