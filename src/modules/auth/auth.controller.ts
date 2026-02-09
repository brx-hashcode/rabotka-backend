import {
  Controller,
  Post,
  Body,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { I18n, I18nContext } from 'nestjs-i18n';
import { AuthService } from './auth.service';
import { SendOtpDto, VerifyOtpDto } from './dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send OTP to email or phone',
    description:
      'Sends a 6-digit OTP to the provided email or phone number. Email sends via SMTP, phone logs OTP (mock).',
  })
  @ApiBody({ type: SendOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP sent successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        message: { type: 'string', example: 'OTP sent successfully' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid email or phone' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async sendOtp(
    @Body() sendOtpDto: SendOtpDto,
    @I18n() i18n: I18nContext,
  ): Promise<{ success: boolean; message: string }> {
    const result = await this.authService.sendOtp(sendOtpDto.emailOrPhone);
    return {
      success: result.success,
      message: i18n.t('auth.otp_sent'),
    };
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify OTP and authenticate',
    description:
      'Verifies the OTP and sets an httpOnly session cookie. Returns only { success: true } for security.',
  })
  @ApiBody({ type: VerifyOtpDto })
  @ApiResponse({
    status: 200,
    description: 'OTP verified, session cookie set',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid or expired OTP' })
  @ApiResponse({ status: 404, description: 'Profile not found' })
  async verifyOtp(
    @Body() verifyOtpDto: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    const result = await this.authService.verifyOtp(
      verifyOtpDto.emailOrPhone,
      verifyOtpDto.otp,
    );

    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');
    const maxAge = 24 * 60 * 60 * 1000;

    if (!cookieName) {
      throw new Error('AUTH_COOKIE_NAME is not set');
    }

    res.cookie(cookieName, result.token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      maxAge,
      path: '/',
    });

    return { success: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Logout user',
    description: 'Clears the authentication cookie to log out the user.',
  })
  @ApiResponse({
    status: 200,
    description: 'Logged out successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
      },
    },
  })
  async logout(
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ success: boolean }> {
    const cookieName = this.configService.get<string>('AUTH_COOKIE_NAME');

    if (!cookieName) {
      throw new Error('AUTH_COOKIE_NAME is not set');
    }

    res.clearCookie(cookieName, {
      path: '/',
    });

    return { success: true };
  }
}
