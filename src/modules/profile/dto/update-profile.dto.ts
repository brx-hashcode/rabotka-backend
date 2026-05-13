import { Transform } from 'class-transformer';
import { IsString, IsOptional, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'First name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(50)
  firstName?: string;

  @ApiPropertyOptional({ description: 'Last name of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(50)
  lastName?: string;

  @ApiPropertyOptional({ description: 'Profile description / About me' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Address of the profile' })
  @Transform(({ value }) => value?.trim())
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;
}
