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
  @IsEnum(DeliveryChannel, { each: true })
  allowedChannels: DeliveryChannel[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
