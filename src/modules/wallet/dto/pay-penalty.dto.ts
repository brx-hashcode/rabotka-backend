import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';

export class PayPenaltyDto {
  @ApiProperty({
    description: 'Optional external/gateway reference for client reconciliation. Backend generates RBK reference as transaction_id.',
    example: 'gateway_txn_abc123',
    required: false,
  })
  @IsOptional()
  @IsString()
  transactionId?: string;

  @ApiProperty({
    description: 'Payment method used',
    enum: PaymentMethod,
    example: PaymentMethod.MOBILE_MONEY,
  })
  @IsEnum(PaymentMethod)
  paymentMethod: PaymentMethod;
}
