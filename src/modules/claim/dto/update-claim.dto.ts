import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  MaxLength,
  IsUUID,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  IsEnum,
} from 'class-validator';
import { ClaimStatus } from '@prisma/client';
import { MAX_CLAIM_ATTACHMENTS } from '../claim-attachment-key';

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

  /** Replaces the array wholesale. Same validation as on create. */
  @ApiPropertyOptional({ type: [String], maxItems: MAX_CLAIM_ATTACHMENTS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAIM_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachment_urls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_user_id?: string | null;
}
