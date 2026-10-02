import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { AgentStatus, DocumentType, KycDocumentCategory } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** A zone in a query string: ISO country code, colon, city as stored. */
export const ZONE_PARAM = /^[A-Z]{2}:.{1,120}$/;

function toArray(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    .map((v) => v.trim())
    .filter(Boolean);
}

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Loose on purpose: `toE164` does the real normalisation. */
const PHONE_PATTERN = /^\+?[\d\s().-]{8,20}$/;

export class AgentZoneDto {
  @ApiProperty({ description: 'ISO 3166-1 alpha-2', example: 'CG' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(2, 2)
  countryCode: string;

  @ApiProperty({ example: 'Brazzaville' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city: string;
}

export class AgentKycDocumentRefDto {
  @ApiProperty({ enum: KycDocumentCategory })
  @IsEnum(KycDocumentCategory)
  category: KycDocumentCategory;

  @ApiProperty({
    description: 'Storage key returned by POST admin/agents/uploads/kyc',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  key: string;
}

export class CreateAgentDto {
  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName: string;

  @ApiProperty()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName: string;

  @ApiProperty({ description: 'Login identity — the OTP is sent here' })
  @IsEmail({}, { message: 'Adresse email invalide' })
  email: string;

  @ApiProperty({ description: 'With country code, e.g. +242069917686' })
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'Numéro de téléphone invalide' })
  phone: string;

  @ApiProperty({ enum: DocumentType })
  @IsEnum(DocumentType)
  idDocumentType: DocumentType;

  @ApiProperty({ description: 'Number printed on the identity document' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  idDocumentNumber: string;

  @ApiProperty({ type: [AgentZoneDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Au moins une zone est requise' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AgentZoneDto)
  zones: AgentZoneDto[];

  @ApiProperty({
    type: [AgentKycDocumentRefDto],
    description:
      'Front + selfie, plus the back unless the document is a passport',
  })
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => AgentKycDocumentRefDto)
  kycDocuments: AgentKycDocumentRefDto[];

  @ApiPropertyOptional({
    description: 'Storage key returned by POST admin/agents/uploads/avatar',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  avatarKey?: string;
}

/** Everything but the documents, which are replaced one at a time. */
export class UpdateAgentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: 'Adresse email invalide' })
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, { message: 'Numéro de téléphone invalide' })
  phone?: string;

  @ApiPropertyOptional({ type: [AgentZoneDto], description: 'Replaces all' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Au moins une zone est requise' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AgentZoneDto)
  zones?: AgentZoneDto[];
}

export class AgentStatusReasonDto {
  @ApiPropertyOptional({
    description: 'Required to suspend or revoke; shown to admins only',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ReplaceAgentAvatarDto {
  @ApiProperty({ description: 'Key from POST admin/agents/uploads/avatar' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  avatarKey: string;
}

export class ReplaceAgentKycDocumentDto {
  @ApiProperty({ description: 'Key from POST admin/agents/uploads/kyc' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  key: string;
}

export class AdminListAgentsDto {
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
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Name, email or phone' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: AgentStatus })
  @IsOptional()
  @IsEnum(AgentStatus)
  status?: AgentStatus;

  @ApiPropertyOptional({ description: 'Agents covering this city' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  city?: string;

  @ApiPropertyOptional({
    description:
      'Agents covering ANY of these zones, each as COUNTRY:City (e.g. CG:Brazzaville). Repeat the param or comma-separate.',
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(ZONE_PARAM, {
    each: true,
    message: 'zone must look like CG:Brazzaville',
  })
  zone?: string[];

  @ApiPropertyOptional({
    description:
      'Agents covering any city in these countries (ISO 3166-1 alpha-2). Repeat or comma-separate.',
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value).map((v) => v.toUpperCase()))
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(/^[A-Z]{2}$/, { each: true, message: 'country must be an ISO code' })
  country?: string[];
}
