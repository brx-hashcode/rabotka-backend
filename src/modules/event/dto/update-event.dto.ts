import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DeliveryChannel } from '@prisma/client';
import { EventEditScope } from '../enums/event-edit-scope.enum';
import { RecurrenceDto } from './recurrence.dto';

export class UpdateEventDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  color?: string;

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
   * Which occurrences this edit reaches. Ignored on a one-off event.
   *
   * In the body rather than the query string because the admin client already
   * PATCHes a body here, and a query param would mean a second signature on
   * every call site.
   */
  @ApiPropertyOptional({ enum: EventEditScope, default: EventEditScope.THIS })
  @IsOptional()
  @IsEnum(EventEditScope)
  scope?: EventEditScope;

  /**
   * A new repeat rule for the series. Only meaningful alongside a scope of
   * THIS_AND_FOLLOWING or ALL — one occurrence has no rule of its own.
   */
  @ApiPropertyOptional({ type: RecurrenceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceDto)
  recurrence?: RecurrenceDto;
}
