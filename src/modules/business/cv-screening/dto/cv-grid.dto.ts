import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LABEL_MAX, MAX_ASKED, MAX_FIT, MAX_MUST } from '../cv-grid';

export class CvGridAskedDto {
  @IsString()
  @MaxLength(LABEL_MAX)
  label: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  importance?: number;
}

export class CvGridItemDto {
  @IsIn(['FIT', 'MUST'])
  kind: 'FIT' | 'MUST';

  /** Of an item the grid already has; a new one gets its own. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  key?: string;

  @IsString()
  @MaxLength(20)
  family: string;

  @IsString()
  @MaxLength(LABEL_MAX)
  label: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  importance?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ASKED)
  @ValidateNested({ each: true })
  @Type(() => CvGridAskedDto)
  asked?: CvGridAskedDto[];

  /** EXPERIENCE: the months asked. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(360)
  months?: number;
}

export class CvGridDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_FIT + MAX_MUST)
  @ValidateNested({ each: true })
  @Type(() => CvGridItemDto)
  items: CvGridItemDto[];
}
