import { Transform } from 'class-transformer';
import {
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Structured location, shared by profiles and job offers.
 *
 * All three are optional everywhere, including on create. The columns are new
 * and clients update independently of the API, so a build that predates the
 * pickers must still work — a required field here would lock those users out
 * of signing up or posting at all, which is far worse than a record with no
 * city.
 *
 * Only the *shape* is checked here. Whether the code is a country we know, and
 * whether the city belongs to it, is resolved against `GeoService` in the
 * services — class-validator has no access to the reference list.
 */
export class LocationDto {
  @ApiPropertyOptional({
    description: 'ISO 3166-1 alpha-2 country code',
    example: 'CG',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsISO31661Alpha2()
  countryCode?: string;

  @ApiPropertyOptional({
    description: 'Display name of the country',
    example: 'Congo-Brazzaville',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(100)
  countryName?: string;

  @ApiPropertyOptional({ description: 'City', example: 'Brazzaville' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;
}
