import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SignupSendOtpDto {
  @ApiProperty({
    description: 'Phone number being registered (receives the WhatsApp code)',
    example: '+242069917686',
  })
  @IsString()
  @IsNotEmpty()
  phone: string;
}

export class SignupVerifyOtpDto {
  @ApiProperty({ example: '+242069917686' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({
    description: '6-digit code received on WhatsApp',
    example: '123456',
  })
  @IsString()
  @Length(6, 6, { message: 'Le code doit contenir 6 chiffres' })
  @Matches(/^\d{6}$/, { message: 'Le code doit contenir 6 chiffres' })
  code: string;
}
