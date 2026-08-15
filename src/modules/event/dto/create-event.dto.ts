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

  @ApiProperty({ description: 'ISO 8601 datetime' })
  @IsDateString()
  endDate: string;

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
