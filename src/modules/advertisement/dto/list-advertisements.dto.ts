import { IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import {
  AdStatus,
  DeliveryChannel,
  TargetAudience,
} from '@prisma/client';

export class ListAdvertisementsDto {
  @IsOptional()
  @IsEnum(AdStatus)
  status?: AdStatus;

  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;

  @IsOptional()
  @IsEnum(TargetAudience)
  targetAudience?: TargetAudience;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
