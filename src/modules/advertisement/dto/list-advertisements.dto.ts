import { IsOptional, IsEnum, IsInt, IsUUID, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { AdStatus, BundleTargetAudience, DeliveryChannel } from '@prisma/client';

export class ListAdvertisementsDto {
  @IsOptional()
  @IsEnum(AdStatus)
  status?: AdStatus;

  @IsOptional()
  @IsUUID()
  bundleId?: string;

  @IsOptional()
  @IsEnum(BundleTargetAudience)
  targetAudience?: BundleTargetAudience;

  @IsOptional()
  @IsEnum(DeliveryChannel)
  channel?: DeliveryChannel;

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
