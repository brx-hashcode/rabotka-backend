import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class RepublishJobOfferDto {
  @ApiPropertyOptional({
    description:
      'New start date/time, ISO 8601, at least 4 hours in the future. ' +
      'Required for a MISSION; a CDD, CDI or stage has none.',
    example: '2026-08-15T09:00:00.000Z',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La date doit être une date ISO 8601 valide' })
  scheduledAt?: string | null;
}
