import { IsOptional, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum TimeRange {
  NINETY_DAYS = '90d',
  THIRTY_DAYS = '30d',
  SEVEN_DAYS = '7d',
}

export class JobActivityQueryDto {
  @ApiPropertyOptional({
    description: 'Time range for the chart',
    enum: TimeRange,
    default: TimeRange.NINETY_DAYS,
  })
  @IsOptional()
  @IsEnum(TimeRange)
  range?: TimeRange = TimeRange.NINETY_DAYS;
}
