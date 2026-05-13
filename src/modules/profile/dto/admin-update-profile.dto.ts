import { IsString, IsOptional, MaxLength, IsEmail } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
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
}
