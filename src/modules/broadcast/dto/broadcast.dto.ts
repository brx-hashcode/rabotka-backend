import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BroadcastStatus, DeliveryChannel } from '@prisma/client';
import { BROADCAST_MESSAGE_VAR_MAX } from '../../../common/constants/whatsapp-templates';
import { AudienceFiltersDto } from './audience-filters.dto';

const toArray = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.split(',').filter(Boolean) : value;

export class CreateBroadcastDto {
  @ApiProperty({ example: 'Maintenance planifiée' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  /**
   * Capped at the WhatsApp template's variable budget even for an in-app-only
   * broadcast, so the same draft can have a channel added later without its
   * message silently becoming unsendable.
   */
  @ApiProperty({ maxLength: BROADCAST_MESSAGE_VAR_MAX })
  @IsString()
  @IsNotEmpty()
  @MaxLength(BROADCAST_MESSAGE_VAR_MAX)
  body!: string;

  @ApiPropertyOptional({
    description: 'In-app path the CTA opens, without the host',
    example: 'recherche-offres',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  link?: string;

  @ApiProperty({ enum: DeliveryChannel, isArray: true })
  @Transform(toArray)
  @IsArray()
  @IsEnum(DeliveryChannel, { each: true })
  channels!: DeliveryChannel[];

  @ApiProperty({ type: AudienceFiltersDto })
  @ValidateNested()
  @Type(() => AudienceFiltersDto)
  audience!: AudienceFiltersDto;
}

export class UpdateBroadcastDto extends PartialType(CreateBroadcastDto) {}

export class PreviewAudienceDto {
  @ApiProperty({ type: AudienceFiltersDto })
  @ValidateNested()
  @Type(() => AudienceFiltersDto)
  audience!: AudienceFiltersDto;
}

export class SendBroadcastDto {
  @ApiPropertyOptional({
    description: 'When to start. Omit to send now.',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  scheduled_at?: Date;
}

export class ListBroadcastsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 10, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ enum: BroadcastStatus, isArray: true })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsEnum(BroadcastStatus, { each: true })
  status?: BroadcastStatus[];
}

export class ListRecipientsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @ApiPropertyOptional({ enum: DeliveryChannel })
  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;
}
