import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryChannel } from '@prisma/client';
import { DEFAULT_EVENT_DURATION_MINUTES } from '../utils/event-window.util';
import { RecurrenceDto } from './recurrence.dto';

export class CreateEventDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ description: 'ISO 8601 datetime' })
  @IsDateString()
  startDate: string;

  /**
   * When this occurrence finishes — not when a repeating event stops repeating,
   * which is the recurrence's own `until`/`count`. Omit it for a
   * {@link DEFAULT_EVENT_DURATION_MINUTES}-minute event: there is no way to
   * express "this occurrence never ends", and an end date decades out is not
   * one, it is an event that covers every day in between.
   */
  @ApiPropertyOptional({
    description: `ISO 8601 datetime. Defaults to ${DEFAULT_EVENT_DURATION_MINUTES} minutes after startDate.`,
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiProperty({
    description: 'Event color: blue | green | red | yellow | purple | orange',
  })
  @IsString()
  @IsNotEmpty()
  color: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Type(() => String)
  profileIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Type(() => String)
  userIds?: string[];

  @ApiPropertyOptional({
    enum: DeliveryChannel,
    default: DeliveryChannel.EMAIL,
  })
  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;

  /**
   * Omit for a one-off event. When present, `startDate`/`endDate` describe the
   * first occurrence and the rest are generated from it.
   */
  @ApiPropertyOptional({ type: RecurrenceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceDto)
  recurrence?: RecurrenceDto;
}
