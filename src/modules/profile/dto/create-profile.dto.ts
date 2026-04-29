import { Transform } from 'class-transformer';
import {
  IsString,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsArray,
  IsUUID,
  Equals,
} from 'class-validator';
import { ProfileType, DocumentType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateProfileDto {
  @ApiProperty({ description: 'First name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ description: 'Last name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ description: 'Email address (must be unique)' })
  @Transform(({ value }) => value?.trim())
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Phone number (must be unique)' })
  @Transform(({ value }) => value?.trim())
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ description: 'Physical address' })
  @Transform(({ value }) => value?.trim())
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiPropertyOptional({ description: 'Profile description' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Profile type',
    enum: ProfileType,
    example: ProfileType.WORKER,
  })
  @Transform(({ value }) => value as ProfileType)
  @IsEnum(ProfileType)
  @IsNotEmpty()
  profileType: ProfileType;

  @ApiPropertyOptional({
    description: 'Job category IDs (at least one required for all profiles)',
  })
  @Transform(({ value }) =>
    Array.isArray(value) ? value : value != null ? [value] : undefined,
  )
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @ApiProperty({
    description: 'Document type for KYC verification',
    enum: DocumentType,
    example: DocumentType.IDENTITY_CARD,
  })
  @Transform(({ value }) => value as DocumentType)
  @IsEnum(DocumentType)
  @IsNotEmpty()
  documentType: DocumentType;

  @ApiProperty({ description: 'User has read and approved platform policies' })
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @Equals(true, {
    message: 'You must accept the platform policies to register',
  })
  readAndApprovedPolicies: boolean;
}
