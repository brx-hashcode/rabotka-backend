import { IsOptional, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AdminWalletRevenueDto {
  @ApiPropertyOptional({
    description: 'Count payments created from this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  created_from?: string;

  @ApiPropertyOptional({
    description: 'Count payments created up to this date (ISO 8601)',
  })
  @IsOptional()
  @IsDateString()
  created_to?: string;
}
