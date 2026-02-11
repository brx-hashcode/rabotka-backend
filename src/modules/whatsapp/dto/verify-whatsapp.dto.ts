import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyWhatsAppDto {
  @ApiProperty({
    description: 'Verification token for WhatsApp linking (query parameter)',
    example: 'abc123def456',
  })
  @IsString()
  @IsNotEmpty()
  token: string;
}
