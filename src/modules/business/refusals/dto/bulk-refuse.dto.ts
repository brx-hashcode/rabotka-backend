import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** Refuse some applications, or every one still waiting, with one message. */
export class BulkRefuseDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  applicationIds?: string[];

  @ApiPropertyOptional({
    description: 'Every application still waiting on the offer',
  })
  @IsOptional()
  @IsBoolean()
  remaining?: boolean;

  @ApiPropertyOptional({
    description: 'Shown to each candidate; no contact details',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
