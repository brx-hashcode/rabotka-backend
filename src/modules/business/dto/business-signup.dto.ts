import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BusinessCategory,
  BusinessDocumentType,
  BusinessLegalForm,
} from '@prisma/client';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/** Headcount brackets offered at sign-up. */
export const BUSINESS_SIZES = ['1-5', '6-20', '21-100', '100+'] as const;

/**
 * One business document, pre-uploaded through POST /profile/kyc-upload with
 * the signup token — the same route, checks and private bucket as the
 * personal KYC files.
 */
export class BusinessDocumentInputDto {
  @ApiProperty({ enum: BusinessDocumentType })
  @IsEnum(BusinessDocumentType)
  documentType: BusinessDocumentType;

  @ApiProperty({
    description:
      'Url returned by POST /profile/kyc-upload. The key is derived from it when `key` is missing or wrong.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url: string;

  @ApiPropertyOptional({
    description: 'Storage key returned by POST /profile/kyc-upload (a hint).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  key?: string;

  @ApiPropertyOptional({ description: 'Original file name, for the reviewer.' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(255)
  fileName?: string;
}

/**
 * The organisation, sent with POST /profile by a business sign-up (a signup
 * token proven by email) and refused from any other. Which documents are
 * required depends on the category — see business-catalog.ts.
 */
export class BusinessSignupDto {
  @ApiProperty({
    description: 'Raison sociale',
    example: 'Boulangerie Mavoungou',
  })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name: string;

  @ApiProperty({ enum: BusinessCategory })
  @IsEnum(BusinessCategory)
  category: BusinessCategory;

  @ApiPropertyOptional({ enum: BusinessLegalForm })
  @IsOptional()
  @IsEnum(BusinessLegalForm)
  legalForm?: BusinessLegalForm;

  @ApiPropertyOptional({ enum: BUSINESS_SIZES, description: 'Effectif' })
  @IsOptional()
  @IsIn(BUSINESS_SIZES)
  size?: (typeof BUSINESS_SIZES)[number];

  @ApiPropertyOptional({ description: 'Numéro RCCM' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string;

  @ApiPropertyOptional({ description: 'NIU (numéro d’identification unique)' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  taxId?: string;

  @ApiPropertyOptional({ description: 'SCIEN / SCIET (CNSEE)' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  statisticalId?: string;

  @ApiProperty({ description: 'Adresse du siège ou de l’établissement' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  address: string;

  @ApiPropertyOptional({
    description: 'Contact email; the sign-up email when omitted.',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() || undefined : value,
  )
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    description: 'Contact phone; the profile’s when omitted.',
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ example: 'https://entreprise.cg' })
  @Transform(trim)
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(500)
  website?: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ type: [BusinessDocumentInputDto] })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BusinessDocumentInputDto)
  documents: BusinessDocumentInputDto[];
}
