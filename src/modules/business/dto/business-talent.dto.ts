import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsIn,
  IsInt,
  Min,
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Keeping a worker, or editing what the business noted about them. */
export class SaveTalentDto {
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];
}

export class InviteTalentDto {
  @IsUUID()
  offerId!: string;
}

/** « Mes profils » search beyond Rabotka workers. */
export class PoolSearchDto {
  @IsIn(['external', 'cv'])
  source!: 'external' | 'cv';

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** Only those the business keeps. */
  @IsOptional()
  @IsBooleanString()
  kept?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
