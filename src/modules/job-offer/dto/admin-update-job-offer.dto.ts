import {
  IsOptional,
  IsString,
  IsNumber,
  IsInt,
  IsEnum,
  IsDateString,
  Min,
  Max,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentFlow } from '@prisma/client';

export class AdminUpdateJobOfferDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(100)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(1000000)
  amount?: number | null;

  @ApiPropertyOptional({ enum: PaymentFlow })
  @IsOptional()
  @IsEnum(PaymentFlow)
  paymentFlow?: PaymentFlow | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(10)
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;
}
