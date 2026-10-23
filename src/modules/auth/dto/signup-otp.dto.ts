import {
  IsEmail,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';
import { REPORTABLE_STAGES } from '../../onboarding-attempt/onboarding-attempt.service';

/**
 * A sign-up proves a phone number (code on WhatsApp) or, for a business, an
 * email address (code by email) — one of the two, never both: which one was
 * proven decides whether the account is a business (see signup-token.ts).
 */
export class SignupSendOtpDto {
  @ApiPropertyOptional({
    description:
      'Phone number being registered (receives the WhatsApp code). Give this or `email`.',
    example: '+242069917686',
  })
  @ValidateIf((o: SignupSendOtpDto) => o.email === undefined)
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @ApiPropertyOptional({
    description:
      'Business sign-up: the email address being registered (receives the code). Give this or `phone`.',
    example: 'contact@entreprise.cg',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @ValidateIf((o: SignupSendOtpDto) => o.phone === undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  // Who is signing up, from the form they just filled. Optional and only
  // recorded on the sign-up attempt, so the team can reach someone who stops
  // before the end — nothing else reads them until the account is created.
  @ApiPropertyOptional({ example: 'Awa' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Mabiala' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ enum: ProfileType })
  @IsOptional()
  @IsEnum(ProfileType)
  profileType?: ProfileType;
}

/** The app reporting a sign-up screen it reached, past the number check. */
export class SignupProgressDto {
  @ApiProperty({ enum: REPORTABLE_STAGES })
  @IsIn(REPORTABLE_STAGES)
  stage: (typeof REPORTABLE_STAGES)[number];

  @ApiPropertyOptional({ enum: ProfileType })
  @IsOptional()
  @IsEnum(ProfileType)
  profileType?: ProfileType;
}

export class SignupVerifyOtpDto {
  @ApiPropertyOptional({ example: '+242069917686' })
  @ValidateIf((o: SignupVerifyOtpDto) => o.email === undefined)
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @ApiPropertyOptional({ example: 'contact@entreprise.cg' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @ValidateIf((o: SignupVerifyOtpDto) => o.phone === undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiProperty({
    description: '6-digit code received on WhatsApp, or by email',
    example: '123456',
  })
  @IsString()
  @Length(6, 6, { message: 'Le code doit contenir 6 chiffres' })
  @Matches(/^\d{6}$/, { message: 'Le code doit contenir 6 chiffres' })
  code: string;
}
