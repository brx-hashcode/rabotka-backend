import { IsString, IsIn, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const MONETBIL_OPERATORS = [
  'CG_MTNMOBILEMONEY',
  'CG_AIRTELMONEY',
] as const;

export type MonetbilOperator = (typeof MONETBIL_OPERATORS)[number];

export class InitiatePaymentDto {
  @ApiProperty({ example: '069917686' })
  @IsString()
  phone!: string;

  @ApiPropertyOptional({
    enum: MONETBIL_OPERATORS,
    example: 'CG_MTNMOBILEMONEY',
  })
  @IsOptional()
  @IsIn(MONETBIL_OPERATORS)
  operator?: MonetbilOperator;
}
