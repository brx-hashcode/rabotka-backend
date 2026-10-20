import {
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';
import { REPORTABLE_STAGES } from '../../onboarding-attempt/onboarding-attempt.service';

export class SignupSendOtpDto {
  @ApiProperty({
    description: 'Phone number being registered (receives the WhatsApp code)',
    example: '+242069917686',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;

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
  @ApiProperty({ example: '+242069917686' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: '6-digit code received on WhatsApp',
    example: '123456',
  })
  @IsString()
  @Length(6, 6, { message: 'Le code doit contenir 6 chiffres' })
  @Matches(/^\d{6}$/, { message: 'Le code doit contenir 6 chiffres' })
  code: string;
}
