import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { MAX_CLAIM_ATTACHMENTS } from '../claim-attachment-key';

/**
 * A comment is text, or images, or both — but not nothing.
 *
 * `content` was required until images existed. Sending a photo with no caption
 * is the ordinary thing to do in a messaging thread, so requiring a word
 * alongside it would only teach people to type ".".
 */
export class CreateCommentDto {
  /**
   * Required unless at least one attachment is present. `@ValidateIf` rather
   * than `@IsOptional`: optional would let a caller send `{}` and create an
   * empty comment.
   */
  @ApiPropertyOptional({
    description: 'Comment body. Required unless attachment_urls is non-empty.',
  })
  @ValidateIf((o: CreateCommentDto) => !o.attachment_urls?.length)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  content?: string;

  /**
   * Urls returned by the claim attachment upload route. Validated against the
   * `claim-attachments/` prefix by `ClaimAttachmentService.assertValidUrls` —
   * the checks here only bound the shape.
   */
  @ApiPropertyOptional({ type: [String], maxItems: MAX_CLAIM_ATTACHMENTS })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAIM_ATTACHMENTS)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachment_urls?: string[];
}
