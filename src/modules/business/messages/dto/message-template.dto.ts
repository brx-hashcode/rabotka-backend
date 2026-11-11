import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessMessageKind } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export const TEMPLATE_TITLE_MAX = 60;
export const TEMPLATE_BODY_MAX = 1000;

/** A « Modèle de message »: written once, sent again. */
export class MessageTemplateDto {
  @ApiProperty({ enum: BusinessMessageKind })
  @IsEnum(BusinessMessageKind)
  kind!: BusinessMessageKind;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(TEMPLATE_TITLE_MAX)
  title!: string;

  @ApiProperty({
    description: 'May use {prenom}, {poste} and {entreprise}',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(TEMPLATE_BODY_MAX)
  body!: string;
}

/** One message to several candidatures of an offer. */
export class BulkMessageDto {
  @ApiPropertyOptional({ type: [String], description: 'Rabotka applications' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  rabotka?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Careers-page applications',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  external?: string[];

  @ApiProperty({
    description: 'May use {prenom}, {poste} and {entreprise}',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(TEMPLATE_BODY_MAX)
  body!: string;
}
