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
  Matches,
  MaxLength,
} from 'class-validator';
import { ProfileType, DocumentType, ReferralSource } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HasMxRecord } from '../../../common/validators/has-mx-record.validator';
import { LocationDto } from '../../../common/dto/location.dto';
import { REFERRAL_CODE_PATTERN } from '../../referral/utils/referral-code.util';

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

  /**
   * Optional: most of the informal sector has a phone and no email. `phone` is
   * the identity signup actually proves, and every message the platform sends
   * goes there.
   *
   * `|| null` rather than leaving `''`: the column is unique, and Postgres
   * treats '' as a real value, so a second emailless signup would collide.
   * Validation still applies when an address IS given — an optional field is
   * not a lax one.
   */
  @ApiPropertyOptional({
    description: 'Email address (optional, must be unique when provided)',
  })
  @Transform(({ value }) => value?.trim()?.toLowerCase() || null)
  @IsOptional()
  @IsEmail()
  @HasMxRecord()
  email?: string | null;

  @ApiProperty({ description: 'Phone number (must be unique)' })
  @Transform(({ value }) => value?.trim()?.toLowerCase())
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiPropertyOptional({
    description:
      'Optional second number to be reached on, when the WhatsApp number is not one the person answers calls on. Not unique, never used for login.',
  })
  // Empty string normalised to undefined: the form always sends the field, and
  // a blank one means "no second number", not "store an empty number".
  @Transform(({ value }) => value?.trim() || undefined)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  directPhone?: string;

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
      'Storage key of the KYC identity document, returned by POST /profile/kyc-upload. A hint, not a trusted input: the backend derives the key from the url and ignores this when the two disagree.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kycDocumentKey?: string;

  @ApiPropertyOptional({
    description:
      'Storage key of the KYC selfie, returned by POST /profile/kyc-upload. A hint, not a trusted input: the backend derives the key from the url and ignores this when the two disagree.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kycSelfieKey?: string;

  @ApiPropertyOptional({
    description:
      'Storage key of the back of the KYC identity document, returned by POST /profile/kyc-upload. A hint, not a trusted input: the backend derives the key from the url and ignores this when the two disagree.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  kycDocumentBackKey?: string;

  /**
   * Parrainage code of the profile that invited this user — from a `?ref=`
   * link or typed on the confirmation screen.
   *
   * An unknown, malformed or self-referring code is ignored rather than
   * rejected: the code is the least important field on this form, and a bad one
   * must never cost someone their account. `@Matches` only screens out what
   * could not be a code at all, so the request still reaches the service.
   */
  @ApiPropertyOptional({
    description:
      'Parrainage code of the inviting profile. Unknown codes are ignored, never an error.',
    example: 'K7M2XQ',
  })
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.trim().toUpperCase().replace(/[\s-]/g, '')
      : undefined,
  )
  @IsOptional()
  @IsString()
  @Matches(REFERRAL_CODE_PATTERN, {
    message: 'Le code de parrainage doit comporter 6 caractères.',
  })
  referralCode?: string;

  /**
   * How the code got here. Only the client can tell a followed `?ref=` link
   * from a code someone typed, and the difference is the whole point of the
   * column: it says whether links or word-of-mouth is doing the work.
   *
   * Untrusted, like any client input, and only ever used as a label. Defaults
   * to MANUAL_CODE when absent — the deployed client does not send it, and a
   * typed code is the safer thing to assume of an unknown caller.
   */
  @ApiPropertyOptional({
    description: 'Where the referral code came from.',
    enum: ReferralSource,
    example: ReferralSource.LINK,
  })
  @IsOptional()
  @IsEnum(ReferralSource)
  referralSource?: ReferralSource;

  /**
   * From POST /auth/signup/verify-otp: proves the caller controls `phone`.
   * Must have been issued for that same number; spent once the profile
   * exists.
   */
  @ApiProperty({
    description:
      'Token returned by POST /auth/signup/verify-otp for this phone number.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  signupToken: string;
}
