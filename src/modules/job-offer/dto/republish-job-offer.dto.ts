import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class RepublishJobOfferDto {
  @ApiPropertyOptional({
    description:
      "New date applications close (the mission's start), ISO 8601, still to come. " +
      'Required for a MISSION; a CDD, CDI or stage has none.',
    example: '2026-08-15T09:00:00.000Z',
  })
  @IsOptional()
  @IsDateString({}, { message: 'La date doit être une date ISO 8601 valide' })
  scheduledAt?: string | null;
}
