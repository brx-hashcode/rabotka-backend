import { Transform, Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsArray,
  IsEnum,
  IsDateString,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MessageDirection, WhatsappDeliveryStatus } from '@prisma/client';

/**
 * Query contract for the WhatsApp delivery log.
 *
 * Every filter has to be declared here: `forbidNonWhitelisted: true` is set on
 * the global ValidationPipe, so an undeclared query param is a 400 rather than
 * a silently ignored filter.
 */

/** Array filters arrive as repeated params or as one CSV string. */
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

export class AdminListWhatsappMessagesDto {
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

  @ApiPropertyOptional({
    description:
      'Search in recipient phone, body, template key and provider message id',
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: 'Filter by delivery status',
    enum: WhatsappDeliveryStatus,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(WhatsappDeliveryStatus, { each: true })
  status?: WhatsappDeliveryStatus[];

  @ApiPropertyOptional({
    description: 'Filter by logical template key, e.g. "kyc"',
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  template_key?: string[];

  @ApiPropertyOptional({
    description: 'Filter by message kind: text | template | media | flow',
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  kind?: string[];

  @ApiPropertyOptional({
    description: 'Filter by direction',
    enum: MessageDirection,
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsEnum(MessageDirection, { each: true })
  direction?: MessageDirection[];

  @ApiPropertyOptional({
    description: 'Filter by sending provider: cloud | twilio',
    isArray: true,
  })
  @IsOptional()
  @Transform(({ value }) => toArray(value))
  @IsArray()
  @IsString({ each: true })
  provider?: string[];

  @ApiPropertyOptional({ description: 'Only this profile’s messages' })
  @IsOptional()
  @IsString()
  profile_id?: string;

  @ApiPropertyOptional({
    description: 'Messages created from this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  created_from?: string;

  @ApiPropertyOptional({
    description: 'Messages created up to this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  created_to?: string;
}

/** Window selector shared by the stats and billing endpoints. */
export class AdminWhatsappRangeDto {
  @ApiPropertyOptional({ description: 'Window start (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  created_from?: string;

  @ApiPropertyOptional({ description: 'Window end (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  created_to?: string;
}
