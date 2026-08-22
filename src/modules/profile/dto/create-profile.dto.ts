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
import { HasMxRecord } from '../../../common/validators/has-mx-record.validator';
import { LocationDto } from '../../../common/dto/location.dto';

export class CreateProfileDto extends LocationDto {
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
  @Transform(({ value }) => value?.trim()?.toLowerCase())
  @IsEmail()
  @HasMxRecord()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'Phone number (must be unique)' })
  @Transform(({ value }) => value?.trim()?.toLowerCase())
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

  @ApiProperty({
    description:
      'URL of the KYC identity document, pre-uploaded via POST /profile/kyc-upload',
  })
  @IsString()
  @IsNotEmpty()
  kycDocumentUrl: string;

  @ApiProperty({
    description:
      'URL of the KYC selfie, pre-uploaded via POST /profile/kyc-upload',
  })
  @IsString()
  @IsNotEmpty()
  kycSelfieUrl: string;

  /**
   * Back of the identity document, pre-uploaded via POST /profile/kyc-upload.
   *
   * Required for every DocumentType except PASSPORT, whose data sits entirely
   * on the photo page. That rule is NOT enforced here yet: this field ships
   * optional so the currently-deployed client -- which does not send it -- keeps
   * registering profiles while the new client rolls out. Once no old client is
   * in the field, swap @IsOptional() for:
   *
   *   @ValidateIf((o: CreateProfileDto) => o.documentType !== DocumentType.PASSPORT)
   *   @IsNotEmpty()
   *
   * The persistence side already gates on documentType (see
   * ProfileService.createProfileWithDocuments), so a back sent alongside a
   * PASSPORT is discarded rather than stored as an orphan row.
   */
  @ApiPropertyOptional({
    description:
      'URL of the back of the KYC identity document, pre-uploaded via ' +
      'POST /profile/kyc-upload. Expected for every document type except ' +
      'PASSPORT, which has no back to photograph.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kycDocumentBackUrl?: string;

  /*
   * The storage keys of the three files above.
   *
   * `POST /profile/kyc-upload` used to return only a url, so nothing carried a
   * key back here and `storage_key` ended up NULL on every KYC row ever
   * written. That is what kept the documents in the public bucket: a signed
   * url needs a key, and there was none to sign with.
   *
   * OPTIONAL, and they have to stay that way for now — the deployed client
   * does not send them, exactly as with `kycDocumentBackUrl` above. A profile
   * created without a key keeps its stored url and is picked up by the
   * backfill. Tighten this once no old client is in the field.
   */

  @ApiPropertyOptional({
    description:
      'Storage key of the KYC identity document, returned by ' +
      'POST /profile/kyc-upload. Required to serve the file through a ' +
      'time-limited signed url.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kycDocumentKey?: string;

  @ApiPropertyOptional({
    description:
      'Storage key of the KYC selfie, returned by POST /profile/kyc-upload.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kycSelfieKey?: string;

  @ApiPropertyOptional({
    description:
      'Storage key of the back of the KYC identity document, returned by ' +
      'POST /profile/kyc-upload.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kycDocumentBackKey?: string;
}
