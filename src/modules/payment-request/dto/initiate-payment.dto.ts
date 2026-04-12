import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export const MONETBIL_OPERATORS = [
  'CG_MTNMOBILEMONEY',
  'CG_AIRTELMONEY',
] as const;

export type MonetbilOperator = (typeof MONETBIL_OPERATORS)[number];

export class InitiatePaymentDto {
  @ApiProperty({ example: '069917686' })
  @IsString()
  phone!: string;

  @ApiProperty({ enum: MONETBIL_OPERATORS, example: 'CG_MTNMOBILEMONEY' })
  @IsIn(MONETBIL_OPERATORS)
  operator!: MonetbilOperator;
}
