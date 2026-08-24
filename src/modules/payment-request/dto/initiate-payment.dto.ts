import {
  IsString,
  IsOptional,
  IsIn,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { listPaymentGatewayMetadata } from '../../../common/services/payment/payment-gateway.registry';

/**
 * Every operator code any registered gateway accepts.
 *
 * The DTO can only check the value is a code some gateway knows — whether it is
 * the code the *active* gateway needs depends on runtime config, so that check
 * belongs to the service (`assertOperatorMatchesGateway`). Built from the
 * registry so a new provider's networks are accepted without touching this file.
 */
export const KNOWN_PAYMENT_OPERATORS: string[] = listPaymentGatewayMetadata()
  .flatMap((gateway) => gateway.operators)
  .map((operator) => operator.code);

export class InitiatePaymentDto {
  @ApiProperty({ example: '069917686' })
  @IsString()
  @MinLength(7)
  @MaxLength(15)
  @Matches(/^\+?\d+$/, { message: 'phone must contain only digits' })
  phone!: string;

  @ApiPropertyOptional({
    description:
      'Mobile-money operator code. Required by gateways that route by network, omitted by gateways that serve a single one — see GET /payment-requests/gateways.',
    example: 'CG_MTNMOBILEMONEY',
    enum: KNOWN_PAYMENT_OPERATORS,
  })
  @IsOptional()
  @IsIn(KNOWN_PAYMENT_OPERATORS)
  operator?: string;
}
