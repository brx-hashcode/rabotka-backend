import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class RepublishJobOfferDto {
  @ApiProperty({
    description:
      'New start date/time, ISO 8601. Must be at least 4 hours in the future.',
    example: '2026-08-15T09:00:00.000Z',
  })
  @IsDateString(
    {},
    { message: 'La date doit être une date ISO 8601 valide' },
  )
  scheduledAt: string;
}
