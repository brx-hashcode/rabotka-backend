import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** CSV or repeated query param → string[]. Mirrors the other admin list DTOs. */
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export const CONVERSATION_STATUSES = ['OPEN', 'CLOSED'] as const;
export type ConversationStatusFilter = (typeof CONVERSATION_STATUSES)[number];

/**
 * The triage filters. Each one answers a question a moderator actually arrives
 * with, rather than exposing a column.
 */
export const CONVERSATION_FLAGS = [
  /** Holds at least one message that was withheld whole and never delivered. */
  'HELD',
  /** Holds at least one message something was cut out of. */
  'REDACTED',
  /** An author has contested a redaction and nobody has ruled on it yet. */
  'REPORTED',
  /** No application behind it: cold outreach to somebody who never applied. */
  'DIRECT',
] as const;
export type ConversationFlag = (typeof CONVERSATION_FLAGS)[number];

export class AdminListConversationsDto {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({
    description: 'Search in worker name, employer name, job title',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'OPEN (still writable) or CLOSED',
    enum: CONVERSATION_STATUSES,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(CONVERSATION_STATUSES, { each: true })
  status?: ConversationStatusFilter[];

  @ApiPropertyOptional({
    description:
      'Moderation flags. Several are AND-ed: a conversation must satisfy every one asked for.',
    enum: CONVERSATION_FLAGS,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsIn(CONVERSATION_FLAGS, { each: true })
  flags?: ConversationFlag[];

  @ApiPropertyOptional({ description: 'Filter by worker profile ID' })
  @IsOptional()
  @IsUUID()
  worker_id?: string;

  @ApiPropertyOptional({ description: 'Filter by employer profile ID' })
  @IsOptional()
  @IsUUID()
  employer_id?: string;

  @ApiPropertyOptional({
    description: 'Only conversations active at or after this date (ISO 8601)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  since?: Date;

  @ApiPropertyOptional({
    description: 'Only conversations active before this date (ISO 8601)',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  until?: Date;
}
