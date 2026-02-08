import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendOtpDto {
  @ApiProperty({
    description: 'Email address or phone number to send OTP to',
    example: 'user@example.com or +242069917686',
  })
  @IsString()
  @IsNotEmpty()
  emailOrPhone: string;
}
