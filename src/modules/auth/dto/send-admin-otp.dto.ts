import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendAdminOtpDto {
  @ApiProperty({
    description: 'Email address to send OTP to',
    example: 'admin@example.com',
  })
  @IsString()
  @IsNotEmpty()
  @IsEmail({}, { message: 'Email must be a valid email address' })
  email: string;
}
