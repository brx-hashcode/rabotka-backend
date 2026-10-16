import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Sending money from the gateway account to a mobile-money number. */
export class AdminSendPayoutDto {
  @ApiProperty({
    description:
      'Generated once per dialog. Sending the same id again returns the payout already made.',
  })
  @IsUUID()
  clientRequestId!: string;

  @ApiProperty({ example: 50000, description: 'Whole francs (XAF).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  amount!: number;

  @ApiProperty({
    description: 'The amount typed a second time, as confirmation.',
  })
  @Type(() => Number)
  @IsInt()
  confirmAmount!: number;

  @ApiProperty({ example: '+242061234567' })
  @IsString()
  @Matches(/^\+?\d{8,15}$/, { message: 'Numéro de téléphone invalide.' })
  phone!: string;

  @ApiProperty({ example: 'MTN_MOMO_COG' })
  @IsString()
  @MaxLength(40)
  operator!: string;

  @ApiPropertyOptional({ example: 'Retrait trésorerie octobre' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class AdminListPayoutsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ enum: ['PENDING', 'COMPLETED', 'FAILED'] })
  @IsOptional()
  @Matches(/^(PENDING|COMPLETED|FAILED)$/)
  status?: 'PENDING' | 'COMPLETED' | 'FAILED';
}
