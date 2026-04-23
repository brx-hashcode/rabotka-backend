import {
  IsOptional,
  IsArray,
  IsString,
  IsInt,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AgeRangeDto {
  @IsInt()
  @Min(16)
  min: number;

  @IsInt()
  @Max(99)
  max: number;
}

export class TargetFiltersDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sectors?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  cities?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  minExperienceYears?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxExperienceYears?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AgeRangeDto)
  ageRange?: AgeRangeDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contractTypes?: string[];
}
