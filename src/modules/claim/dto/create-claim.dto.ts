import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  MinLength,
  MaxLength,
  IsUUID,
  IsOptional,
  IsArray,
  ArrayMaxSize,
} from 'class-validator';
import { MAX_CLAIM_ATTACHMENTS } from '../claim-attachment-key';

export class CreateClaimDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  title: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  description: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  profile_id?: string;

  /**
   * Urls returned by `POST /profile/claims/attachments` (or its admin twin).
   * Only images, and only ones we stored — enforced by
   * `ClaimAttachmentService.assertValidUrls`, which the shape checks here
   * cannot express.
   */
  @ApiPropertyOptional({ type: [String], maxItems: MAX_CLAIM_ATTACHMENTS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAIM_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachment_urls?: string[] = [];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigned_user_id?: string;
}
