import {
  IsString,
  IsOptional,
  MaxLength,
  IsEmail,
  IsEnum,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';
import { UpdateProfileDto } from './update-profile.dto';

export class AdminUpdateProfileDto extends UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Phone number of the profile' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  // `directPhone` is inherited from UpdateProfileDto, unlike `phone` above —
  // that one exists here only because the user-facing DTO deliberately omits it
  // (changing a login identity needs an OTP round-trip; an admin override does
  // not). A direct line has no such asymmetry, so redeclaring it would just be
  // a second copy of the same validators to drift from.

  @ApiPropertyOptional({ description: 'Email of the profile' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    enum: ProfileType,
    description: 'Profile type (WORKER/EMPLOYER) — triggers a vector re-index',
  })
  @IsOptional()
  @IsEnum(ProfileType)
  profileType?: ProfileType;
}
