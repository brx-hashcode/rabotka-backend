import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Shared by the profile's own feed and the admin view of it. */
export class ListProfileNotificationsDto {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Items per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;

  /**
   * rabotka-client's cache-buster (`RabotkaBaseController.bustCache`), sent on
   * every GET. Declared only so `forbidNonWhitelisted` does not 400 the feed;
   * never read.
   */
  @ApiPropertyOptional({ description: 'Cache-buster, ignored' })
  @IsOptional()
  @IsString()
  _?: string;
}
