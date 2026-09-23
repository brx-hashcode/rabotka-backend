import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const MESSAGE_MAX_LENGTH = 2_000;

export class SendMessageDto {
  @ApiProperty({ maxLength: MESSAGE_MAX_LENGTH })
  // Trimmed BEFORE validation, so "   " becomes "" and `IsNotEmpty` catches
  // it. On its own that decorator only rejects empty, null and undefined —
  // whitespace sails through, and a message of three spaces would have been
  // stored, moderated, pushed and notified.
  //
  // Before moderation too, which matters: the offsets are computed on whatever
  // is stored, so trimming after would shift every one of them by the leading
  // whitespace.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX_LENGTH)
  body!: string;
}

/**
 * The one inbound socket payload this module accepts.
 *
 * A single validated uuid and nothing else — no body, no flag, nothing that
 * gets stored. `ProfileChatGateway` applies a `ValidationPipe` by hand, since
 * the global one does not reach gateways; see the note at the top of that file
 * for why an inbound handler is allowed here at all.
 */
export class TypingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;
}

export class ReportRedactionDto {
  @ApiPropertyOptional({
    description: 'Why the sender believes the detection was wrong',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListConversationsDto {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  /**
   * rabotka-client's cache-buster (`RabotkaBaseController`), sent on EVERY GET.
   *
   * Declared only so the global `forbidNonWhitelisted` does not 400 the whole
   * screen; never read. `ListProfileNotificationsDto` carries the same field
   * for the same reason — any new `@Query()` DTO reached from that client
   * needs it, and its absence fails at runtime rather than at compile time.
   */
  @ApiPropertyOptional({ description: 'Cache-buster, ignored' })
  @IsOptional()
  @IsString()
  _?: string;
}

export class ListMessagesDto {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  /** Larger than the conversation list: a thread is read, not scanned. */
  @ApiPropertyOptional({ description: 'Items per page', default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  /**
   * rabotka-client's cache-buster (`RabotkaBaseController`), sent on EVERY GET.
   *
   * Declared only so the global `forbidNonWhitelisted` does not 400 the whole
   * screen; never read. `ListProfileNotificationsDto` carries the same field
   * for the same reason — any new `@Query()` DTO reached from that client
   * needs it, and its absence fails at runtime rather than at compile time.
   */
  @ApiPropertyOptional({ description: 'Cache-buster, ignored' })
  @IsOptional()
  @IsString()
  _?: string;
}
