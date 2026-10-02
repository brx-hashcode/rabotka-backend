import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class AgentSendOtpDto {
  @ApiProperty({ example: 'agent@example.com' })
  @IsEmail({}, { message: 'Adresse email invalide' })
  email: string;
}

export class AgentVerifyOtpDto {
  @ApiProperty({ example: 'agent@example.com' })
  @IsEmail({}, { message: 'Adresse email invalide' })
  email: string;

  @ApiProperty({ description: '6-digit code sent by email', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Le code doit contenir 6 chiffres' })
  otp: string;
}

export class AgentRefreshDto {
  @ApiProperty({ description: 'Refresh token from verify-otp or refresh' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class AgentLogoutDto {
  @ApiPropertyOptional({ description: 'Refresh token to invalidate as well' })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
