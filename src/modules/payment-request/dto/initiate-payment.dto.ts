import {
  IsString,
  IsOptional,
  IsEnum,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const MONETBIL_OPERATORS = [
  'CG_MTNMOBILEMONEY',
  'CG_AIRTELMONEY',
] as const;

export type MonetbilOperator = (typeof MONETBIL_OPERATORS)[number];

export class InitiatePaymentDto {
  @ApiProperty({ example: '069917686' })
  @IsString()
  @MinLength(7)
  @MaxLength(15)
  @Matches(/^\+?\d+$/, { message: 'phone must contain only digits' })
  phone!: string;

  @ApiPropertyOptional({
    description:
      'Monetbil operator code — required for MONETBIL gateway, omit for MTN_MOMO',
    example: 'CG_MTNMOBILEMONEY',
    enum: MONETBIL_OPERATORS,
  })
  @IsOptional()
  @IsEnum(MONETBIL_OPERATORS)
  operator?: MonetbilOperator;
}
