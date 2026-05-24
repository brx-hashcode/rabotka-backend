import { Type } from 'class-transformer';
import { IsPositive, IsOptional, IsString, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdminRecordMobileMoneyWithdrawalDto {
  @ApiProperty({ description: 'Amount to withdraw (FCFA)', example: 50000 })
  @Type(() => Number)
  @IsPositive()
  @Max(100_000_000)
  amount!: number;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description: 'External reference (bank transfer ID, etc.)',
  })
  @IsOptional()
  @IsString()
  reference?: string;
}
