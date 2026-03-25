import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  IsUUID,
  IsOptional,
  IsArray,
  IsEnum,
} from 'class-validator';
import { ClaimStatus } from '@prisma/client';

export class UpdateClaimDto {
  @ApiPropertyOptional({ enum: ClaimStatus })
  @IsOptional()
  @IsEnum(ClaimStatus)
  status?: ClaimStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachment_urls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_user_id?: string | null;
}
