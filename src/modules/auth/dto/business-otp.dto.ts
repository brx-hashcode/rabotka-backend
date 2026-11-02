import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
} from 'class-validator';

/** The business space signs in by e-mail only: the holder's or a member's. */
export class BusinessSendOtpDto {
  @ApiProperty({ example: 'recrutement@entreprise.cg' })
  @IsEmail({}, { message: 'Adresse e-mail invalide' })
  email: string;
}

export class BusinessVerifyOtpDto extends BusinessSendOtpDto {
  @ApiProperty({ description: '6-digit code', example: '123456' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Le code fait 6 chiffres.' })
  @Matches(/^\d{6}$/, { message: 'Le code fait 6 chiffres.' })
  otp: string;
}
