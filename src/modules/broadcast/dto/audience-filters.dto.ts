import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { AccountStatus, ProfileType, VerificationStatus } from '@prisma/client';
import { ToBoolean } from '../../../common/utils/query-boolean.util';

/** Comma-separated or repeated query params both arrive as an array. */
const toArray = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',').filter(Boolean) : value;

/**
 * Who a broadcast reaches.
 *
 * Every field is optional and every one narrows: an empty object means "every
 * active profile that has not opted out", which is a legitimate — and
 * deliberately expensive — audience. What it can never mean is a deleted
 * profile or an opted-out one; `buildAudienceWhere` enforces both regardless of
 * what arrives here.
 */
export class AudienceFiltersDto {
  @ApiPropertyOptional({ enum: ProfileType, isArray: true })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(ProfileType, { each: true })
  profile_types?: ProfileType[];

  @ApiPropertyOptional({ enum: AccountStatus, isArray: true })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(AccountStatus, { each: true })
  statuses?: AccountStatus[];

  @ApiPropertyOptional({ enum: VerificationStatus, isArray: true })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(VerificationStatus, { each: true })
  verification_statuses?: VerificationStatus[];

  @ApiPropertyOptional({ example: ['CG'] })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  country_codes?: string[];

  @ApiPropertyOptional({ example: ['Brazzaville'] })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  cities?: string[];

  @ApiPropertyOptional({ description: 'Job category ids' })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  category_ids?: string[];

  @ApiPropertyOptional({ description: 'Signed up on or after' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  created_from?: Date;

  @ApiPropertyOptional({ description: 'Signed up on or before' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  created_to?: Date;

  @ApiPropertyOptional({
    description: 'Signed in within the last N days',
    minimum: 1,
    maximum: 365,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  active_within_days?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  whatsapp_connected?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  has_email?: boolean;

  @ApiPropertyOptional({ description: 'Always included, whatever the filters' })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  include_profile_ids?: string[];

  @ApiPropertyOptional({ description: 'Never included; wins over inclusions' })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsUUID('4', { each: true })
  exclude_profile_ids?: string[];
}
