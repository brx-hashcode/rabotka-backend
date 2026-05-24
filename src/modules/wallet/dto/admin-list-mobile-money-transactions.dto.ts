import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  IsDateString,
  IsEnum,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { WalletTransactionType } from '@prisma/client';

const MM_TYPES = [
  WalletTransactionType.MOBILE_MONEY_CREDIT,
  WalletTransactionType.MOBILE_MONEY_WITHDRAWAL,
] as const;

export class AdminListMobileMoneyTransactionsDto {
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
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Filter by operator code (e.g. CG_MTNMOBILEMONEY)',
  })
  @IsOptional()
  @IsString()
  operator?: string;

  @ApiPropertyOptional({
    description: 'Filter by gateway (e.g. MONETBIL, MTN_MOMO)',
  })
  @IsOptional()
  @IsString()
  gateway?: string;

  @ApiPropertyOptional({
    description: 'Filter by transaction type',
    enum: MM_TYPES,
  })
  @IsOptional()
  @IsEnum(MM_TYPES)
  type?: (typeof MM_TYPES)[number];

  @ApiPropertyOptional({ description: 'Filter from date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  created_from?: string;

  @ApiPropertyOptional({ description: 'Filter up to date (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  created_to?: string;
}
