import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessCategory, BusinessLegalForm } from '@prisma/client';
import { BUSINESS_SIZES } from '../business-catalog';

// Unlike the sign-up, an edit must be able to empty an optional field: a
// blank string means "remove it" (null), a missing key means "leave it".
const clearable = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : value;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Changes to an organisation, by the business itself (PATCH /business/me) or
 * by an admin (PATCH /admin/profiles/:id/business). Every field optional.
 */
export class UpdateBusinessDto {
  @ApiPropertyOptional({ description: 'Raison sociale' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ enum: BusinessCategory })
  @IsOptional()
  @IsEnum(BusinessCategory)
  category?: BusinessCategory;

  @ApiPropertyOptional({ enum: BusinessLegalForm, nullable: true })
  @Transform(clearable)
  @IsOptional()
  @IsEnum(BusinessLegalForm)
  legalForm?: BusinessLegalForm | null;

  @ApiPropertyOptional({ enum: BUSINESS_SIZES, nullable: true })
  @Transform(clearable)
  @IsOptional()
  @IsIn(BUSINESS_SIZES)
  size?: (typeof BUSINESS_SIZES)[number] | null;

  @ApiPropertyOptional({ nullable: true, description: 'Numéro RCCM' })
  @Transform(clearable)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'NIU' })
  @Transform(clearable)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  taxId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'SCIEN / SCIET' })
  @Transform(clearable)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  statisticalId?: string | null;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ description: 'ISO 3166-1 alpha-2', example: 'CG' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;

  @ApiPropertyOptional({ nullable: true })
  @Transform(clearable)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || null : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(clearable)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'https://entreprise.cg' })
  @Transform(clearable)
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  website?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @Transform(clearable)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}
