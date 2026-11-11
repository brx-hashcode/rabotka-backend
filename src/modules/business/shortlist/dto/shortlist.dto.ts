import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

/** « Présélectionner la sélection »: Rabotka and careers-page candidatures of one offer. */
export class BulkShortlistDto {
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

  @ApiProperty({ description: 'true to shortlist, false to take them off' })
  @IsBoolean()
  shortlisted!: boolean;
}
