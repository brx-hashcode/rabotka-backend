import {
  IsString,
  IsNumber,
  IsInt,
  IsArray,
  IsEnum,
  IsOptional,
  IsBoolean,
  Min,
  MinLength,
} from 'class-validator';
import { DeliveryChannel } from '@prisma/client';

export enum BundleChannel {
  EMAIL = 'EMAIL',
  WHATSAPP = 'WHATSAPP',
  BOTH = 'BOTH',
}

export function expandBundleChannels(
  channels: BundleChannel[],
): DeliveryChannel[] {
  const result = new Set<DeliveryChannel>();
  for (const ch of channels) {
    if (ch === BundleChannel.BOTH) {
      result.add(DeliveryChannel.EMAIL);
      result.add(DeliveryChannel.WHATSAPP);
    } else {
      result.add(ch as unknown as DeliveryChannel);
    }
  }
  return Array.from(result);
}

export class CreateBundleDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  @MinLength(10)
  description: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsInt()
  @Min(1)
  maxReach: number;

  @IsInt()
  @Min(1)
  maxFrequencyPerWeek: number;

  @IsInt()
  @Min(1)
  maxDurationDays: number;

  @IsArray()
  @IsEnum(BundleChannel, { each: true })
  allowedChannels: BundleChannel[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
