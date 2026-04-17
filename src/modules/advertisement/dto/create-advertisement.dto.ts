import {
  IsString,
  IsOptional,
  IsUrl,
  IsArray,
  IsEnum,
  IsIn,
  IsUUID,
  IsDateString,
  MinLength,
  MaxLength,
  IsPhoneNumber,
  IsEmail,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AdvertiserType } from '@prisma/client';
import { TargetFiltersDto } from './target-filters.dto';

export class CreateAdvertisementDto {
  @IsString()
  @MinLength(5)
  @MaxLength(100)
  title: string;

  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  description: string;

  @IsOptional()
  @IsString()
  callToAction?: string;

  @IsOptional()
  @IsUrl()
  ctaUrl?: string;

  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsUrl()
  videoUrl?: string;

  @IsOptional()
  @IsUrl()
  bannerUrl?: string;

  @IsOptional()
  @IsUrl()
  logoUrl?: string;

  @IsOptional()
  @IsPhoneNumber()
  contactPhone?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  sector?: string;

  @IsEnum(AdvertiserType)
  advertiserType: AdvertiserType;

  @IsOptional()
  @IsIn(['fr', 'en'])
  language?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsUUID()
  bundleId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TargetFiltersDto)
  targetFilters?: TargetFiltersDto;
}
