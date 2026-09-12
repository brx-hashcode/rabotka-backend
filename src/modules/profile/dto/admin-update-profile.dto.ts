import { IsString, IsOptional, MaxLength, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProfileType } from '@prisma/client';
import { UpdateProfileDto } from './update-profile.dto';

export class AdminUpdateProfileDto extends UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Phone number of the profile' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  // `directPhone` and `email` are inherited from UpdateProfileDto, unlike
  // `phone` above — that one exists here only because the user-facing DTO
  // deliberately omits it (changing a login identity needs an OTP round-trip;
  // an admin override does not). Neither of the other two has such an
  // asymmetry, so redeclaring them would just be a second copy of the same
  // validators to drift from.
  //
  // `email` used to be redeclared here with `@IsOptional() @IsEmail()` alone —
  // no lowercase transform and no MX check, both of which the signup path
  // applies. Since the unique index is case-sensitive, that let an admin write
  // `Alice@x.com` alongside an existing `alice@x.com` and create the duplicate
  // account the constraint exists to prevent. Inheriting fixes it by removal.

  @ApiPropertyOptional({
    enum: ProfileType,
    description: 'Profile type (WORKER/EMPLOYER) — triggers a vector re-index',
  })
  @IsOptional()
  @IsEnum(ProfileType)
  profileType?: ProfileType;
}
