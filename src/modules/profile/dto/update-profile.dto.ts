import { Transform } from 'class-transformer';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus } from '@prisma/client';

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'First name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ description: 'Last name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ description: 'Profile description / About me' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Address of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({
    description: 'Account status',
    enum: AccountStatus,
  })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiPropertyOptional({ description: 'Phone number of the profile' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ description: 'Email of the profile' })
  @IsOptional()
  @IsString()
  email?: string;
}
