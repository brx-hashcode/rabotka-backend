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
