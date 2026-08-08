import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentRequestStatus } from '@prisma/client';
import { ToBoolean } from '../../../common/utils/query-boolean.util';

export class ListPaymentRequestsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ enum: PaymentRequestStatus })
  @IsOptional()
  @IsEnum(PaymentRequestStatus)
  status?: PaymentRequestStatus;

  @ApiPropertyOptional({
    description:
      'When true, list archived (soft-deleted) rows instead of active',
  })
  @IsOptional()
  @ToBoolean(false)
  @IsBoolean()
  deleted?: boolean;
}
