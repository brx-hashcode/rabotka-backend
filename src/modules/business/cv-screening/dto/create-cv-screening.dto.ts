import { ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

/** One attachment ticked in a connected mailbox. */
export class MailAttachmentRefDto {
  @IsUUID()
  mailboxId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  messageId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  attachmentId: string;
}

/**
 * The job the CVs are read against, sent with the files (multipart): one of
 * the business's offers, or a title and description written for the occasion.
 */
export class CreateCvScreeningDto {
  @ApiPropertyOptional({ description: 'One of the business’s offers' })
  @Transform(trim)
  @IsOptional()
  @IsUUID()
  offerId?: string;

  @ApiPropertyOptional({ description: 'When no offer: the job title' })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  jobTitle?: string;

  @ApiPropertyOptional({
    description: 'When no offer: the missions and the profile sought',
  })
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  jobText?: string;

  @ApiPropertyOptional({
    description:
      'CVs ticked in a connected mailbox, as JSON: `[{ mailboxId, messageId, attachmentId }]`',
  })
  @Transform(({ value }: { value: unknown }) => {
    // Multipart sends it as text; @Transform wins over @Type, so the
    // instances the nested validation needs are made here.
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return Array.isArray(parsed)
      ? plainToInstance(MailAttachmentRefDto, parsed as object[])
      : parsed;
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => MailAttachmentRefDto)
  mailAttachments?: MailAttachmentRefDto[];
}

/** One question about an analysed CV. */
export class CvChatQuestionDto {
  @ApiPropertyOptional({ description: 'The question, in plain words' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  question: string;
}

/** The CVs of one screening to compare in a conversation. */
export class CvCompareDto {
  @ApiPropertyOptional({ type: [String], description: '2 to 5 scored CVs' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  resumeIds: string[];
}
