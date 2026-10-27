import { PartialType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BusinessBillingPeriod } from '@prisma/client';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** A plan as the admin edits it. Null quota: unlimited. */
export class CreateBusinessPlanDto {
  @ApiProperty({
    example: 'pro',
    description: 'Stable code (lowercase, digits, dashes)',
  })
  @Transform(trim)
  @Matches(/^[a-z0-9-]{2,40}$/, {
    message: 'Code : lettres minuscules, chiffres et tirets (2 à 40).',
  })
  code: string;

  @ApiProperty({ example: 'Pro' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional()
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty()
  @IsInt()
  @Min(0)
  monthlyPriceFcfa: number;

  @ApiProperty()
  @IsInt()
  @Min(0)
  annualPriceFcfa: number;

  @ApiPropertyOptional({ nullable: true, description: 'Null: unlimited' })
  @IsOptional()
  @IsInt()
  @Min(0)
  unlocksPerPeriod?: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Null: unlimited' })
  @IsOptional()
  @IsInt()
  @Min(0)
  activeOffersLimit?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'CVs the AI screening reads per period. Null: unlimited; 0: not included',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  cvScreeningsPerPeriod?: number | null;

  @ApiPropertyOptional({ description: 'CVs in one screening' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  cvBatchMax?: number;

  @ApiPropertyOptional({ description: 'Largest CV file, in MB' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  cvFileMaxMb?: number;

  @ApiPropertyOptional({
    description: 'Days a screening keeps its files and contact details',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  cvRetentionDays?: number;

  @ApiPropertyOptional({
    description: 'Questions a business may ask about one analysed CV',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(200)
  cvChatQuestions?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includesPreselection?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includesFieldAgents?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  priorityVisibility?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateBusinessPlanDto extends PartialType(CreateBusinessPlanDto) {}

/** Buying (business) or granting (admin) a period of a plan. */
export class SubscribeDto {
  @ApiProperty()
  @IsUUID()
  planId: string;

  @ApiProperty({ enum: ['MONTHLY', 'ANNUAL'] })
  @IsEnum(BusinessBillingPeriod)
  @IsIn(['MONTHLY', 'ANNUAL'])
  billingPeriod: BusinessBillingPeriod;
}
