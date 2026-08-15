import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListEventsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  // Raised from 500 now that `from`/`to` bound the result set. A year view of a
  // daily series is legitimately more than 500 rows, and the old cap truncated
  // it silently — by start_date asc, so the *newest* events were the ones that
  // disappeared.
  @ApiPropertyOptional({ default: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  limit?: number = 500;

  /**
   * Visible window. Both or neither — one alone is ignored, so a caller cannot
   * accidentally ask for "everything after March" and get an unbounded scan.
   *
   * Optional so existing callers (and the Swagger explorer) keep the previous
   * "return everything" behaviour.
   */
  @ApiPropertyOptional({
    description: 'ISO 8601 — inclusive lower bound of the visible window',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 — inclusive upper bound of the visible window',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}
