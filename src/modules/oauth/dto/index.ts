import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  MinLength,
  IsInt,
  Max,
  Min,
} from 'class-validator';
import { OAuthAppStatus, PartnerApiCallKind } from '@prisma/client';
import { Type } from 'class-transformer';
import { REGISTRABLE_SCOPES, WEBHOOK_URL_MAX_LENGTH } from '../oauth.constants';

export class SendInteractionOtpDto {
  @ApiProperty({ example: '+237690000000' })
  @IsString()
  @Length(8, 20)
  phone!: string;
}

export class VerifyInteractionOtpDto {
  @ApiProperty({ example: '+237690000000' })
  @IsString()
  @Length(8, 20)
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Length(6, 6)
  otp!: string;
}

export class ConsentDecisionDto {
  @ApiProperty({
    description:
      'true grants the requested scopes, false returns access_denied to the application.',
  })
  @IsBoolean()
  approve!: boolean;
}

/**
 * The token endpoint takes `application/x-www-form-urlencoded`, not JSON, and
 * its field names are snake_case — both fixed by RFC 6749 §4.1.3. Every OAuth
 * client on every platform sends it this way, so this DTO matches the spec
 * rather than the codebase's camelCase house style.
 */
export class TokenRequestDto {
  @ApiProperty({ example: 'authorization_code' })
  @IsString()
  @IsIn(['authorization_code'])
  grant_type!: string;

  @ApiProperty()
  @IsString()
  code!: string;

  @ApiProperty()
  @IsString()
  redirect_uri!: string;

  @ApiProperty({
    description: 'The PKCE verifier for the challenge sent to /authorize.',
  })
  @IsString()
  @Length(43, 128)
  code_verifier!: string;

  @ApiPropertyOptional({
    description:
      'Only when authenticating with client_secret_post. Prefer HTTP Basic (client_secret_basic).',
  })
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  client_secret?: string;
}

export class RevokeTokenDto {
  @ApiProperty()
  @IsString()
  token!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  client_secret?: string;

  @ApiPropertyOptional({ example: 'access_token' })
  @IsOptional()
  @IsString()
  token_type_hint?: string;
}

export class CreateOAuthAppDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ description: 'Shown to the user on the consent screen.' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  description!: string;

  @ApiProperty()
  @IsEmail()
  contactEmail!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  logoUrl?: string;

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Exact-match allowlist. Each URI must be written out in full — no ' +
      'wildcards. Required unless the app is registered for identity checks only.',
  })
  @IsOptional()
  @IsArray()
  // A cap, because every one of these is compared on every authorize request
  // and because a partner needing more than ten callbacks has an architecture
  // question, not a registration question.
  @ArrayMaxSize(10)
  @IsString({ each: true })
  redirectUris?: string[];

  @ApiPropertyOptional({ isArray: true, enum: REGISTRABLE_SCOPES })
  @IsOptional()
  @IsArray()
  @IsIn(REGISTRABLE_SCOPES, { each: true })
  allowedScopes?: string[];

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Where identity-check results are POSTed. Required when ' +
      '`rabotka:identity_check` is allowed; https only (http://localhost for ' +
      'sandbox apps). Empty string or null removes it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(WEBHOOK_URL_MAX_LENGTH)
  webhookUrl?: string | null;

  @ApiPropertyOptional({
    default: false,
    description:
      'Sandbox application. Authenticates only the two hardcoded Rabotka ' +
      'sandbox users with a fixed OTP, never a real profile. Cannot be ' +
      'changed after creation.',
  })
  @IsOptional()
  @IsBoolean()
  isSandbox?: boolean;
}

export class UpdateOAuthAppDto {
  // `isSandbox` is deliberately absent, and its absence is the enforcement:
  // `main.ts` validates with `forbidNonWhitelisted: true`, so a PATCH carrying
  // the field is a 400 rather than a silently ignored no-op. See the note on
  // the column in schema.prisma for why it must never change.

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  logoUrl?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  redirectUris?: string[];

  @ApiPropertyOptional({ isArray: true, enum: REGISTRABLE_SCOPES })
  @IsOptional()
  @IsArray()
  @IsIn(REGISTRABLE_SCOPES, { each: true })
  allowedScopes?: string[];

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Where identity-check results are POSTed. Required when ' +
      '`rabotka:identity_check` is allowed; https only (http://localhost for ' +
      'sandbox apps). Empty string or null removes it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(WEBHOOK_URL_MAX_LENGTH)
  webhookUrl?: string | null;

  @ApiPropertyOptional({ enum: OAuthAppStatus })
  @IsOptional()
  @IsEnum(OAuthAppStatus)
  status?: OAuthAppStatus;
}

export class ListPartnerRequestsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: PartnerApiCallKind })
  @IsOptional()
  @IsEnum(PartnerApiCallKind)
  kind?: PartnerApiCallKind;
}
