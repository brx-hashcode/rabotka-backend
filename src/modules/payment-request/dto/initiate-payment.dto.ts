import { IsString, IsOptional } from 'class-validator';
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
    description: 'Monetbil operator code — required for MONETBIL gateway, omit for MTN_MOMO',
    example: 'CG_MTNMOBILEMONEY',
  })
  @IsOptional()
  @IsString()
  operator?: string;
}
