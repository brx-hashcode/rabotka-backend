import { IsString, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class InitiatePaymentDto {
  @ApiProperty({ example: '237600000000' })
  @IsString()
  phone!: string;

  @ApiProperty({ enum: ['MTN', 'AIRTEL'] })
  @IsIn(['MTN', 'AIRTEL'])
  operator!: 'MTN' | 'AIRTEL';
}
