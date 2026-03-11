import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RejectPaymentDto {
  @ApiProperty({ description: 'Reason for rejecting the payment' })
  @IsString()
  @IsNotEmpty()
  note: string;
}
