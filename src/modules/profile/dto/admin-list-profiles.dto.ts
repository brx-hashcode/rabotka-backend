import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import { ToBoolean } from '../../../common/utils/query-boolean.util';

/**
 * The kinds of profile admin tells apart. A business is an employer profile
 * flagged `is_business`; an « employer » here is an individual one.
 */
export const ADMIN_PROFILE_KINDS = ['WORKER', 'EMPLOYER', 'BUSINESS'] as const;
export type AdminProfileKind = (typeof ADMIN_PROFILE_KINDS)[number];

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

export class AdminListProfilesDto {
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
    description: 'Search in first_name, last_name, email, phone',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by account status',
    enum: AccountStatus,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(AccountStatus, { each: true })
  status?: AccountStatus[];

  @ApiPropertyOptional({
    description:
      'Filter by kind of profile: WORKER, EMPLOYER (an individual employer) or BUSINESS (an organisation, is_business)',
    enum: ADMIN_PROFILE_KINDS,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(ADMIN_PROFILE_KINDS, { each: true })
  profile_type?: AdminProfileKind[];

  @ApiPropertyOptional({ description: 'Filter by WhatsApp connected' })
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  whatsapp_connected?: boolean;

  @ApiPropertyOptional({
    description: 'Filter by verification status',
    enum: VerificationStatus,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(VerificationStatus, { each: true })
  verification_status?: VerificationStatus[];

  @ApiPropertyOptional({
    description:
      'When true, list archived (soft-deleted) rows instead of active',
  })
  @IsOptional()
  @ToBoolean(false)
  @IsBoolean()
  deleted?: boolean;
}
