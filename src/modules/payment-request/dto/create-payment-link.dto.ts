import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePaymentLinkDto {
  @ApiProperty({ description: 'Profile ID to send the payment link to' })
  @IsUUID()
  profileId: string;
}
