import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  IsUUID,
  IsOptional,
  IsArray,
} from 'class-validator';

export class CreateClaimDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  description: string;

  @ApiProperty()
  @IsUUID()
  profile_id: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachment_urls?: string[] = [];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_user_id?: string;
}
